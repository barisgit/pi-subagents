import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	buildControlEvent,
	deriveActivityState,
	resolveControlConfig,
	shouldEmitControlEvent,
} from "../../subagent-control.ts";

const config = resolveControlConfig(undefined, {
	quietAfterMs: 100,
	stalledAfterMs: 300,
});

describe("subagent control activity state", () => {
	it("classifies starting, active, quiet, stalled, and paused", () => {
		assert.equal(deriveActivityState({ config, startedAt: 0, hasSeenActivity: false, paused: false, now: 50 }), "starting");
		assert.equal(deriveActivityState({ config, startedAt: 0, lastActivityAt: 0, hasSeenActivity: true, paused: false, now: 50 }), "active");
		assert.equal(deriveActivityState({ config, startedAt: 0, lastActivityAt: 0, hasSeenActivity: true, paused: false, now: 200 }), "quiet");
		assert.equal(deriveActivityState({ config, startedAt: 0, lastActivityAt: 0, hasSeenActivity: true, paused: false, now: 400 }), "stalled");
		assert.equal(deriveActivityState({ config, startedAt: 0, lastActivityAt: 0, hasSeenActivity: true, paused: true, now: 50 }), "paused");
	});

	it("emits only important transitions by default", () => {
		assert.equal(shouldEmitControlEvent(config, "active", "quiet"), false);
		assert.equal(shouldEmitControlEvent(config, "quiet", "stalled"), true);
		assert.equal(shouldEmitControlEvent(config, "stalled", "active"), true);
		assert.equal(shouldEmitControlEvent(config, "active", "paused"), true);
		assert.equal(shouldEmitControlEvent(config, "paused", "active"), true);
	});

	it("emits all state changes in verbose parent mode", () => {
		const verbose = resolveControlConfig(undefined, { quietAfterMs: 100, stalledAfterMs: 300, parentMode: "verbose" });
		assert.equal(shouldEmitControlEvent(verbose, "active", "quiet"), true);
	});

	it("builds compact control event payloads", () => {
		const event = buildControlEvent({
			from: "quiet",
			to: "stalled",
			runId: "run-1",
			agent: "worker",
			index: 2,
			ts: 123,
		});
		assert.deepEqual(event, {
			type: "stalled",
			from: "quiet",
			to: "stalled",
			ts: 123,
			runId: "run-1",
			agent: "worker",
			index: 2,
			message: "worker stalled (quiet -> stalled)",
		});
	});
});
