import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { ChildAgentRegistry, __setChildAgentExecutorDepsForTest } from "../../src/dispatch/in-process-executor.ts";
import type { ChildAgentResult } from "../../src/dispatch/in-process-executor.ts";
import { __resetLeafConcurrencyForTest } from "../../src/dispatch/leaf-concurrency.ts";
import { createSubagentExecutor } from "../../src/dispatch/subagent-executor.ts";
import { SUBAGENT_ASYNC_COMPLETE_EVENT } from "../../src/protocol/types.ts";
import { setCurrentPi } from "../../src/shared/current-pi.ts";
import { readStatus } from "../../src/shared/utils.ts";
import { readAllEntries, setRegistryPathForTests } from "../../src/state/runs-registry.ts";
import { makeAgent } from "../support/helpers.ts";

const roots: string[] = [];
let restoreRuntime: (() => void) | undefined;
let previousHome: string | undefined;

class FakeResourceLoader {
	async reload(): Promise<void> {}
}

function waitForEvent(events: EventEmitter, channel: string) {
	return new Promise<any>((resolve) => {
		events.once(channel, resolve);
	});
}

/** A registry whose finalizeView throws for children whose output matches `poison`,
 * forcing that child's completed promise to REJECT (not resolve failed) — the
 * post-execution seam where real rejections escape executeChildAgent's catch. */
class RejectingRegistry extends ChildAgentRegistry {
	private readonly poison: string;
	constructor(poison: string) {
		super();
		this.poison = poison;
	}
	override finalizeView(runId: string, result: ChildAgentResult): void {
		if (result.outputText.includes(this.poison)) throw new Error("registry mirror exploded");
		super.finalizeView(runId, result);
	}
}

function setup(prefix: string, poison: string) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	roots.push(root);
	__resetLeafConcurrencyForTest();
	previousHome = process.env.HOME;
	process.env.HOME = root;
	setRegistryPathForTests(path.join(root, ".pi", "agent", "pi-subagents", "runs-index.jsonl"));

	class FakeSession {
		async bindExtensions(): Promise<void> {}
		messages: unknown[] = [];
		lastAssistantText = "";
		subscribe(): () => void {
			return () => {};
		}
		async prompt(task: string): Promise<void> {
			this.lastAssistantText = `<output>${task}</output>`;
		}
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
		config: { maxConcurrentAgents: 4 },
		asyncByDefault: false,
		tempArtifactsDir: root,
		childRegistry: new RejectingRegistry(poison),
		expandTilde: (value: string) => value,
		discoverAgents: () => ({
			agents: Array.from({ length: 4 }, (_, i) => makeAgent(`A${i}`, { model: "mock/test-model" })),
		}),
	} as never);

	const ctx = {
		cwd: root,
		hasUI: false,
		ui: {},
		sessionManager: { getSessionId: () => "async-reject-parent", getSessionFile: () => null },
		modelRegistry: { getAvailable: () => [{ provider: "mock", id: "test-model" }] },
		model: { provider: "mock" },
	};

	return { executor, ctx, events };
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

describe("async aggregation with a rejected child", () => {
	it("parallel: counts the rejected child as failed instead of dropping it", async () => {
		const harness = setup("async-parallel-reject-", "t1");
		const completePromise = waitForEvent(harness.events, SUBAGENT_ASYNC_COMPLETE_EVENT);

		const run = [
			{ agent: "A0", task: "t0" },
			{ agent: "A1", task: "t1" },
		];
		await harness.executor.execute(
			"id",
			{ run, async: true } as never,
			new AbortController().signal,
			undefined,
			harness.ctx as never,
		);
		const complete = await completePromise;

		assert.equal(complete.total, 2, "total must equal dispatched tasks, not surviving children");
		assert.equal(complete.completed, 1);
		assert.equal(complete.success, false, "a lost child must fail the aggregate");
		const states = complete.children.map((child: { state: string }) => child.state).sort();
		assert.deepEqual(states, ["complete", "failed"]);
		const failedChild = complete.children.find((child: { state: string }) => child.state === "failed");
		assert.match(String(failedChild.summary ?? failedChild.output), /registry mirror exploded/);

		// The rejected child's own status.json must also be terminal (failed).
		const failedEntry = readAllEntries().find((entry) => entry.runId === failedChild.runId);
		assert.ok(failedEntry, "rejected child must stay discoverable in the registry");
		const status = readStatus(failedEntry.runRecordDir);
		assert.ok(status);
		assert.equal(status.state, "failed");
		assert.equal(typeof status.endedAt, "number");
	});

	it("single: a rejected child reports total 1 with a failed child entry", async () => {
		const harness = setup("async-single-reject-", "solo");
		const completePromise = waitForEvent(harness.events, SUBAGENT_ASYNC_COMPLETE_EVENT);

		await harness.executor.execute(
			"id",
			{ run: [{ agent: "A0", task: "solo" }], async: true } as never,
			new AbortController().signal,
			undefined,
			harness.ctx as never,
		);
		const complete = await completePromise;

		assert.equal(complete.total, 1, "total must count the dispatched task");
		assert.equal(complete.completed, 0);
		assert.equal(complete.success, false);
		assert.equal(complete.children.length, 1);
		assert.equal(complete.children[0].state, "failed");
	});
});
