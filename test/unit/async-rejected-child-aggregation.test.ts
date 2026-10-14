import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { ChildAgentRegistry, __setChildAgentExecutorDepsForTest } from "../../src/dispatch/in-process-executor.ts";
import type { ChildAgentResult } from "../../src/dispatch/in-process-executor.ts";
import type { RunViewSeed } from "../../src/dispatch/child-agent-registry.ts";
import { __resetLeafConcurrencyForTest } from "../../src/dispatch/leaf-concurrency.ts";
import {
	markNestedAsyncFinished,
	markNestedAsyncStarted,
	nestedAsyncParentSnapshot,
	registerNestedAsyncParent,
	releaseNestedAsyncParent,
	__nestedAsyncCancellationCountForTest,
} from "../../src/dispatch/nested-async-coordinator.ts";
import { hasRunController } from "../../src/dispatch/layer0-runs.ts";
import { createSubagentExecutor } from "../../src/dispatch/subagent-executor.ts";
import { SUBAGENT_ASYNC_COMPLETE_EVENT, SUBAGENT_ASYNC_STARTED_EVENT } from "../../src/protocol/types.ts";
import { setCurrentPi } from "../../src/shared/current-pi.ts";
import { logger } from "../../src/shared/logger.ts";
import { __setStatusWriterWriteJsonForTest } from "../../src/state/status-writer.ts";
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

async function waitForAtMost(check: () => boolean, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() >= deadline) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

/** A registry whose finalizeView throws for children whose output matches `poison`,
 * forcing that child's completed promise to REJECT (not resolve failed) — the
 * post-execution seam where real rejections escape executeChildAgent's catch.
 * `seedExplosion` additionally makes the SYNCHRONOUS dispatch seam throw:
 * startChildAgent seeds the registry view before its async chain starts, so a
 * throwing seedRunView models a sync escape from runAsyncPath's dispatch. */
class RejectingRegistry extends ChildAgentRegistry {
	private readonly poison: string;
	private readonly afterFinalize: (() => void) | undefined;
	private readonly seedExplosion: string | undefined;
	constructor(poison: string, afterFinalize?: () => void, seedExplosion?: string) {
		super();
		this.poison = poison;
		this.afterFinalize = afterFinalize;
		this.seedExplosion = seedExplosion;
	}
	override seedRunView(runId: string, seed: RunViewSeed): void {
		if (this.seedExplosion) throw new Error(this.seedExplosion);
		super.seedRunView(runId, seed);
	}
	override finalizeView(runId: string, result: ChildAgentResult): void {
		if (result.outputText.includes(this.poison)) throw new Error("registry mirror exploded");
		super.finalizeView(runId, result);
		this.afterFinalize?.();
	}
}

function setup(prefix: string, poison: string, afterFinalize?: () => void, seedExplosion?: string) {
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
		childRegistry: new RejectingRegistry(poison, afterFinalize, seedExplosion),
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

for (const count of [1, 2]) {
	it(`async ${count}-child completion preserves success after parent replacement`, async () => {
		let stale = false;
		const harness = setup("async-replaced-parent-", "never matches", () => {
			stale = true;
		});
		const manager = harness.ctx.sessionManager;
		Object.defineProperty(harness.ctx, "sessionManager", {
			get() {
				if (stale) throw new Error("This extension ctx is stale after session replacement or reload.");
				return manager;
			},
		});
		const completePromise = waitForEvent(harness.events, SUBAGENT_ASYNC_COMPLETE_EVENT);
		await harness.executor.execute(
			"id",
			{ run: Array.from({ length: count }, (_, index) => ({ agent: `A${index}`, task: "done" })), async: true },
			new AbortController().signal,
			undefined,
			harness.ctx as never,
		);
		const complete = await Promise.race([
			completePromise,
			new Promise((_, reject) => {
				setTimeout(() => reject(new Error("No completion event after parent replacement")), 1000);
			}),
		]);
		assert.equal(complete.success, true);
		assert.equal(complete.completed, count);
	});
}

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

describe("finalizeAsync unwind guarantee", () => {
	it("releases the nested hold even when aggregation throws mid-finalize", { timeout: 8_000 }, async (t) => {
		const harness = setup("async-finalize-throw-", "unused-poison");
		const parentRunId = "run-aggregation-throw-parent";
		const savedEnv = process.env.PI_SUBAGENT_PARENT_RUN_ID;
		process.env.PI_SUBAGENT_PARENT_RUN_ID = parentRunId;
		registerNestedAsyncParent(parentRunId);
		const completions: Array<Record<string, unknown>> = [];
		// Production extension-runtime listener shape: the dispatching parent's bus
		// maps async lifecycle events to nested-async marks. The aggregate COMPLETE
		// is the only trigger that clears the dispatch/group id (single async
		// dispatches have no layer0 RUN_COMPLETE for it).
		harness.events.on(SUBAGENT_ASYNC_STARTED_EVENT, (data: { runId?: string }) => {
			if (data.runId) markNestedAsyncStarted(parentRunId, data.runId);
		});
		harness.events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, (data: { runId?: string }) => {
			completions.push(data);
			if (data.runId) markNestedAsyncFinished(parentRunId, data.runId);
		});
		let reportedError: Error | undefined;
		t.mock.method(logger, "error", (_message: string, error?: Error) => {
			reportedError = error;
		});
		const originalInfo = logger.info.bind(logger);
		t.mock.method(logger, "info", (message: string, context?: Parameters<typeof logger.info>[1]) => {
			// Simulate a throw from an arbitrary line inside the finalizeAsync try:
			// the post-allSettled progress log is mid-aggregation, before finalizeRun.
			if (message === "finalizeAsync: settled") throw new Error("simulated aggregation failure");
			originalInfo(message, context);
		});
		try {
			await harness.executor.execute(
				"id",
				{ run: [{ agent: "A0", task: "t0" }], async: true } as never,
				new AbortController().signal,
				undefined,
				harness.ctx as never,
			);
			await waitForAtMost(() => completions.length > 0, 3_000);
			assert.equal(
				completions.length,
				1,
				"the aggregate completion must emit exactly once even when aggregation throws",
			);
			assert.match(String(reportedError?.message ?? ""), /simulated aggregation failure/);
			const snapshot = nestedAsyncParentSnapshot(parentRunId);
			assert.ok(snapshot, "the parent state is released by its own executor, not the dispatcher");
			assert.equal(snapshot.active, false, "the hold must release even when aggregation throws");
		} finally {
			if (savedEnv === undefined) delete process.env.PI_SUBAGENT_PARENT_RUN_ID;
			else process.env.PI_SUBAGENT_PARENT_RUN_ID = savedEnv;
			releaseNestedAsyncParent(parentRunId);
		}
	});

	it(
		"releases the hold when the single finalizeAsync prologue throws before its unwind registers",
		{ timeout: 8_000 },
		async (t) => {
			// The unwind registers when the try block is ENTERED. Any executable
			// statement before it (the awaiting-handles progress log) would float a
			// rejection past the catch/finally: no aggregate, immortal hold.
			const harness = setup("async-prologue-throw-", "unused-poison");
			const parentRunId = "run-prologue-throw-parent";
			const savedEnv = process.env.PI_SUBAGENT_PARENT_RUN_ID;
			process.env.PI_SUBAGENT_PARENT_RUN_ID = parentRunId;
			registerNestedAsyncParent(parentRunId);
			const completions: Array<Record<string, unknown>> = [];
			harness.events.on(SUBAGENT_ASYNC_STARTED_EVENT, (data: { runId?: string }) => {
				if (data.runId) markNestedAsyncStarted(parentRunId, data.runId);
			});
			harness.events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, (data: { runId?: string }) => {
				completions.push(data);
				if (data.runId) markNestedAsyncFinished(parentRunId, data.runId);
			});
			let reportedError: Error | undefined;
			t.mock.method(logger, "error", (_message: string, error?: Error) => {
				reportedError = error;
			});
			const originalInfo = logger.info.bind(logger);
			t.mock.method(logger, "info", (message: string, context?: Parameters<typeof logger.info>[1]) => {
				if (message === "finalizeAsync: awaiting handles") throw new Error("simulated prologue failure");
				originalInfo(message, context);
			});
			try {
				await harness.executor.execute(
					"id",
					{ run: [{ agent: "A0", task: "t0" }], async: true } as never,
					new AbortController().signal,
					undefined,
					harness.ctx as never,
				);
				await waitForAtMost(() => completions.length > 0, 3_000);
				assert.equal(completions.length, 1, "the clearing aggregate must emit even when the prologue throws");
				assert.match(String(reportedError?.message ?? ""), /simulated prologue failure/);
				const snapshot = nestedAsyncParentSnapshot(parentRunId);
				assert.ok(snapshot, "the parent state is released by its own executor, not the dispatcher");
				assert.equal(snapshot.active, false, "the hold must release even when the prologue throws");
			} finally {
				if (savedEnv === undefined) delete process.env.PI_SUBAGENT_PARENT_RUN_ID;
				else process.env.PI_SUBAGENT_PARENT_RUN_ID = savedEnv;
				releaseNestedAsyncParent(parentRunId);
			}
		},
	);

	it(
		"releases the hold when the parallel finalize prologue throws before its unwind registers",
		{ timeout: 8_000 },
		async (t) => {
			// Parallel twin: the group aggregate IIFE must enter its try before any
			// executable statement, or a prologue throw skips the finally that clears
			// the group mark registered by holdNestedAsyncRollup.
			const harness = setup("async-parallel-prologue-", "unused-poison");
			const parentRunId = "run-parallel-prologue-parent";
			const savedEnv = process.env.PI_SUBAGENT_PARENT_RUN_ID;
			process.env.PI_SUBAGENT_PARENT_RUN_ID = parentRunId;
			registerNestedAsyncParent(parentRunId);
			const completions: Array<Record<string, unknown>> = [];
			// Only the group aggregate clears the hold; per-child STARTED marks are
			// owned by the group state and die with releaseNestedAsyncParent.
			harness.events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, (data: { runId?: string }) => {
				completions.push(data);
				if (data.runId) markNestedAsyncFinished(parentRunId, data.runId);
			});
			let reportedError: Error | undefined;
			t.mock.method(logger, "error", (_message: string, error?: Error) => {
				reportedError = error;
			});
			const originalInfo = logger.info.bind(logger);
			t.mock.method(logger, "info", (message: string, context?: Parameters<typeof logger.info>[1]) => {
				if (message === "finalizeAsync: awaiting layer0 parallel handles")
					throw new Error("simulated parallel prologue failure");
				originalInfo(message, context);
			});
			try {
				await harness.executor.execute(
					"id",
					{
						run: [
							{ agent: "A0", task: "t0" },
							{ agent: "A1", task: "t1" },
						],
						async: true,
					} as never,
					new AbortController().signal,
					undefined,
					harness.ctx as never,
				);
				await waitForAtMost(() => completions.length > 0, 3_000);
				assert.equal(completions.length, 1, "the group aggregate must emit even when the prologue throws");
				assert.equal(completions[0].success, false, "the prologue-throw unwind emits the failed aggregate");
				assert.match(String(reportedError?.message ?? ""), /simulated parallel prologue failure/);
				const snapshot = nestedAsyncParentSnapshot(parentRunId);
				assert.ok(snapshot, "the parent state is released by its own executor, not the dispatcher");
				assert.equal(snapshot.active, false, "the group hold must release even when the prologue throws");
			} finally {
				if (savedEnv === undefined) delete process.env.PI_SUBAGENT_PARENT_RUN_ID;
				else process.env.PI_SUBAGENT_PARENT_RUN_ID = savedEnv;
				releaseNestedAsyncParent(parentRunId);
			}
		},
	);
});

describe("sync-dispatch unwind guarantee", () => {
	it("unwinds dispatch registrations when the dispatch throws synchronously", { timeout: 8_000 }, async (t) => {
		// The single-dispatch path registers a run controller and a nested
		// cancellation between opening the run record and dispatching the child. A
		// synchronous throw from the dispatch (here: the registry view seed, the
		// same mirror-corruption seam the rejected-child tests use) used to escape
		// runAsyncPath before finalizeAsync could register its unwind, leaking both
		// registrations and never emitting the run's terminal aggregate.
		const harness = setup("async-sync-throw-", "unused-poison", undefined, "registry mirror exploded");
		const parentRunId = "run-sync-throw-parent";
		const savedEnv = process.env.PI_SUBAGENT_PARENT_RUN_ID;
		process.env.PI_SUBAGENT_PARENT_RUN_ID = parentRunId;
		registerNestedAsyncParent(parentRunId);
		const completions: Array<Record<string, unknown>> = [];
		harness.events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, (data: { runId?: string }) => {
			completions.push(data);
			if (data.runId) markNestedAsyncFinished(parentRunId, data.runId);
		});
		let reportedError: Error | undefined;
		t.mock.method(logger, "error", (_message: string, error?: Error) => {
			reportedError = error;
		});
		try {
			const result = await harness.executor.execute(
				"id",
				{ run: [{ agent: "A0", task: "t0" }], async: true } as never,
				new AbortController().signal,
				undefined,
				harness.ctx as never,
			);
			assert.equal(result.isError, true, "the sync dispatch failure must surface as an error result");
			assert.match(JSON.stringify(result.content), /registry mirror exploded/);
			assert.equal(
				completions.length,
				1,
				"the failed aggregate must emit exactly once on the sync-escape unwind",
			);
			// Pin the payload SHAPE, not just the count: emitting a built success
			// payload instead of the failed one must also fail here.
			const aggregate = completions[0];
			assert.equal(aggregate.success, false, "the sync-escape unwind emits the failed aggregate");
			assert.equal(aggregate.total, 0, "no child completed, so the failed aggregate totals 0");
			assert.equal((aggregate.children as unknown[]).length, 0, "the failed aggregate carries no children");
			const snapshot = nestedAsyncParentSnapshot(parentRunId);
			assert.ok(snapshot, "the parent state is released by its own executor, not the dispatcher");
			assert.equal(snapshot.active, false, "no hold-facing mark may survive the unwind");
			assert.equal(
				hasRunController(String(aggregate.runId)),
				false,
				"the detached controller must be released or a reload orphans the run",
			);
			assert.equal(
				__nestedAsyncCancellationCountForTest(parentRunId),
				0,
				"the nested cancellation must be unregistered, not left to fire on a later parent release",
			);
			assert.ok(!reportedError, "the sync escape is surfaced to the caller, not swallowed as a log");
		} finally {
			if (savedEnv === undefined) delete process.env.PI_SUBAGENT_PARENT_RUN_ID;
			else process.env.PI_SUBAGENT_PARENT_RUN_ID = savedEnv;
			releaseNestedAsyncParent(parentRunId);
		}
	});
});

describe("detached terminal persistence failure", () => {
	it("emits successful completion despite a final telemetry write failure", { timeout: 3000 }, async (t) => {
		const failure = Object.assign(new Error("ENOSPC: detached final status write"), { code: "ENOSPC" });
		let restoreWriter: (() => void) | undefined;
		const harness = setup("async-finalize-enospc-", "unused-poison", () => {
			restoreWriter = __setStatusWriterWriteJsonForTest(() => {
				throw failure;
			});
		});
		let completions = 0;
		let reportedError: Error | undefined;
		let reportedRunId: unknown;
		const outcome = new Promise<"complete" | "error">((resolve) => {
			harness.events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, () => {
				completions++;
				resolve("complete");
			});
			t.mock.method(logger, "error", (_message: string, error?: Error, context?: { runId?: string }) => {
				reportedError = error;
				reportedRunId = context?.runId;
				resolve("error");
			});
		});
		try {
			await harness.executor.execute(
				"id",
				{ run: [{ agent: "A0", task: "persist me" }], async: true } as never,
				new AbortController().signal,
				undefined,
				harness.ctx as never,
			);
			assert.equal(await outcome, "complete");
			assert.equal(reportedError, undefined);
			assert.equal(reportedRunId, undefined);
			assert.equal(completions, 1, "telemetry failure must not suppress completion");
		} finally {
			restoreWriter?.();
		}
	});
});
