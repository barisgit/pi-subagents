import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { describe, it } from "node:test";
import { combineOptionalSignals } from "../../src/dispatch/child-step-runner.ts";

describe("combineOptionalSignals", () => {
	it("removes listeners from the remaining signals after one aborts", () => {
		const first = new AbortController();
		const second = new AbortController();

		const combined = combineOptionalSignals(first.signal, second.signal);
		assert.equal(getEventListeners(second.signal, "abort").length, 1);
		first.abort("stop");

		assert.equal(combined.aborted, true);
		assert.equal(combined.reason, "stop");
		assert.equal(getEventListeners(second.signal, "abort").length, 0);
	});
});
