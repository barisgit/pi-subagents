/**
 * Tests for createPhaseTicker (f3-phase-ticker).
 *
 * Uses Node 24 `t.mock.timers` to control `setInterval` and `Date` without
 * real wall-clock delays. Each test gets injected `setIntervalFn` /
 * `clearIntervalFn` from the mock context so the ticker is driven
 * deterministically.
 */
import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import {
	createPhaseEventHandler,
	createPhaseTicker,
	type PhaseTickerOptions,
	type StatusPatch,
} from "../../in-process-executor.ts";

function makeCollector(): { patches: StatusPatch[]; onStatusUpdate: (p: StatusPatch) => void } {
	const patches: StatusPatch[] = [];
	return { patches, onStatusUpdate: (p) => patches.push(p) };
}

function baseOpts(onStatusUpdate: (p: StatusPatch) => void, extra?: Partial<PhaseTickerOptions>): PhaseTickerOptions {
	return { runId: "r1", stepIndex: 0, onStatusUpdate, intervalMs: 5_000, quietThresholdMs: 4_000, ...extra };
}

/** Build a getPhaseState backed by createPhaseEventHandler (no-op onStatusUpdate). */
function makePhaseRef() {
	const { getState } = createPhaseEventHandler({
		runId: "r1",
		stepIndex: 0,
		onStatusUpdate: () => {},
		initialNow: 0,
	});
	return getState;
}

let testsRun = 0;
afterEach(() => { testsRun++; });
after(() => { process.stdout.write(`# tests ${testsRun}\n`); });

describe("phase ticker fallback", () => {
	it("emits heartbeat patches at 5 s, 10 s, 15 s when no events arrive", (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "Date"] });

		const { patches, onStatusUpdate } = makeCollector();
		const getPhaseState = makePhaseRef();

		const ticker = createPhaseTicker(getPhaseState, baseOpts(onStatusUpdate, {
			setIntervalFn: globalThis.setInterval,
			clearIntervalFn: globalThis.clearInterval,
		}), 0);

		t.mock.timers.tick(5_000); // t=5000, lastEventAt=0, delta=5000 >= 4000 → emit
		assert.equal(patches.length, 1, "1 patch at 5 s");
		assert.equal(patches[0]!.phase, "idle");

		t.mock.timers.tick(5_000); // t=10000 → emit
		assert.equal(patches.length, 2, "2 patches at 10 s");

		t.mock.timers.tick(5_000); // t=15000 → emit
		assert.equal(patches.length, 3, "3 patches at 15 s");

		ticker.stop();
	});

	it("suppresses tick when an event arrived within quietThresholdMs", (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "Date"] });

		const { patches, onStatusUpdate } = makeCollector();
		const getPhaseState = makePhaseRef();

		// initialNow = 0; event at t=12_000 → lastEventAt=12_000
		const ticker = createPhaseTicker(getPhaseState, baseOpts(onStatusUpdate, {
			setIntervalFn: globalThis.setInterval,
			clearIntervalFn: globalThis.clearInterval,
		}), 0);

		t.mock.timers.tick(5_000);  // t=5000: 5000-0=5000 ≥ 4000 → emit
		assert.equal(patches.length, 1);

		t.mock.timers.tick(5_000);  // t=10000: 10000-0=10000 → emit
		assert.equal(patches.length, 2);

		// Simulate event at t=12000 (2 s before next tick)
		ticker.notifyEvent(12_000);

		t.mock.timers.tick(5_000);  // t=15000: 15000-12000=3000 < 4000 → suppressed
		assert.equal(patches.length, 2, "tick at t=15s must be suppressed by event at t=12s");

		t.mock.timers.tick(5_000);  // t=20000: 20000-12000=8000 ≥ 4000 → emit
		assert.equal(patches.length, 3, "tick at t=20s must fire");

		ticker.stop();
	});

	it("stop() after clean end prevents further patches", (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "Date"] });

		const { patches, onStatusUpdate } = makeCollector();
		const getPhaseState = makePhaseRef();

		const ticker = createPhaseTicker(getPhaseState, baseOpts(onStatusUpdate, {
			setIntervalFn: globalThis.setInterval,
			clearIntervalFn: globalThis.clearInterval,
		}), 0);

		t.mock.timers.tick(5_000); // emit 1
		assert.equal(patches.length, 1);

		ticker.stop(); // session ended

		t.mock.timers.tick(10_000); // no more emissions
		assert.equal(patches.length, 1, "no patches after stop()");
	});

	it("stop() on throw path prevents further patches", (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "Date"] });

		const { patches, onStatusUpdate } = makeCollector();
		const getPhaseState = makePhaseRef();

		const ticker = createPhaseTicker(getPhaseState, baseOpts(onStatusUpdate, {
			setIntervalFn: globalThis.setInterval,
			clearIntervalFn: globalThis.clearInterval,
		}), 0);

		// Simulate prompt() throwing at t=8000
		t.mock.timers.tick(5_000); // emit 1
		ticker.stop(); // finally block runs on throw

		t.mock.timers.tick(10_000); // no more
		assert.equal(patches.length, 1, "no patches after stop() on error path");
	});

	it("stop() on abort path prevents further patches", (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "Date"] });

		const { patches, onStatusUpdate } = makeCollector();
		const getPhaseState = makePhaseRef();

		const ticker = createPhaseTicker(getPhaseState, baseOpts(onStatusUpdate, {
			setIntervalFn: globalThis.setInterval,
			clearIntervalFn: globalThis.clearInterval,
		}), 0);

		t.mock.timers.tick(5_000); // emit 1
		ticker.stop(); // abort triggers finally

		t.mock.timers.tick(15_000);
		assert.equal(patches.length, 1, "no patches after stop() on abort");
	});

	it("stop() is idempotent — calling twice does not throw", (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "Date"] });

		const { onStatusUpdate } = makeCollector();
		const ticker = createPhaseTicker(makePhaseRef(), baseOpts(onStatusUpdate, {
			setIntervalFn: globalThis.setInterval,
			clearIntervalFn: globalThis.clearInterval,
		}), 0);

		ticker.stop();
		assert.doesNotThrow(() => ticker.stop(), "second stop() must not throw");
	});

	it("runnerHeartbeatAt in emitted patches advances with each tick", (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "Date"] });

		const { patches, onStatusUpdate } = makeCollector();
		const ticker = createPhaseTicker(makePhaseRef(), baseOpts(onStatusUpdate, {
			setIntervalFn: globalThis.setInterval,
			clearIntervalFn: globalThis.clearInterval,
		}), 0);

		t.mock.timers.tick(5_000);
		t.mock.timers.tick(5_000);

		assert.ok(patches[1]!.runnerHeartbeatAt! > patches[0]!.runnerHeartbeatAt!, "runnerHeartbeatAt must advance");
		ticker.stop();
	});

	it("phase in patches reflects current state from getPhaseState()", (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "Date"] });

		const { patches, onStatusUpdate } = makeCollector();
		const phaseHandler = createPhaseEventHandler({
			runId: "r1", stepIndex: 0, onStatusUpdate: () => {}, initialNow: 0,
		});

		// Advance to thinking before starting ticker so getState() returns thinking
		phaseHandler.handle({ type: "turn_start" } as never, 100);
		phaseHandler.handle({ type: "message_update", assistantMessageEvent: { type: "thinking_delta" } } as never, 200);

		const ticker = createPhaseTicker(phaseHandler.getState, baseOpts(onStatusUpdate, {
			setIntervalFn: globalThis.setInterval,
			clearIntervalFn: globalThis.clearInterval,
		}), 200);

		t.mock.timers.tick(5_000);
		assert.equal(patches.length, 1);
		assert.equal(patches[0]!.phase, "thinking", "ticker must report current phase from state machine");

		ticker.stop();
	});
});
