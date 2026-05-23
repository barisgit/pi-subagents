import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createIdleTracker } from "../../idle-tracker.ts";
import { SUBAGENT_ALL_IDLE_EVENT } from "../../types.ts";

function createPiRecorder() {
	const handlers = new Map<string, Array<() => void>>();
	const events: Array<{ channel: string; data: unknown }> = [];
	return {
		pi: {
			on: (event: string, handler: () => void) => {
				const list = handlers.get(event) ?? [];
				list.push(handler);
				handlers.set(event, list);
			},
			events: {
				emit: (channel: string, data: unknown) => {
					events.push({ channel, data });
				},
			},
		},
		events,
		emitLifecycle: (event: string) => {
			for (const handler of handlers.get(event) ?? []) handler();
		},
	};
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("idle tracker", () => {
	it("debounces all-idle until the session remains idle", async () => {
		const recorder = createPiRecorder();
		const tracker = createIdleTracker(recorder.pi as never, { allIdleDebounceMs: 25 });

		recorder.emitLifecycle("agent_start");
		recorder.emitLifecycle("agent_end");
		assert.equal(recorder.events.length, 0);

		recorder.emitLifecycle("agent_start");
		await sleep(35);
		assert.equal(recorder.events.length, 0, "new activity should cancel the pending idle emit");

		recorder.emitLifecycle("agent_end");
		await sleep(35);
		assert.equal(recorder.events.length, 1);
		assert.equal(recorder.events[0]?.channel, SUBAGENT_ALL_IDLE_EVENT);

		tracker.dispose();
	});

	it("waits for async subagents and cancels if another async run starts", async () => {
		const recorder = createPiRecorder();
		const tracker = createIdleTracker(recorder.pi as never, { allIdleDebounceMs: 20 });

		recorder.emitLifecycle("agent_start");
		tracker.onAsyncStarted("a");
		recorder.emitLifecycle("agent_end");
		await sleep(30);
		assert.equal(recorder.events.length, 0);

		tracker.onAsyncFinished("a");
		tracker.onAsyncStarted("b");
		await sleep(30);
		assert.equal(recorder.events.length, 0);

		tracker.onAsyncFinished("b");
		await sleep(30);
		assert.equal(recorder.events.length, 1);
		assert.equal(recorder.events[0]?.channel, SUBAGENT_ALL_IDLE_EVENT);

		tracker.dispose();
	});
});
