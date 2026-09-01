import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { ChildAgentRegistry, __setChildAgentExecutorDepsForTest } from "../../src/dispatch/in-process-executor.ts";
import { __resetLeafConcurrencyForTest, leafConcurrencyLimit } from "../../src/dispatch/leaf-concurrency.ts";
import { createSubagentExecutor } from "../../src/dispatch/subagent-executor.ts";
import { SUBAGENT_ASYNC_COMPLETE_EVENT } from "../../src/protocol/types.ts";
import { setCurrentPi } from "../../src/shared/current-pi.ts";
import { setRegistryPathForTests } from "../../src/state/runs-registry.ts";
import { makeAgent } from "../support/helpers.ts";

const roots: string[] = [];
let restoreRuntime: (() => void) | undefined;
let previousHome: string | undefined;

class FakeResourceLoader {
	async reload(): Promise<void> {}
}

function deferred<T = void>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

function waitForEvent(events: EventEmitter, channel: string, predicate: (payload: any) => boolean = () => true) {
	return new Promise<any>((resolve) => {
		const handler = (payload: any) => {
			if (!predicate(payload)) return;
			events.off(channel, handler);
			resolve(payload);
		};
		events.on(channel, handler);
	});
}

/**
 * Every fake child prompt records how many prompts are concurrently in-flight,
 * tracks the peak, then parks on a single shared gate. With the concurrency
 * gate working, only `concurrency` children can be mid-prompt at once; the rest
 * are blocked on a permit and never enter prompt until the gate releases.
 */
function setup(prefix: string, concurrency: number) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	roots.push(root);
	__resetLeafConcurrencyForTest();
	leafConcurrencyLimit(concurrency);
	previousHome = process.env.HOME;
	process.env.HOME = root;
	setRegistryPathForTests(path.join(root, ".pi", "agent", "pi-subagents", "runs-index.jsonl"));

	const tracker = { inFlight: 0, peak: 0 };
	const gate = deferred();
	const filledFirstWave = deferred();

	class FakeSession {
		async bindExtensions(): Promise<void> {}
		messages: unknown[] = [];
		subscribe(): () => void {
			return () => {};
		}
		async prompt(task: string): Promise<void> {
			tracker.inFlight++;
			tracker.peak = Math.max(tracker.peak, tracker.inFlight);
			if (tracker.inFlight === concurrency) filledFirstWave.resolve();
			try {
				await gate.promise;
			} finally {
				tracker.inFlight--;
			}
			this.lastAssistantText = `<output>${task}</output>`;
		}
		lastAssistantText = "";
		getLastAssistantText(): string {
			return this.lastAssistantText;
		}
		async abort(): Promise<void> {}
		dispose(): void {}
		setActiveToolsByName(): void {}
	}

	restoreRuntime = __setChildAgentExecutorDepsForTest({
		DefaultResourceLoader: FakeResourceLoader as never,
		getAgentDir: () => "/tmp/pi-agent",
		SessionManager: { open: (file: string) => ({ getSessionId: () => `session-${file}` }) as never },
		createAgentSession: async () =>
			({ session: new FakeSession() as never, extensionsResult: { extensions: [], diagnostics: [] } }) as never,
	});

	const events = new EventEmitter();
	const pi = {
		events: {
			emit: (channel: string, data: unknown) => events.emit(channel, data),
			on: (channel: string, handler: (data: unknown) => void) => {
				events.on(channel, handler);
				return () => events.off(channel, handler);
			},
		},
		getSessionName: () => undefined,
		setSessionName: () => {},
		getAllTools: () => [],
	};
	setCurrentPi(pi as never);

	const executor = createSubagentExecutor({
		pi,
		state: {
			baseCwd: root,
			currentSessionId: null,
			asyncJobs: new Map(),
			foregroundControls: new Map(),
			lastForegroundControlId: null,
			cleanupTimers: new Map(),
			lastUiContext: null,
			poller: null,
		},
		config: { maxConcurrentAgents: concurrency },
		asyncByDefault: false,
		tempArtifactsDir: root,
		childRegistry: new ChildAgentRegistry(),
		expandTilde: (value: string) => value,
		discoverAgents: () => ({
			agents: Array.from({ length: 16 }, (_, i) => makeAgent(`A${i}`, { model: "mock/test-model" })),
		}),
	} as never);

	const ctx = {
		cwd: root,
		hasUI: false,
		ui: {},
		sessionManager: { getSessionId: () => "async-conc-parent", getSessionFile: () => null },
		modelRegistry: { getAvailable: () => [{ provider: "mock", id: "test-model" }] },
		model: { provider: "mock" },
	};

	return { executor, ctx, events, tracker, release: () => gate.resolve(), filledFirstWave: filledFirstWave.promise };
}

afterEach(() => {
	restoreRuntime?.();
	restoreRuntime = undefined;
	__resetLeafConcurrencyForTest();
	setRegistryPathForTests(null);
	if (previousHome === undefined) delete process.env.HOME;
	else process.env.HOME = previousHome;
	previousHome = undefined;
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("async parallel concurrency gate", () => {
	it("never starts more than the resolved concurrency at once (8 tasks, limit 4)", async () => {
		const concurrency = 4;
		const total = 8;
		const harness = setup("async-parallel-conc-", concurrency);
		const completePromise = waitForEvent(harness.events, SUBAGENT_ASYNC_COMPLETE_EVENT);

		const run = Array.from({ length: total }, (_, i) => ({ agent: `A${i}`, task: `t${i}` }));
		const result = await harness.executor.execute(
			"id",
			{ run, async: true } as never,
			new AbortController().signal,
			undefined,
			harness.ctx as never,
		);
		// Async returns immediately with the parallel group handle.
		assert.equal((result?.details as any).mode, "parallel");

		// The first `concurrency` children fill prompt and park on the gate; the
		// remaining children are blocked on a permit and cannot enter prompt.
		await harness.filledFirstWave;
		assert.equal(
			harness.tracker.inFlight,
			concurrency,
			"exactly the concurrency limit may be mid-prompt while the gate is held",
		);

		// Release everyone; the remaining children now drain in further waves,
		// still permit-bounded.
		harness.release();
		const complete = await completePromise;

		assert.equal(complete.total, total);
		assert.equal(complete.completed, total, "every child must settle as complete");
		assert.ok(
			harness.tracker.peak <= concurrency,
			`peak concurrency ${harness.tracker.peak} must never exceed limit ${concurrency}`,
		);
	});
});
