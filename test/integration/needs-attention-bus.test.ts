/**
 * Integration tests for f8-needs-attention-event-channel.
 *
 * Uses t.mock.timers to drive foreground status ticks and the async-job-tracker
 * poll loop deterministically without real sleeps.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { after, afterEach, describe, it } from "node:test";
import { createAsyncJobTracker } from "../../async-job-tracker.ts";
import {
	createActivityTicker,
	DEFAULT_CONTROL_CONFIG,
} from "../../subagent-control.ts";
import {
	SUBAGENT_CONTROL_EVENT,
	SUBAGENT_NEEDS_ATTENTION_EVENT,
	type AsyncStatus,
	type ControlEvent,
	type ResolvedControlConfig,
	type SubagentNeedsAttentionPayload,
	type SubagentState,
} from "../../types.ts";

let testsRun = 0;
afterEach(() => { testsRun++; });
after(() => { process.stdout.write(`# tests ${testsRun}\n`); });

function makeEventsBus() {
	const calls: Array<{ event: string; payload: unknown }> = [];
	return {
		emit(event: string, payload: unknown) { calls.push({ event, payload }); },
		calls,
		countOf(event: string) { return calls.filter((call) => call.event === event).length; },
		payloadsFor(event: string) { return calls.filter((call) => call.event === event).map((call) => call.payload); },
	};
}

type RecorderBus = ReturnType<typeof makeEventsBus>;

function emitForegroundNeedsAttention(bus: RecorderBus, event: ControlEvent): void {
	bus.emit(SUBAGENT_CONTROL_EVENT, {
		event,
		source: "foreground" as const,
		noticeText: event.message,
	});
	bus.emit(SUBAGENT_NEEDS_ATTENTION_EVENT, {
		runId: event.runId,
		agent: event.agent,
		ts: event.ts,
		message: event.message,
		...(event.index !== undefined ? { index: event.index } : {}),
	} satisfies SubagentNeedsAttentionPayload);
}

function writeStatus(asyncDir: string, status: AsyncStatus, mtimeMs: number): void {
	mkdirSync(asyncDir, { recursive: true });
	const statusPath = join(asyncDir, "status.json");
	writeFileSync(statusPath, JSON.stringify(status), "utf8");
	const mtime = new Date(mtimeMs);
	utimesSync(statusPath, mtime, mtime);
}

function makeState(asyncDir: string, config: ResolvedControlConfig): SubagentState {
	return {
		baseCwd: process.cwd(),
		currentSessionId: null,
		asyncJobs: new Map([["async-r1", {
			asyncId: "async-r1",
			asyncDir,
			status: "running",
			displayState: "quiet",
			mode: "single",
			agents: ["worker"],
			currentStep: 0,
			stepsTotal: 1,
			startedAt: 0,
			updatedAt: 0,
			lastActivityAt: 0,
			controlConfig: config,
		}]]),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
	};
}

function cleanupPoller(state: SubagentState): void {
	if (state.poller) {
		clearInterval(state.poller);
		state.poller = null;
	}
	for (const timer of state.cleanupTimers.values()) clearTimeout(timer);
	state.cleanupTimers.clear();
}

describe("needs-attention reaches parent", () => {
	it("foreground-transition-fires-control-event: foreground status tick emits one control event on needs_attention edge", (t) => {
		t.mock.timers.enable({ apis: ["Date"] });

		const bus = makeEventsBus();
		const config = { ...DEFAULT_CONTROL_CONFIG, needsAttentionAfterMs: 10_000 };
		let lastActivityAt: number | undefined = 0;
		const ticker = createActivityTicker({
			runId: "fg-r1",
			agent: "worker",
			index: 0,
			config,
			getStartedAt: () => 0,
			getLastActivityAt: () => lastActivityAt,
			onNeedsAttention: (event) => emitForegroundNeedsAttention(bus, event),
		});

		assert.equal(ticker.tick(), undefined);
		t.mock.timers.tick(10_000);
		assert.equal(ticker.tick(), undefined, "exact threshold is not enough");
		t.mock.timers.tick(1);
		assert.equal(ticker.tick(), "needs_attention");

		assert.equal(bus.countOf(SUBAGENT_CONTROL_EVENT), 1);
		assert.equal(bus.countOf(SUBAGENT_NEEDS_ATTENTION_EVENT), 1);
		const payload = bus.payloadsFor(SUBAGENT_CONTROL_EVENT)[0] as { event: ControlEvent; source: string };
		assert.equal(payload.source, "foreground");
		assert.equal(payload.event.runId, "fg-r1");
		assert.equal(payload.event.agent, "worker");
		assert.equal(payload.event.index, 0);
		assert.equal(payload.event.type, "needs_attention");
		assert.match(payload.event.message, /worker needs attention/);

		lastActivityAt = Date.now();
		ticker.stop();
	});

	it("async-transition-fires-control-event: async poll loop emits one control event on needs_attention edge", (t) => {
		t.mock.timers.enable({ apis: ["Date", "setInterval"] });

		const tmp = mkdtempSync(join(tmpdir(), "needs-attention-"));
		const bus = makeEventsBus();
		const config = { ...DEFAULT_CONTROL_CONFIG, needsAttentionAfterMs: 10_000 };
		const state = makeState(tmp, config);
		try {
			writeStatus(tmp, {
				runId: "async-r1",
				mode: "single",
				state: "running",
				startedAt: 0,
				lastUpdate: 0,
				lastActivityAt: 0,
				currentStep: 0,
				steps: [{ agent: "worker", status: "running", startedAt: 0, lastActivityAt: 0 }],
			}, 0);
			const tracker = createAsyncJobTracker({ events: bus } as never, state, { pollIntervalMs: 5_000 });
			tracker.ensurePoller();

			t.mock.timers.tick(10_000);
			assert.equal(bus.countOf(SUBAGENT_CONTROL_EVENT), 0, "no emit before threshold is exceeded");

			t.mock.timers.tick(5_000);
			assert.equal(bus.countOf(SUBAGENT_CONTROL_EVENT), 1);
			assert.equal(bus.countOf(SUBAGENT_NEEDS_ATTENTION_EVENT), 1);

			t.mock.timers.tick(10_000);
			assert.equal(bus.countOf(SUBAGENT_CONTROL_EVENT), 1, "same needs_attention state is deduped by edge detection");

			const payload = bus.payloadsFor(SUBAGENT_CONTROL_EVENT)[0] as { event: ControlEvent; source: string };
			assert.equal(payload.source, "async");
			assert.equal(payload.event.runId, "async-r1");
			assert.equal(payload.event.agent, "worker");
			assert.equal(payload.event.type, "needs_attention");
		} finally {
			cleanupPoller(state);
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("no-real-sleeps-uses-fake-timers: fake time crosses the threshold in under 100ms wall-clock", (t) => {
		const wallStart = performance.now();
		t.mock.timers.enable({ apis: ["Date"] });

		const events: ControlEvent[] = [];
		const ticker = createActivityTicker({
			runId: "fg-fast",
			agent: "worker",
			config: { ...DEFAULT_CONTROL_CONFIG, needsAttentionAfterMs: 60_000 },
			getStartedAt: () => 0,
			getLastActivityAt: () => 0,
			onNeedsAttention: (event) => events.push(event),
		});

		t.mock.timers.tick(60_001);
		ticker.tick();

		assert.equal(events.length, 1);
		assert.ok(performance.now() - wallStart < 100, "test must not wait for real time");
		ticker.stop();
	});

	it("dedup-on-same-state: consecutive needs_attention ticks emit only once", (t) => {
		t.mock.timers.enable({ apis: ["Date"] });

		const events: ControlEvent[] = [];
		const ticker = createActivityTicker({
			runId: "fg-dedupe",
			agent: "worker",
			config: { ...DEFAULT_CONTROL_CONFIG, needsAttentionAfterMs: 5_000 },
			getStartedAt: () => 0,
			getLastActivityAt: () => 0,
			onNeedsAttention: (event) => events.push(event),
		});

		t.mock.timers.tick(5_001);
		ticker.tick();
		ticker.tick();
		t.mock.timers.tick(10_000);
		ticker.tick();

		assert.equal(events.length, 1);
		ticker.stop();
	});

	it("re-entry-fires-again: needs_attention → idle → needs_attention emits twice", (t) => {
		t.mock.timers.enable({ apis: ["Date"] });

		const events: ControlEvent[] = [];
		let lastActivityAt = 0;
		const ticker = createActivityTicker({
			runId: "fg-reentry",
			agent: "worker",
			config: { ...DEFAULT_CONTROL_CONFIG, needsAttentionAfterMs: 5_000 },
			getStartedAt: () => 0,
			getLastActivityAt: () => lastActivityAt,
			onNeedsAttention: (event) => events.push(event),
		});

		t.mock.timers.tick(5_001);
		ticker.tick();
		lastActivityAt = Date.now();
		assert.equal(ticker.tick(), undefined, "activity resets the latch");
		t.mock.timers.tick(5_001);
		ticker.tick();

		assert.equal(events.length, 2);
		ticker.stop();
	});
});
