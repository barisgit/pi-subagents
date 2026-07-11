import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { EventEmitter } from "node:events";
import * as path from "node:path";
import { createSubagentExecutor } from "../../src/dispatch/subagent-executor.ts";
import { __setInterruptWaitMsForTest } from "../../src/dispatch/interrupt-control.ts";
import {
	ChildAgentRegistry,
	type ChildAgentHandle,
	type ChildAgentResult,
} from "../../src/dispatch/in-process-executor.ts";
import { createAsyncJobTracker } from "../../src/surfaces/async-job-tracker.ts";
import registerSubagentNotify from "../../src/surfaces/notify.ts";
import { setCurrentPi } from "../../src/shared/current-pi.ts";
import { evictCompletionDedupeForRunId } from "../../src/state/completion-dedupe.ts";
import { setRegistryPathForTests } from "../../src/state/runs-registry.ts";
import {
	SUBAGENT_ASYNC_COMPLETE_EVENT,
	SUBAGENT_NOTIFY_DELIVERED_EVENT,
	type SubagentState,
} from "../../src/protocol/types.ts";
import { createTempDir, makeAgent, removeTempDir } from "../support/helpers.ts";

interface ExecutorResult {
	isError?: boolean;
	content: Array<{ text?: string }>;
}

class FakeSession {
	subscribe(): () => void {
		return () => {};
	}
	async prompt(): Promise<void> {}
	getLastAssistantText(): string {
		return "";
	}
	async abort(): Promise<void> {}
	dispose(): void {}
	setActiveToolsByName(): void {}
}

function makeState(cwd: string): SubagentState {
	return {
		baseCwd: cwd,
		currentSessionId: null,
		asyncJobs: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
	};
}

function interruptedResult(runId: string, sessionFile: string): ChildAgentResult {
	const now = Date.now();
	return {
		runId,
		stepIndex: 0,
		state: "interrupted",
		exitCode: 1,
		outputText: "",
		toolCallCount: 0,
		toolResultCount: 0,
		toolErrorCount: 0,
		durationMs: 1,
		startedAt: now,
		endedAt: now + 1,
		sessionFile,
	};
}

/** Registry handle whose child unwinds (resolves completed) when aborted. */
function registerAbortResolvedHandle(registry: ChildAgentRegistry, runId: string, sessionFile: string): void {
	let resolveCompleted: (result: ChildAgentResult) => void;
	const completed = new Promise<ChildAgentResult>((resolve) => {
		resolveCompleted = resolve;
	});
	const handle: ChildAgentHandle = {
		runId,
		stepIndex: 0,
		session: new FakeSession() as never,
		completed,
		abort: async () => {
			resolveCompleted(interruptedResult(runId, sessionFile));
		},
	};
	registry.register(handle);
}

/** Registry handle that never unwinds (completed never settles). */
function registerHungHandle(registry: ChildAgentRegistry, runId: string): void {
	const handle: ChildAgentHandle = {
		runId,
		stepIndex: 0,
		session: new FakeSession() as never,
		completed: new Promise<ChildAgentResult>(() => {}),
		abort: async () => {},
	};
	registry.register(handle);
}

function makeHarness(cwd: string) {
	const state = makeState(cwd);
	const childRegistry = new ChildAgentRegistry();
	const sent: Array<{ message: { customType?: string; content?: string }; options: unknown }> = [];
	const deliveredRunIds: string[] = [];
	const inner = new EventEmitter();
	const pi = {
		events: {
			on(channel: string, handler: (data: unknown) => void): () => void {
				inner.on(channel, handler);
				return () => inner.off(channel, handler);
			},
			emit(channel: string, data: unknown) {
				inner.emit(channel, data);
			},
		},
		on: () => {},
		getSessionName: () => undefined,
		setSessionName: () => {},
		getAllTools: () => [],
		sendMessage(message: { customType?: string; content?: string }, options: unknown) {
			sent.push({ message, options });
		},
	};
	inner.on(SUBAGENT_NOTIFY_DELIVERED_EVENT, (data) => {
		const info = data as { runIds?: string[] };
		for (const id of info.runIds ?? []) deliveredRunIds.push(id);
	});
	setCurrentPi(pi as never);
	const executor = createSubagentExecutor({
		pi,
		state,
		config: {},
		asyncByDefault: false,
		tempArtifactsDir: cwd,
		childRegistry,
		expandTilde: (value: string) => value,
		discoverAgents: () => ({ agents: [makeAgent("A", { model: "mock/test-model" })] }),
	} as never);
	const execute = (params: Record<string, unknown>): Promise<ExecutorResult> =>
		executor.execute("id", params as never, new AbortController().signal, undefined, {
			cwd,
			hasUI: false,
			ui: {},
			sessionManager: { getSessionId: () => "session-123", getSessionFile: () => null },
			modelRegistry: { getAvailable: () => [{ provider: "mock", id: "test-model" }] },
			model: { provider: "mock" },
		} as never) as Promise<ExecutorResult>;
	return { execute, state, childRegistry, pi, inner, sent, deliveredRunIds };
}

describe("synchronous interrupt wait", () => {
	let tempDir: string;
	const usedRunIds: string[] = [];

	beforeEach(() => {
		tempDir = createTempDir("pi-subagent-interrupt-wait-");
		setRegistryPathForTests(path.join(tempDir, "runs-index.jsonl"));
	});

	afterEach(() => {
		__setInterruptWaitMsForTest(null);
		setRegistryPathForTests(null);
		// The dedupe map is process-global; evict this test's keys so other tests
		// (and reruns in the same process) never inherit them.
		for (const runId of usedRunIds.splice(0)) evictCompletionDedupeForRunId(runId);
		removeTempDir(tempDir);
	});

	it("waits for the child to unwind and reports the final interrupted state", async () => {
		const runId = "run-wait-terminal";
		usedRunIds.push(runId);
		const harness = makeHarness(tempDir);
		registerAbortResolvedHandle(harness.childRegistry, runId, path.join(tempDir, "child.jsonl"));
		harness.state.asyncJobs.set(runId, {
			asyncId: runId,
			asyncDir: tempDir,
			status: "running",
			updatedAt: 1,
		});

		const result = await harness.execute({ action: "interrupt", id: runId });

		assert.equal(result.isError, undefined, result.content[0]?.text);
		assert.match(result.content[0]?.text ?? "", /Run run-wait-terminal interrupted\./);
		assert.doesNotMatch(result.content[0]?.text ?? "", /still unwinding/);
		const tracked = harness.state.asyncJobs.get(runId);
		assert.equal(tracked?.status, "interrupted", "tracked job must land on the final terminal state");
	});

	it("falls back to the requested-but-unwinding message when the deadline passes", async () => {
		const runId = "run-wait-timeout";
		usedRunIds.push(runId);
		__setInterruptWaitMsForTest(60);
		const harness = makeHarness(tempDir);
		registerHungHandle(harness.childRegistry, runId);
		harness.state.asyncJobs.set(runId, {
			asyncId: runId,
			asyncDir: tempDir,
			status: "running",
			updatedAt: 1,
		});

		const result = await harness.execute({ action: "interrupt", id: runId });

		assert.equal(result.isError, undefined, result.content[0]?.text);
		assert.match(result.content[0]?.text ?? "", /Interrupt requested for run run-wait-timeout\./);
		assert.match(result.content[0]?.text ?? "", /still unwinding/);

		// Degraded path: the dedupe mark must have been released, so the eventual
		// completion notification is still delivered.
		registerSubagentNotify(harness.pi as never);
		harness.inner.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
			id: runId,
			runId,
			agent: "A",
			success: false,
			summary: "stopped late",
			state: "interrupted",
			exitCode: 1,
			timestamp: Date.now(),
		});
		assert.equal(harness.sent.length, 1, "timeout path must not permanently swallow the completion notification");
	});

	it("suppresses the later completion notification after an in-time interrupt", async () => {
		const runId = "run-wait-suppress";
		usedRunIds.push(runId);
		const harness = makeHarness(tempDir);
		registerSubagentNotify(harness.pi as never);
		const tracker = createAsyncJobTracker(harness.pi as never, harness.state, { pollIntervalMs: 100000 });
		harness.pi.events.on(SUBAGENT_NOTIFY_DELIVERED_EVENT, tracker.handleDelivered);
		registerAbortResolvedHandle(harness.childRegistry, runId, path.join(tempDir, "child.jsonl"));
		harness.state.asyncJobs.set(runId, {
			asyncId: runId,
			asyncDir: tempDir,
			status: "running",
			updatedAt: 1,
		});

		const result = await harness.execute({ action: "interrupt", id: runId });
		assert.match(result.content[0]?.text ?? "", /Run run-wait-suppress interrupted\./);

		// The async completion event that arrives after the tool already reported
		// the outcome must NOT produce a second notification...
		harness.inner.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
			id: runId,
			runId,
			agent: "A",
			success: false,
			summary: "",
			state: "interrupted",
			exitCode: 1,
			timestamp: Date.now(),
		});
		assert.equal(harness.sent.length, 0, "deduped completion must not send a redundant notification");
		// ...but it must still flow through the delivered seam so the tracker
		// retires the row instead of holding pendingDelivery forever.
		assert.ok(harness.deliveredRunIds.includes(runId), "dedupe must still emit notify-delivered");
		tracker.handleComplete({ id: runId, success: false });
		const job = harness.state.asyncJobs.get(runId);
		assert.notEqual(job?.pendingDelivery, true, "tracker must not hold the run pendingDelivery");
		tracker.resetJobs();
	});
});
