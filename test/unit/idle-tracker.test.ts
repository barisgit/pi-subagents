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
