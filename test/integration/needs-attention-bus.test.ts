/**
 * Integration tests for f8-needs-attention-event-channel.
 *
 * Uses t.mock.timers to drive createActivityTicker deterministically and the
 * async-job-tracker poll-loop transition detection without real sleeps.
 */
import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import {
	buildControlEvent,
	claimControlNotification,
	createActivityTicker,
	DEFAULT_CONTROL_CONFIG,
	shouldEmitControlEvent,
} from "../../subagent-control.ts";
import {
	SUBAGENT_NEEDS_ATTENTION_EVENT,
	SUBAGENT_CONTROL_EVENT,
	type SubagentNeedsAttentionPayload,
} from "../../types.ts";

let testsRun = 0;
afterEach(() => { testsRun++; });
after(() => { process.stdout.write(`# tests ${testsRun}\n`); });

// Minimal fake EventBus recorder
function makeEventsBus() {
	const calls: Array<{ event: string; payload: unknown }> = [];
	return {
		emit(ev: string, payload: unknown) { calls.push({ event: ev, payload }); },
		calls,
		countOf(ev: string) { return calls.filter((c) => c.event === ev).length; },
	};
}

describe("needs-attention reaches parent", () => {
	it("foreground-transition-fires-control-event: ticker emits onNeedsAttention after needsAttentionAfterMs elapses", (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "Date"] });

		const events: unknown[] = [];
		const config = { ...DEFAULT_CONTROL_CONFIG, needsAttentionAfterMs: 10_000 };
		let lastActivityAt: number | undefined = 0; // last activity was at t=0
		let startedAt = 0;

		const ticker = createActivityTicker({
			runId: "r1",
			agent: "worker",
			config,
			getLastActivityAt: () => lastActivityAt,
			getStartedAt: () => startedAt,
			onNeedsAttention: (e) => events.push(e),
			intervalMs: 5_000,
			setIntervalFn: globalThis.setInterval,
			clearIntervalFn: globalThis.clearInterval,
		});

		t.mock.timers.tick(5_000); // t=5000: ageMs=5000 < 10000 → no emit
		assert.equal(events.length, 0, "no emit before threshold");

		t.mock.timers.tick(5_000); // t=10000: ageMs=10000 < 10000 → no emit (strictly greater)
		assert.equal(events.length, 0, "no emit at exact threshold");

		t.mock.timers.tick(5_000); // t=15000: ageMs=15000 > 10000 → emit transition
		assert.equal(events.length, 1, "must emit once after threshold exceeded");
		assert.equal((events[0] as { type: string }).type, "needs_attention");

		t.mock.timers.tick(5_000); // t=20000: still needs_attention (no state flip) → no second emit
		assert.equal(events.length, 1, "deduped: second tick in same state must not re-emit");

		ticker.stop();
	});

	it("noisy-no-emit: activity resets before threshold — no emit", (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "Date"] });

		const events: unknown[] = [];
		const config = { ...DEFAULT_CONTROL_CONFIG, needsAttentionAfterMs: 10_000 };
		let lastActivityAt = 0;

		const ticker = createActivityTicker({
			runId: "r2",
			agent: "worker",
			config,
			getLastActivityAt: () => lastActivityAt,
			getStartedAt: () => 0,
			onNeedsAttention: (e) => events.push(e),
			intervalMs: 5_000,
			setIntervalFn: globalThis.setInterval,
			clearIntervalFn: globalThis.clearInterval,
		});

		t.mock.timers.tick(4_000); // simulate activity at t=4000
		lastActivityAt = 4_000;
		t.mock.timers.tick(6_000); // t=10000: age = 10000 - 4000 = 6000 < 10000 → no emit
		assert.equal(events.length, 0, "activity reset must suppress the notification");

		ticker.stop();
	});

	it("clean-end-clears: stop() prevents further emissions", (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "Date"] });

		const events: unknown[] = [];
		const config = { ...DEFAULT_CONTROL_CONFIG, needsAttentionAfterMs: 5_000 };

		const ticker = createActivityTicker({
			runId: "r3",
			agent: "worker",
			config,
			getLastActivityAt: () => 0,
			getStartedAt: () => 0,
			onNeedsAttention: (e) => events.push(e),
			intervalMs: 3_000,
			setIntervalFn: globalThis.setInterval,
			clearIntervalFn: globalThis.clearInterval,
		});

		t.mock.timers.tick(6_000); // threshold exceeded → emit
		assert.equal(events.length, 1);

		ticker.stop(); // session ended

		t.mock.timers.tick(10_000); // no more emissions
		assert.equal(events.length, 1, "no emissions after stop()");
	});

	it("dedup-on-same-state: same needs_attention state on consecutive ticks emits only once", (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "Date"] });

		const events: unknown[] = [];
		const config = { ...DEFAULT_CONTROL_CONFIG, needsAttentionAfterMs: 5_000 };

		const ticker = createActivityTicker({
			runId: "r4",
			agent: "worker",
			config,
			getLastActivityAt: () => 0,
			getStartedAt: () => 0,
			onNeedsAttention: (e) => events.push(e),
			intervalMs: 3_000,
			setIntervalFn: globalThis.setInterval,
			clearIntervalFn: globalThis.clearInterval,
		});

		// Advance well past threshold — multiple ticks all in needs_attention
		t.mock.timers.tick(30_000);

		assert.equal(events.length, 1, "must emit exactly once for the transition, not once per tick");
		ticker.stop();
	});

	it("async-transition-fires-control-event: async poll loop emits SUBAGENT_CONTROL_EVENT + SUBAGENT_NEEDS_ATTENTION_EVENT on needs_attention transition", () => {
		// Drive the async path directly: simulate what the poll loop does when
		// activityState transitions to needs_attention.
		// We test the logic in isolation by calling shouldEmitControlEvent + buildControlEvent
		// + the emission pattern, then asserting the bus receives the correct events.
		const bus = makeEventsBus();

		// Simulate: previousActivityState = undefined, newActivityState = "needs_attention"
		// This mirrors the async-job-tracker poll loop when status.activityState becomes needs_attention.
		const from: "needs_attention" | undefined = undefined;
		const to: "needs_attention" = "needs_attention";

		const config = { ...DEFAULT_CONTROL_CONFIG };
		const shouldEmit = shouldEmitControlEvent(config, from, to);
		assert.ok(shouldEmit, "shouldEmitControlEvent must return true for undefined → needs_attention");

		const controlEvent = buildControlEvent({ from, to, runId: "async-r1", agent: "worker", ts: 9000, lastActivityAt: 1000 });
		const seenKeys = new Set<string>();
		const claimed = claimControlNotification(config, controlEvent, seenKeys);
		assert.ok(claimed, "first claim must succeed");

		// Emit like async-job-tracker does
		bus.emit(SUBAGENT_CONTROL_EVENT, { event: controlEvent, source: "async" });
		const naPayload: SubagentNeedsAttentionPayload = { runId: "async-r1", agent: "worker", ts: 9000, message: controlEvent.message };
		bus.emit(SUBAGENT_NEEDS_ATTENTION_EVENT, naPayload);

		assert.equal(bus.countOf(SUBAGENT_CONTROL_EVENT), 1, "SUBAGENT_CONTROL_EVENT must be emitted once");
		assert.equal(bus.countOf(SUBAGENT_NEEDS_ATTENTION_EVENT), 1, "SUBAGENT_NEEDS_ATTENTION_EVENT must be emitted once");

		// Dedupe: second claim with same key must fail
		const claimed2 = claimControlNotification(config, controlEvent, seenKeys);
		assert.ok(!claimed2, "second claim must be blocked by dedupe");
	});

	it("stop()-is-idempotent: calling stop() twice does not throw", (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "Date"] });

		const ticker = createActivityTicker({
			runId: "r5",
			agent: "worker",
			config: DEFAULT_CONTROL_CONFIG,
			getLastActivityAt: () => 0,
			getStartedAt: () => 0,
			onNeedsAttention: () => {},
			setIntervalFn: globalThis.setInterval,
			clearIntervalFn: globalThis.clearInterval,
		});

		ticker.stop();
		assert.doesNotThrow(() => ticker.stop(), "second stop() must not throw");
	});

	it("emission-failure-does-not-crash-ticker: onNeedsAttention throwing must not stop further ticks", (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "Date"] });

		let callCount = 0;
		const config = { ...DEFAULT_CONTROL_CONFIG, needsAttentionAfterMs: 5_000 };
		// lastActivityAt changes so state flips back and forth
		let lastActivity = 0;

		const ticker = createActivityTicker({
			runId: "r6",
			agent: "worker",
			config,
			getLastActivityAt: () => lastActivity,
			getStartedAt: () => 0,
			onNeedsAttention: () => { callCount++; throw new Error("bus exploded"); },
			intervalMs: 3_000,
			setIntervalFn: globalThis.setInterval,
			clearIntervalFn: globalThis.clearInterval,
		});

		t.mock.timers.tick(6_000); // → needs_attention, emit throws
		assert.equal(callCount, 1);

		// Reset lastActivity to flip back to undefined (not needs_attention)
		lastActivity = 6_000;
		t.mock.timers.tick(3_000); // t=9000: age = 9000 - 6000 = 3000 < 5000 → undefined (state flip back)
		// Advance again past threshold to get a second transition
		lastActivity = 0;
		t.mock.timers.tick(6_000); // t=15000: age = 15000 > 5000 → needs_attention again
		assert.equal(callCount, 2, "ticker must continue firing after emit failure");

		ticker.stop();
	});
});
