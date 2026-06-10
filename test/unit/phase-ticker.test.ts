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
} from "../../src/dispatch/in-process-executor.ts";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

function makeCollector(): { patches: StatusPatch[]; onStatusUpdate: (p: StatusPatch) => void } {
	const patches: StatusPatch[] = [];
	return { patches, onStatusUpdate: (p) => patches.push(p) };
}

function event(record: Record<string, unknown>): AgentSessionEvent {
	return record as AgentSessionEvent;
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

function baseOpts(
	phaseRef: ReturnType<typeof makePhaseRef>,
	onStatusUpdate: (p: StatusPatch) => void,
	extra?: Partial<PhaseTickerOptions>,
): PhaseTickerOptions {
	return {
		runId: "r1",
		stepIndex: 0,
		getPhaseState: phaseRef.getPhaseState,
		getLastEventAt: phaseRef.getLastEventAt,
		onStatusUpdate,
		intervalMs: 5_000,
		quietMs: 4_000,
		now: Date.now,
		setIntervalFn: globalThis.setInterval,
		clearIntervalFn: globalThis.clearInterval,
		...extra,
	};
}

let testsRun = 0;
afterEach(() => { testsRun++; });
after(() => { process.stdout.write(`# tests ${testsRun}\n`); });

describe("phase ticker fallback", () => {
	it("quiet-tick-emits-after-4s", (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 0 });

		const { patches, onStatusUpdate } = makeCollector();
		const phaseRef = makePhaseRef();
		const ticker = createPhaseTicker(baseOpts(phaseRef, onStatusUpdate));

		t.mock.timers.tick(5_000);

		assert.equal(patches.length, 2);
		assert.equal(patches[0]!.runnerHeartbeatAt, 5_000);
		assert.equal(patches[0]!.phase, undefined);
		assert.equal(patches[1]!.phase, "idle");
		assert.equal(patches[1]!.phaseStartedAt, 0);
		assert.equal(patches[1]!.runnerHeartbeatAt, 5_000);
		ticker.stop();
	});

	it("repeats-on-interval", (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 0 });

		const { patches, onStatusUpdate } = makeCollector();
		const phaseRef = makePhaseRef();
		const ticker = createPhaseTicker(baseOpts(phaseRef, onStatusUpdate));

		t.mock.timers.tick(15_000);

		assert.equal(patches.length, 6);
		assert.equal(patches[4]!.runnerHeartbeatAt, 15_000);
		assert.equal(patches[5]!.runnerHeartbeatAt, 15_000);
		ticker.stop();
	});

	it("noisy-no-emit", (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 0 });

		const { patches, onStatusUpdate } = makeCollector();
		const phaseRef = makePhaseRef();
		const ticker = createPhaseTicker(baseOpts(phaseRef, onStatusUpdate));

		t.mock.timers.tick(4_900);
		phaseRef.handle(event({ type: "noop" }), 4_900);
		t.mock.timers.tick(100);

		assert.equal(patches.length, 1);
		assert.deepEqual(patches[0], { runId: "r1", stepIndex: 0, runnerHeartbeatAt: 5_000 });
		ticker.stop();
	});

	it("heartbeat-continues-while-quiet-gate-held-closed", (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 0 });

		const { patches, onStatusUpdate } = makeCollector();
		const phaseRef = makePhaseRef();
		phaseRef.handle(event({ type: "turn_start" }), 100);
		phaseRef.handle(event({ type: "message_update", assistantMessageEvent: { type: "thinking_delta" } }), 200);
		const ticker = createPhaseTicker(baseOpts(phaseRef, onStatusUpdate));

		for (let tickAt = 5_000; tickAt <= 35_000; tickAt += 5_000) {
			t.mock.timers.tick(4_900);
			phaseRef.handle(event({ type: "message_update", assistantMessageEvent: { type: "thinking_delta" } }), tickAt - 100);
			t.mock.timers.tick(100);
		}

		assert.deepEqual(patches.map((patch) => patch.runnerHeartbeatAt), [5_000, 10_000, 15_000, 20_000, 25_000, 30_000, 35_000]);
		assert.equal(patches.every((patch) => patch.phase === undefined), true);
		ticker.stop();
	});

	it("throw-path-clears", (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 0 });

		const { patches, onStatusUpdate } = makeCollector();
		const phaseRef = makePhaseRef();
		const ticker = createPhaseTicker(baseOpts(phaseRef, onStatusUpdate));

		t.mock.timers.tick(5_000);
		assert.equal(patches.length, 2);

		ticker.stop();
		t.mock.timers.tick(10_000);

		assert.equal(patches.length, 2);
	});

	it("abort-path-clears", (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 0 });

		const { patches, onStatusUpdate } = makeCollector();
		const phaseRef = makePhaseRef();
		const ticker = createPhaseTicker(baseOpts(phaseRef, onStatusUpdate));

		t.mock.timers.tick(5_000);
		assert.equal(patches.length, 2);

		ticker.stop();
		t.mock.timers.tick(15_000);

		assert.equal(patches.length, 2);
	});

	it("model-fallback-retry-clears", (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 0 });

		const { patches, onStatusUpdate } = makeCollector();
		const firstPhaseRef = makePhaseRef();
		const firstTicker = createPhaseTicker(baseOpts(firstPhaseRef, onStatusUpdate));
		firstTicker.stop();

		const secondPhaseRef = makePhaseRef();
		const secondTicker = createPhaseTicker(baseOpts(secondPhaseRef, onStatusUpdate));
		t.mock.timers.tick(5_000);

		assert.equal(patches.length, 2, "only the second cycle may emit");

		secondTicker.stop();
		t.mock.timers.tick(20_000);
		assert.equal(patches.length, 2, "no interval leaks after both cycles stop");
	});

	it("handler-throw-does-not-crash-ticker", (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 0 });

		const patches: StatusPatch[] = [];
		let calls = 0;
		const phaseRef = makePhaseRef();
		const ticker = createPhaseTicker(baseOpts(phaseRef, (patch) => {
			calls++;
			if (calls === 1) throw new Error("boom");
			patches.push(patch);
		}));

		assert.doesNotThrow(() => t.mock.timers.tick(5_000));
		assert.equal(calls, 1);
		assert.equal(patches.length, 0);

		t.mock.timers.tick(5_000);
		assert.equal(calls, 3);
		assert.equal(patches.length, 2);
		assert.equal(patches[0]!.runnerHeartbeatAt, 10_000);
		assert.equal(patches[1]!.phase, "idle");
		ticker.stop();
	});

	it("re-asserts-current-phase-fields", (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 0 });

		const { patches, onStatusUpdate } = makeCollector();
		const phaseRef = makePhaseRef();
		phaseRef.handle(event({ type: "turn_start" }), 100);
		phaseRef.handle(event({ type: "message_update", assistantMessageEvent: { type: "thinking_delta" } }), 200);

		const ticker = createPhaseTicker(baseOpts(phaseRef, onStatusUpdate));
		t.mock.timers.tick(5_000);

		assert.equal(patches.length, 2);
		assert.deepEqual(patches[0], { runId: "r1", stepIndex: 0, runnerHeartbeatAt: 5_000 });
		assert.equal(patches[1]!.phase, "thinking");
		assert.equal(patches[1]!.phaseStartedAt, 200);
		assert.equal(patches[1]!.runnerHeartbeatAt, 5_000);
		ticker.stop();
	});
});
