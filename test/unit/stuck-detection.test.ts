/**
 * Tests for f9-stuck-phase-detection.
 *
 * Uses t.mock.timers to drive createPhaseTicker stuck detection without real delays.
 */
import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import {
	createPhaseTicker,
	createPhaseEventHandler,
	type PhaseTickerOptions,
	type StatusPatch,
} from "../../in-process-executor.ts";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

function event(record: Record<string, unknown>): AgentSessionEvent {
	return record as AgentSessionEvent;
}
function messageUpdate(type: string): AgentSessionEvent {
	return event({ type: "message_update", assistantMessageEvent: { type } });
}

function makePhaseState(initialPhase = "tool_running", phaseStartedAt = 0) {
	// Build a handler whose getState() starts in the given phase
	const { handle, getState } = createPhaseEventHandler({
		runId: "r1", stepIndex: 0, onStatusUpdate: () => {}, initialNow: phaseStartedAt,
	});
	if (initialPhase === "tool_running") {
		handle(event({ type: "tool_execution_start", toolName: "bash" }), phaseStartedAt);
	} else if (initialPhase === "thinking") {
		handle(messageUpdate("thinking_delta"), phaseStartedAt);
	}
	return { handle, getState };
}

let testsRun = 0;
afterEach(() => { testsRun++; });
after(() => { process.stdout.write(`# tests ${testsRun}\n`); });

describe("subagent:stuck emits once per phase", () => {
	it("emits-stuck-after-threshold: fires onStuck after stuckThresholdMs in same phase", (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "Date"] });

		const stuckEvents: unknown[] = [];
		const { getState } = makePhaseState("tool_running", 0);

		const ticker = createPhaseTicker(getState, {
			runId: "r1",
			stepIndex: 0,
			onStatusUpdate: () => {},
			intervalMs: 5_000,
			quietThresholdMs: 0, // always emit heartbeat
			stuckThresholdMs: 60_000,
			onStuck: (p) => stuckEvents.push(p),
			setIntervalFn: globalThis.setInterval,
			clearIntervalFn: globalThis.clearInterval,
		}, 0);

		// Ticks before threshold
		t.mock.timers.tick(30_000);
		assert.equal(stuckEvents.length, 0, "no stuck before 60s");

		t.mock.timers.tick(29_000); // total 59s — still under
		assert.equal(stuckEvents.length, 0, "no stuck at 59s");

		t.mock.timers.tick(5_000); // total 64s — over threshold, first tick past it
		assert.equal(stuckEvents.length, 1, "must emit exactly once after threshold");
		assert.equal((stuckEvents[0] as { phase: string }).phase, "tool_running");
		assert.ok((stuckEvents[0] as { sinceMs: number }).sinceMs >= 60_000);

		ticker.stop();
	});

	it("one-per-phase-boundary: subsequent ticks in same phase do NOT re-fire", (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "Date"] });

		const stuckEvents: unknown[] = [];
		const { getState } = makePhaseState("tool_running", 0);

		const ticker = createPhaseTicker(getState, {
			runId: "r1",
			stepIndex: 0,
			onStatusUpdate: () => {},
			intervalMs: 5_000,
			quietThresholdMs: 0,
			stuckThresholdMs: 10_000,
			onStuck: (p) => stuckEvents.push(p),
			setIntervalFn: globalThis.setInterval,
			clearIntervalFn: globalThis.clearInterval,
		}, 0);

		t.mock.timers.tick(60_000); // many ticks past threshold
		assert.equal(stuckEvents.length, 1, "must emit exactly once, not once per tick");

		ticker.stop();
	});

	it("resets-on-phase-change: stuck fires again after phase changes and new phase exceeds threshold", (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "Date"] });

		const stuckEvents: unknown[] = [];
		const { handle, getState } = makePhaseState("tool_running", 0);

		const ticker = createPhaseTicker(getState, {
			runId: "r1",
			stepIndex: 0,
			onStatusUpdate: () => {},
			intervalMs: 5_000,
			quietThresholdMs: 0,
			stuckThresholdMs: 30_000,
			onStuck: (p) => stuckEvents.push(p),
			setIntervalFn: globalThis.setInterval,
			clearIntervalFn: globalThis.clearInterval,
		}, 0);

		// First phase exceeds threshold
		t.mock.timers.tick(35_000);
		assert.equal(stuckEvents.length, 1, "first stuck after tool_running > 30s");
		assert.equal((stuckEvents[0] as { phase: string }).phase, "tool_running");

		// Change phase at t=35000 → thinking
		handle(event({ type: "tool_execution_end" }), 35_000); // idle
		handle(messageUpdate("thinking_delta"), 35_000);        // thinking

		// Another 35s in thinking phase
		t.mock.timers.tick(35_000); // total t=70000; thinking started at 35000 → 35s in thinking
		assert.equal(stuckEvents.length, 2, "second stuck after thinking > 30s");
		assert.equal((stuckEvents[1] as { phase: string }).phase, "thinking");

		ticker.stop();
	});

	it("configurable-threshold: custom stuckThresholdMs is respected", (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "Date"] });

		const stuckEvents: unknown[] = [];
		const { getState } = makePhaseState("thinking", 0);

		const ticker = createPhaseTicker(getState, {
			runId: "r1",
			stepIndex: 0,
			onStatusUpdate: () => {},
			intervalMs: 5_000,
			quietThresholdMs: 0,
			stuckThresholdMs: 20_000, // custom: 20s
			onStuck: (p) => stuckEvents.push(p),
			setIntervalFn: globalThis.setInterval,
			clearIntervalFn: globalThis.clearInterval,
		}, 0);

		t.mock.timers.tick(15_000); // under 20s threshold
		assert.equal(stuckEvents.length, 0, "no stuck before custom 20s threshold");

		t.mock.timers.tick(10_000); // now 25s > 20s
		assert.equal(stuckEvents.length, 1, "stuck fires at custom 20s threshold");

		ticker.stop();
	});

	it("no-onStuck-no-crash: ticker works normally with no onStuck callback", (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "Date"] });

		const patches: StatusPatch[] = [];
		const { getState } = makePhaseState("tool_running", 0);

		const ticker = createPhaseTicker(getState, {
			runId: "r1",
			stepIndex: 0,
			onStatusUpdate: (p) => patches.push(p),
			intervalMs: 5_000,
			quietThresholdMs: 0,
			// no onStuck
			setIntervalFn: globalThis.setInterval,
			clearIntervalFn: globalThis.clearInterval,
		}, 0);

		assert.doesNotThrow(() => t.mock.timers.tick(120_000), "must not throw when onStuck is absent");
		assert.ok(patches.length > 0, "heartbeat patches must still be emitted");

		ticker.stop();
	});

	it("toolName forwarded in stuck payload for tool phases", (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "Date"] });

		const stuckEvents: Array<{ toolName?: string }> = [];
		const { getState } = makePhaseState("tool_running", 0); // toolName = "bash"

		const ticker = createPhaseTicker(getState, {
			runId: "r1",
			stepIndex: 0,
			onStatusUpdate: () => {},
			intervalMs: 5_000,
			quietThresholdMs: 0,
			stuckThresholdMs: 10_000,
			onStuck: (p) => stuckEvents.push(p),
			setIntervalFn: globalThis.setInterval,
			clearIntervalFn: globalThis.clearInterval,
		}, 0);

		t.mock.timers.tick(15_000);
		assert.equal(stuckEvents.length, 1);
		assert.equal(stuckEvents[0]!.toolName, "bash", "toolName must be forwarded for tool phases");

		ticker.stop();
	});
});
