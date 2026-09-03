import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { StatusWriter, __setStatusWriterWriteJsonForTest } from "../../src/state/status-writer.ts";
import type { ChildAgentResult } from "../../src/dispatch/in-process-executor.ts";
import type { AsyncJobState, SubagentState } from "../../src/protocol/types.ts";
import type { PersistedRunStatus } from "../../src/protocol/status-types.ts";

const cleanup: string[] = [];
const restoreFns: Array<() => void> = [];
let testsRun = 0;

afterEach(() => {
	testsRun++;
});

after(() => {
	process.stdout.write(`# tests ${testsRun}\n`);
});

afterEach(() => {
	while (restoreFns.length > 0) restoreFns.pop()?.();
});

after(() => {
	for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	cleanup.push(dir);
	return dir;
}

function readStatus(dir: string): Record<string, unknown> {
	return JSON.parse(fs.readFileSync(path.join(dir, "status.json"), "utf-8")) as Record<string, unknown>;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function countStatusWrites(): { get count(): number } {
	let count = 0;
	const restore = __setStatusWriterWriteJsonForTest((filePath, payload) => {
		count++;
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf-8");
	});
	restoreFns.push(restore);
	return {
		get count() {
			return count;
		},
	};
}

function result(overrides: Partial<ChildAgentResult> = {}): ChildAgentResult {
	return {
		runId: "run-1",
		stepIndex: 0,
		state: "complete",
		exitCode: 0,
		outputText: "final text",
		toolCallCount: 1,
		toolResultCount: 1,
		toolErrorCount: 0,
		durationMs: 15,
		startedAt: 100,
		endedAt: 115,
		sessionFile: "/tmp/session.jsonl",
		...overrides,
	};
}

function subagentState(): SubagentState {
	return {
		baseCwd: process.cwd(),
		currentSessionId: null,
		asyncJobs: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
	};
}

function stopSubagentStateTimers(state: SubagentState): void {
	if (state.poller) {
		clearInterval(state.poller);
		state.poller = null;
	}
	for (const timer of state.cleanupTimers.values()) clearTimeout(timer);
	state.cleanupTimers.clear();
}

describe("StatusWriter", () => {
	it("rehydrates activity with the persisted custom control threshold", async () => {
		const { statusToRunView } = await import("../../src/state/async-status.ts");
		const dir = tempDir("pi-status-control-config-");
		const writer = new StatusWriter({ runRecordDir: dir, runId: "run-custom-control" });
		const lastActivityAt = Date.now() - 200;
		writer.initialize({
			mode: "single",
			state: "running",
			startedAt: lastActivityAt,
			lastActivityAt,
			controlConfig: {
				enabled: true,
				needsAttentionAfterMs: 100,
				notifyOn: ["needs_attention"],
				notifyChannels: ["event"],
			},
			steps: [{ agent: "fixer", status: "running", lastActivityAt }],
		});

		const status = readStatus(dir) as unknown as PersistedRunStatus;
		assert.equal(status.controlConfig?.needsAttentionAfterMs, 100);
		assert.equal(statusToRunView(dir, status).activityState, "needs_attention");
	});

	it("coalesces three fast enqueue calls into one debounced disk write", async () => {
		const dir = tempDir("pi-status-writer-debounce-");
		const writes = countStatusWrites();
		const writer = new StatusWriter({ runRecordDir: dir, runId: "run-1", debounceMs: 30 });
		writer.initialize({ mode: "single", state: "queued", steps: [{ agent: "fixer", status: "queued" }] });
		const initialWrites = writes.count;

		writer.enqueue({ runId: "run-1", stepIndex: 0, state: "running" });
		writer.enqueue({ runId: "run-1", stepIndex: 0, liveText: "a" });
		writer.enqueue({ runId: "run-1", stepIndex: 0, liveText: "abc", toolCallDelta: 1 });
		assert.equal(writes.count, initialWrites);

		await delay(80);
		assert.equal(writes.count, initialWrites + 1);
		const status = readStatus(dir);
		assert.equal(status.state, "running");
		assert.equal(
			(status.steps as Array<{ live?: { outputText?: string; toolCallCount?: number } }>)[0]!.live?.outputText,
			"abc",
		);
		assert.equal(
			(status.steps as Array<{ live?: { outputText?: string; toolCallCount?: number } }>)[0]!.live?.toolCallCount,
			1,
		);
	});

	it("finalize flushes synchronously and clears a pending debounce timer", async () => {
		const dir = tempDir("pi-status-writer-finalize-");
		const writes = countStatusWrites();
		const writer = new StatusWriter({ runRecordDir: dir, runId: "run-1", debounceMs: 100 });
		writer.initialize({ mode: "single", state: "queued", steps: [{ agent: "fixer", status: "queued" }] });
		const initialWrites = writes.count;

		writer.enqueue({ runId: "run-1", stepIndex: 0, state: "running", liveText: "partial" });
		await writer.finalize(result({ model: "test/model-b", attemptedModels: ["test/model-a", "test/model-b"] }));
		assert.equal(writes.count, initialWrites + 1);

		await delay(140);
		assert.equal(writes.count, initialWrites + 1);
		const status = readStatus(dir);
		assert.equal(status.state, "complete");
		assert.equal(status.endedAt, 115);
		assert.equal(status.outputText, "final text");
		const step = (status.steps as Array<Record<string, unknown>>)[0]!;
		assert.equal(step.status, "complete");
		assert.equal(step.durationMs, 15);
		assert.equal(step.model, "test/model-b");
		assert.deepEqual(step.attemptedModels, ["test/model-a", "test/model-b"]);
	});

	it("records running state transitions and current tool activity", async () => {
		const dir = tempDir("pi-status-writer-state-");
		const writer = new StatusWriter({ runRecordDir: dir, runId: "run-1", debounceMs: 10 });
		writer.initialize({ mode: "parallel", state: "queued", steps: [{ agent: "fixer", status: "queued" }] });

		writer.enqueue({
			runId: "run-1",
			stepIndex: 0,
			state: "running",
			activity: { state: "tool_running", toolName: "read", updatedAt: 200 },
			toolCallDelta: 1,
		});
		await delay(30);
		const status = readStatus(dir);

		assert.equal(status.mode, "parallel");
		assert.equal(status.state, "running");
		assert.equal(status.currentTool, "read");
		assert.equal(status.currentToolStartedAt, 200);
		const step = (status.steps as Array<Record<string, unknown>>)[0]!;
		assert.equal(step.status, "running");
		assert.equal(step.currentTool, "read");
	});

	it("includes cache read/write tokens in persisted token totals", async () => {
		const dir = tempDir("pi-status-writer-token-total-");
		const writer = new StatusWriter({ runRecordDir: dir, runId: "run-1", debounceMs: 50 });
		writer.initialize({ mode: "single", state: "running", steps: [{ agent: "fixer", status: "running" }] });

		await writer.finalize(
			result({
				usage: { input: 74_000, output: 2_000, cacheRead: 180_000, cacheWrite: 4_000, cost: 0, turns: 1 },
			}),
		);
		const status = readStatus(dir);

		assert.deepEqual(status.totalTokens, {
			input: 74_000,
			output: 2_000,
			cacheRead: 180_000,
			cacheWrite: 4_000,
			total: 260_000,
		});
		const step = (status.steps as Array<Record<string, unknown>>)[0]!;
		assert.deepEqual(step.tokens, {
			input: 74_000,
			output: 2_000,
			cacheRead: 180_000,
			cacheWrite: 4_000,
			total: 260_000,
		});
	});

	it("persists live token usage on a running (pre-finalize) patch so nested readers see non-zero tokens", async () => {
		const { statusToRunView } = await import("../../src/state/async-status.ts");
		const dir = tempDir("pi-status-writer-live-tokens-");
		const writer = new StatusWriter({ runRecordDir: dir, runId: "run-1", debounceMs: 10 });
		writer.initialize({ mode: "single", state: "running", steps: [{ agent: "explorer", status: "running" }] });

		// A running child emits live token usage before it finalizes.
		writer.enqueue({
			runId: "run-1",
			stepIndex: 0,
			state: "running",
			tokens: { input: 740_000, output: 3_000, total: 743_000 },
		});
		await delay(30);

		const status = readStatus(dir);
		assert.equal(status.state, "running");
		const step = (status.steps as Array<Record<string, unknown>>)[0]!;
		assert.deepEqual(step.tokens, { input: 740_000, output: 3_000, total: 743_000 });
		// status.totalTokens stays absent on a live step; the reader derives the run
		// total by summing steps, so the nested-line token count is non-zero.
		assert.equal(status.totalTokens, undefined);
		const summary = statusToRunView(dir, status as unknown as PersistedRunStatus);
		const derived = summary.totalTokens?.total ?? summary.steps.reduce((s, st) => s + (st.tokens?.total ?? 0), 0);
		assert.equal(derived, 743_000);
	});

	it("writes interrupted as a terminal state", async () => {
		const dir = tempDir("pi-status-writer-interrupted-");
		const writer = new StatusWriter({ runRecordDir: dir, runId: "run-1", debounceMs: 50 });
		writer.initialize({ mode: "single", state: "running", steps: [{ agent: "fixer", status: "running" }] });

		await writer.finalize(
			result({
				state: "interrupted",
				exitCode: 1,
				outputText: "partial",
				error: { message: "Child agent interrupted: session-reload", reason: "session-reload" },
			}),
		);
		const status = readStatus(dir);

		assert.equal(status.state, "interrupted");
		assert.equal(status.outputText, "partial");
		assert.equal(status.error, "Child agent interrupted: session-reload");
		assert.equal((status.steps as Array<Record<string, unknown>>)[0]!.status, "interrupted");
	});

	it("computes terminal duration when a step starts at epoch zero", () => {
		const dir = tempDir("pi-status-writer-zero-start-");
		const writer = new StatusWriter({ runRecordDir: dir, runId: "run-1" });
		writer.initialize({ mode: "single", state: "running", steps: [{ agent: "fixer", status: "running" }] });

		writer.finalizeTerminal({ steps: [{ startedAt: 0 }] });

		const status = readStatus(dir) as { endedAt: number; steps: Array<{ durationMs?: number }> };
		assert.equal(status.steps[0]!.durationMs, status.endedAt);
	});

	it("finalize applies the shared terminal scalar convention (phase idle, phaseStartedAt cleared, version stamped, heartbeat at endedAt)", async () => {
		// Guards the shared finalizeRunScalars convention from the async-writer
		// side (the sync writeSyncRunStatusEnd side is guarded by
		// sync-run-persistence.test.ts). A run with a live phase + current tool
		// must finalize to phase:'idle' with phaseStartedAt/currentTool cleared,
		// version:1 stamped, and runnerHeartbeatAt frozen at endedAt — so a
		// long-finished run never advertises `streaming Xs` / `tool: read Xs`.
		const dir = tempDir("pi-status-writer-finalize-convention-");
		const writer = new StatusWriter({ runRecordDir: dir, runId: "run-1", debounceMs: 10 });
		writer.initialize({ mode: "single", state: "running", steps: [{ agent: "fixer", status: "running" }] });
		writer.enqueue({
			runId: "run-1",
			stepIndex: 0,
			state: "running",
			phase: "streaming_text",
			phaseStartedAt: 5000,
			activity: { state: "tool_running", toolName: "read", updatedAt: 5000 },
		});
		await delay(20);
		const live = readStatus(dir);
		assert.equal(live.phase, "streaming_text");
		assert.equal(live.currentTool, "read");

		await writer.finalize(result({ endedAt: 9000 }));
		const status = readStatus(dir);
		assert.equal(status.state, "complete");
		assert.equal(status.endedAt, 9000);
		assert.equal(status.phase, "idle");
		assert.equal(status.phaseStartedAt, undefined);
		assert.equal(status.currentTool, undefined);
		assert.equal(status.currentToolStartedAt, undefined);
		assert.equal(status.activityState, undefined);
		assert.equal(status.version, 1);
		assert.equal(status.runnerHeartbeatAt, 9000);
	});
});

describe("phase", () => {
	it("phase-persists", async () => {
		const dir = tempDir("pi-status-phase-persist-");
		const writer = new StatusWriter({ runRecordDir: dir, runId: "run-1", debounceMs: 20 });
		writer.initialize({ mode: "single", state: "queued", steps: [{ agent: "fixer", status: "queued" }] });

		const before = Date.now();
		writer.enqueue({ runId: "run-1", stepIndex: 0, state: "running", phase: "thinking", phaseStartedAt: 5000 });
		await delay(60);

		const status = readStatus(dir);
		assert.equal(status.phase, "thinking");
		assert.equal(status.phaseStartedAt, 5000);
		assert.equal(typeof status.runnerHeartbeatAt, "number");
		assert.ok((status.runnerHeartbeatAt as number) >= before);
		assert.ok((status.runnerHeartbeatAt as number) <= Date.now());
	});

	it("live-block-carries-phase", async () => {
		const { statusToRunView } = await import("../../src/state/async-status.ts");
		const dir = tempDir("pi-status-phase-live-");
		const writer = new StatusWriter({ runRecordDir: dir, runId: "run-1", debounceMs: 20 });
		writer.initialize({ mode: "single", state: "queued", steps: [{ agent: "fixer", status: "queued" }] });

		writer.enqueue({
			runId: "run-1",
			stepIndex: 0,
			state: "running",
			phase: "streaming_text",
			phaseStartedAt: 7000,
		});
		await delay(60);

		const status = readStatus(dir);
		const step = (status.steps as Array<Record<string, unknown>>)[0]!;
		const live = step.live as Record<string, unknown> | undefined;
		assert.equal(live?.phase, "streaming_text");
		assert.equal(live?.phaseStartedAt, 7000);

		const summary = statusToRunView(dir, status as unknown as PersistedRunStatus);
		assert.equal(summary.steps[0]?.phase, "streaming_text");
		assert.equal(summary.steps[0]?.phaseStartedAt, 7000);
	});

	it("preservation-across-partial", async () => {
		const dir = tempDir("pi-status-phase-preserve-");
		const writer = new StatusWriter({ runRecordDir: dir, runId: "run-1", debounceMs: 20 });
		writer.initialize({ mode: "single", state: "queued", steps: [{ agent: "fixer", status: "queued" }] });

		writer.enqueue({ runId: "run-1", stepIndex: 0, state: "running", phase: "thinking", phaseStartedAt: 9000 });
		await delay(60);
		const firstStatus = readStatus(dir);
		const firstHeartbeat = firstStatus.runnerHeartbeatAt as number;

		// Second patch with no phase field — must not erase the previously persisted phase
		writer.enqueue({ runId: "run-1", stepIndex: 0, liveText: "some text" });
		await delay(60);

		let status = readStatus(dir);
		assert.equal(status.phase, "thinking");
		assert.equal(status.phaseStartedAt, 9000);
		assert.equal(
			(status.steps as Array<{ live?: { phase?: string; phaseStartedAt?: number } }>)[0]!.live?.phase,
			"thinking",
		);
		assert.equal(
			(status.steps as Array<{ live?: { phase?: string; phaseStartedAt?: number } }>)[0]!.live?.phaseStartedAt,
			9000,
		);
		assert.ok((status.runnerHeartbeatAt as number) >= firstHeartbeat);

		// Third patch changes only phase; phaseStartedAt is independently preserved when omitted.
		writer.enqueue({ runId: "run-1", stepIndex: 0, phase: "streaming_text" });
		await delay(60);

		status = readStatus(dir);
		assert.equal(status.phase, "streaming_text");
		assert.equal(status.phaseStartedAt, 9000);
		assert.equal(
			(status.steps as Array<{ live?: { phase?: string; phaseStartedAt?: number } }>)[0]!.live?.phase,
			"streaming_text",
		);
		assert.equal(
			(status.steps as Array<{ live?: { phase?: string; phaseStartedAt?: number } }>)[0]!.live?.phaseStartedAt,
			9000,
		);
	});

	it("backward-compat-reader", async () => {
		const { statusToRunView } = await import("../../src/state/async-status.ts");
		const { createAsyncJobTracker } = await import("../../src/surfaces/async-job-tracker.ts");

		const legacyDir = tempDir("pi-status-phase-legacy-");
		const legacyStatus: PersistedRunStatus = {
			runId: "legacy-run",
			mode: "single",
			state: "running",
			startedAt: Date.now(),
			steps: [{ agent: "fixer", status: "running" }],
		};
		const legacySummary = statusToRunView(legacyDir, legacyStatus);
		assert.equal(legacySummary.phase, undefined);
		assert.equal(legacySummary.phaseStartedAt, undefined);
		assert.equal(legacySummary.steps[0]?.phase, undefined);
		assert.equal(legacySummary.steps[0]?.phaseStartedAt, undefined);

		const dir = tempDir("pi-status-phase-compat-");
		const writer = new StatusWriter({ runRecordDir: dir, runId: "run-async-1", debounceMs: 20 });
		writer.initialize({ mode: "single", state: "running", steps: [{ agent: "fixer", status: "running" }] });
		writer.enqueue({
			runId: "run-async-1",
			stepIndex: 0,
			phase: "tool_running",
			phaseStartedAt: 3000,
			runnerHeartbeatAt: Date.now(),
		});
		await delay(60);

		const rawStatus = JSON.parse(
			(await import("node:fs")).readFileSync((await import("node:path")).join(dir, "status.json"), "utf-8"),
		) as import("../../src/protocol/status-types.ts").PersistedRunStatus;

		const summary = statusToRunView(dir, rawStatus);
		assert.equal(summary.phase, "tool_running");
		assert.equal(summary.phaseStartedAt, 3000);

		const state = subagentState();
		const job: AsyncJobState = {
			asyncId: "run-async-1",
			asyncDir: dir,
			status: "running",
			mode: "single",
			startedAt: Date.now(),
			updatedAt: Date.now(),
		};
		state.asyncJobs.set("run-async-1", job);
		const tracker = createAsyncJobTracker({ events: { on: () => () => {}, emit: () => {} } }, state, {
			pollIntervalMs: 10,
		});
		try {
			tracker.ensurePoller();
			await delay(40);
		} finally {
			stopSubagentStateTimers(state);
		}
		const mirrored = state.asyncJobs.get("run-async-1")!;
		assert.equal(mirrored.phase, "tool_running");
		assert.equal(mirrored.phaseStartedAt, 3000);
	});

	it("explicit-clear", async () => {
		const dir = tempDir("pi-status-phase-explicit-");
		const writer = new StatusWriter({ runRecordDir: dir, runId: "run-1", debounceMs: 20 });
		writer.initialize({ mode: "single", state: "queued", steps: [{ agent: "fixer", status: "queued" }] });

		writer.enqueue({ runId: "run-1", stepIndex: 0, state: "running", phase: "thinking", phaseStartedAt: 1000 });
		await delay(60);
		writer.enqueue({ runId: "run-1", stepIndex: 0, phase: "idle", phaseStartedAt: 2000 });
		await delay(60);

		const status = readStatus(dir);
		assert.equal(status.phase, "idle");
		assert.equal(status.phaseStartedAt, 2000);
		assert.equal(
			(status.steps as Array<{ live?: { phase?: string; phaseStartedAt?: number } }>)[0]!.live?.phase,
			"idle",
		);
		assert.equal(
			(status.steps as Array<{ live?: { phase?: string; phaseStartedAt?: number } }>)[0]!.live?.phaseStartedAt,
			2000,
		);
	});
});
