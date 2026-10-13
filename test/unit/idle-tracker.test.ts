import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createIdleTracker } from "../../src/surfaces/idle-tracker.ts";

describe("idle tracker", () => {
	it("reports whether any async runs are active", () => {
		const pi = {
			events: { emit: () => false },
			on: () => {},
		};
		const tracker = createIdleTracker(pi as never);

		assert.equal(tracker.hasActiveAsyncRuns(), false);
		tracker.onAsyncStarted("run-a");
		tracker.onAsyncStarted("run-b");
		assert.equal(tracker.hasActiveAsyncRuns(), true);

		tracker.onAsyncFinished("run-a");
		assert.equal(tracker.hasActiveAsyncRuns(), true);
		tracker.onAsyncFinished("run-b");
		assert.equal(tracker.hasActiveAsyncRuns(), false);
	});
});

function harness() {
	const handlers = new Map<string, () => void>();
	const emitted: Array<{ name: string; payload: { ts: number } }> = [];
	const tracker = createIdleTracker({
		on: (name: string, handler: () => void) => handlers.set(name, handler),
		events: { emit: (name: string, payload: { ts: number }) => emitted.push({ name, payload }) },
	} as never);
	return { tracker, emitted, fire: (name: string) => handlers.get(name)?.() };
}

it("does not declare idle between agent_end and settled, including automatic restarts", () => {
	const { tracker, emitted, fire } = harness();
	fire("agent_start");
	fire("agent_end");
	assert.equal(tracker.isIdle(), false);
	assert.equal(emitted.length, 0);
	fire("agent_start"); // Retry, overflow recovery, or a queued follow-up.
	fire("agent_end");
	assert.equal(emitted.length, 0);
	fire("agent_settled");
	assert.equal(tracker.isIdle(), true);
	assert.equal(emitted.length, 1);
	assert.equal(emitted[0]?.name, "subagent:all-idle");
	assert.equal(typeof emitted[0]?.payload.ts, "number");
	fire("agent_settled");
	tracker.onAsyncFinished("unknown");
	assert.equal(emitted.length, 1);
	fire("agent_start");
	fire("agent_settled"); // Aborted runs also settle.
	assert.equal(emitted.length, 2);
});

for (const asyncFinishesFirst of [true, false]) {
	it(`emits once when both settle boundaries drain (async first: ${asyncFinishesFirst})`, () => {
		const { tracker, emitted, fire } = harness();
		fire("agent_start");
		tracker.onAsyncStarted("a");
		tracker.onAsyncStarted("b");
		fire("agent_end");
		tracker.onAsyncFinished("a");
		assert.equal(emitted.length, 0);
		if (asyncFinishesFirst) tracker.onAsyncFinished("b");
		else fire("agent_settled");
		assert.equal(emitted.length, 0);
		if (asyncFinishesFirst) fire("agent_settled");
		else tracker.onAsyncFinished("b");
		assert.equal(tracker.isIdle(), true);
		assert.equal(emitted.length, 1);
		tracker.onAsyncFinished("b");
		fire("agent_settled");
		assert.equal(emitted.length, 1);
	});
}

it("does not emit at startup and handles async-only busy periods and reentrant activity", () => {
	const handlers = new Map<string, () => void>();
	let emits = 0;
	const tracker = createIdleTracker({
		on: (name: string, handler: () => void) => handlers.set(name, handler),
		events: {
			emit: () => {
				emits += 1;
				if (emits === 1) tracker.onAsyncStarted("follow-up");
			},
		},
	} as never);
	handlers.get("agent_settled")?.();
	assert.equal(emits, 0);
	tracker.onAsyncStarted("a");
	tracker.onAsyncFinished("a");
	assert.equal(emits, 1);
	assert.equal(tracker.isIdle(), false);
	tracker.onAsyncFinished("follow-up");
	assert.equal(emits, 2);
});
