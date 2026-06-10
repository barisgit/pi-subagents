/**
 * Tests for f9-stuck-phase-detection.
 *
 * Uses t.mock.timers to drive createPhaseTicker stuck detection without real delays.
 */
import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
	createPhaseEventHandler,
	createPhaseTicker,
	type PhaseTickerOptions,
	type StatusPatch,
} from "../../src/dispatch/in-process-executor.ts";
import type { RunPhaseState } from "../../src/state/run-phase.ts";
import { SUBAGENT_STUCK_EVENT, type SubagentStuckPayload } from "../../src/protocol/types.ts";

function event(record: Record<string, unknown>): AgentSessionEvent {
	return record as AgentSessionEvent;
}

function messageUpdate(type: string): AgentSessionEvent {
	return event({ type: "message_update", assistantMessageEvent: { type } });
}

function makePhaseRef(initialNow = 0) {
	const handler = createPhaseEventHandler({
		runId: "r1",
		stepIndex: 0,
		onStatusUpdate: () => {},
		initialNow,
	});
	return {
		handle: handler.handle,
		getPhaseState: handler.getState,
		getLastEventAt: () => handler.getState().lastPhaseTickAt,
	};
}

function fixedPhaseRef(state: RunPhaseState) {
	return {
		getPhaseState: () => state,
		getLastEventAt: () => state.lastPhaseTickAt,
	};
}

function startThinking(phaseRef: ReturnType<typeof makePhaseRef>, now: number): void {
	phaseRef.handle(messageUpdate("thinking_delta"), now);
}

function startTool(phaseRef: ReturnType<typeof makePhaseRef>, now: number, toolName = "bash"): void {
	phaseRef.handle(event({ type: "tool_execution_start", toolName }), now);
}

function baseOpts(
	phaseRef: Pick<ReturnType<typeof makePhaseRef>, "getPhaseState" | "getLastEventAt">,
	extra?: Partial<PhaseTickerOptions>,
): PhaseTickerOptions {
	return {
		runId: "r1",
		stepIndex: 0,
		getPhaseState: phaseRef.getPhaseState,
		getLastEventAt: phaseRef.getLastEventAt,
		onStatusUpdate: () => {},
		intervalMs: 5_000,
		quietMs: Number.POSITIVE_INFINITY,
		now: Date.now,
		setIntervalFn: globalThis.setInterval,
		clearIntervalFn: globalThis.clearInterval,
		...extra,
	};
}

let testsRun = 0;
afterEach(() => { testsRun++; });
after(() => { process.stdout.write(`# tests ${testsRun}\n`); });

describe("stuck detection (subagent:stuck emits once per phase)", () => {
	it("stuck-after-60s in thinking emits ONE stuck event", (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 0 });

		const stuckEvents: SubagentStuckPayload[] = [];
		const phaseRef = makePhaseRef();
		startThinking(phaseRef, 0);

		const ticker = createPhaseTicker(baseOpts(phaseRef, {
			onStuck: (payload) => stuckEvents.push(payload),
		}));

		t.mock.timers.tick(55_000);
		assert.equal(stuckEvents.length, 0, "no stuck event before the default 60s threshold");

		t.mock.timers.tick(5_000);
		assert.equal(stuckEvents.length, 1, "one stuck event fires at the 60s threshold");
		assert.equal(stuckEvents[0]!.phase, "thinking");
		assert.equal(stuckEvents[0]!.sinceMs, 60_000);

		t.mock.timers.tick(60_000);
		assert.equal(stuckEvents.length, 1, "same stuck spell must not re-emit");
		ticker.stop();
	});

	it("idle-never-stuck: 60s in idle emits no stuck event", (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 0 });

		const stuckEvents: SubagentStuckPayload[] = [];
		const phaseRef = fixedPhaseRef({ phase: "idle", phaseStartedAt: 0, lastPhaseTickAt: 0 });
		const ticker = createPhaseTicker(baseOpts(phaseRef, {
			onStuck: (payload) => stuckEvents.push(payload),
		}));

		t.mock.timers.tick(60_000);
		assert.equal(stuckEvents.length, 0);
		ticker.stop();
	});

	it("paused-never-stuck: 60s in paused emits no stuck event", (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 0 });

		const stuckEvents: SubagentStuckPayload[] = [];
		const phaseRef = fixedPhaseRef({ phase: "paused", phaseStartedAt: 0, lastPhaseTickAt: 0 });
		const ticker = createPhaseTicker(baseOpts(phaseRef, {
			onStuck: (payload) => stuckEvents.push(payload),
		}));

		t.mock.timers.tick(60_000);
		assert.equal(stuckEvents.length, 0);
		ticker.stop();
	});

	it("transition-clears-latch: thinking 50s -> tool_running 20s -> thinking 50s emits none", (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 0 });

		const stuckEvents: SubagentStuckPayload[] = [];
		const phaseRef = makePhaseRef();
		startThinking(phaseRef, 0);
		const ticker = createPhaseTicker(baseOpts(phaseRef, {
			onStuck: (payload) => stuckEvents.push(payload),
		}));

		t.mock.timers.tick(50_000);
		startTool(phaseRef, 50_000);
		t.mock.timers.tick(20_000);
		startThinking(phaseRef, 70_000);
		t.mock.timers.tick(50_000);

		assert.equal(stuckEvents.length, 0, "each phase spell stayed below 60s");
		ticker.stop();
	});

	it("one-emit-per-stuck-spell: thinking 120s emits exactly one", (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 0 });

		const stuckEvents: SubagentStuckPayload[] = [];
		const phaseRef = makePhaseRef();
		startThinking(phaseRef, 0);
		const ticker = createPhaseTicker(baseOpts(phaseRef, {
			onStuck: (payload) => stuckEvents.push(payload),
		}));

		t.mock.timers.tick(120_000);
		assert.equal(stuckEvents.length, 1);
		assert.ok(stuckEvents[0]!.sinceMs >= 60_000);
		ticker.stop();
	});

	it("emit-failure-silent: onStuck throws and ticker survives", (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 0 });

		const patches: StatusPatch[] = [];
		const phaseRef = makePhaseRef();
		startThinking(phaseRef, 0);
		const ticker = createPhaseTicker(baseOpts(phaseRef, {
			quietMs: 0,
			stuckThresholdMs: 5_000,
			onStatusUpdate: (patch) => patches.push(patch),
			onStuck: () => { throw new Error("bus exploded"); },
		}));

		assert.doesNotThrow(() => t.mock.timers.tick(5_000));
		assert.equal(patches.length, 2, "heartbeat and phase still emit on the throwing stuck tick");

		t.mock.timers.tick(5_000);
		assert.equal(patches.length, 4, "ticker continues after onStuck failure");
		ticker.stop();
	});

	it("payload-shape: includes runId stepIndex phase sinceMs and toolName", (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 0 });

		const calls: Array<{ event: string; payload: SubagentStuckPayload }> = [];
		const phaseRef = makePhaseRef();
		startTool(phaseRef, 0, "bash");
		const ticker = createPhaseTicker(baseOpts(phaseRef, {
			runId: "run-42",
			stepIndex: 7,
			onStuck: (payload) => calls.push({ event: SUBAGENT_STUCK_EVENT, payload }),
		}));

		t.mock.timers.tick(60_000);
		assert.equal(calls.length, 1);
		assert.equal(calls[0]!.event, "subagent:stuck");
		assert.deepEqual(calls[0]!.payload, {
			runId: "run-42",
			stepIndex: 7,
			phase: "tool_running",
			sinceMs: 60_000,
			toolName: "bash",
		});
		ticker.stop();
	});
});
