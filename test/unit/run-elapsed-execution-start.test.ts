import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LiveRun, RunView } from "../../src/state/run-view.ts";
import { runElapsed } from "../../src/surfaces/subagents-status.ts";

function liveRun(partial: Partial<RunView>): LiveRun {
	return {
		ownership: "live",
		run: {
			id: "r",
			state: "running",
			mode: "single",
			startedAt: 1_000,
			steps: [],
			...partial,
		},
	};
}

describe("runElapsed execution-start handling", () => {
	it("shows no running timer for a queued run", () => {
		assert.equal(runElapsed(liveRun({ state: "queued", startedAt: 0 }), 10_000), "");
	});

	it("measures from executionStartedAt when present", () => {
		// now - executionStartedAt = 2_000ms, NOT now - startedAt (10_000ms).
		const out = runElapsed(liveRun({ startedAt: 1_000, executionStartedAt: 9_000 }), 11_000);
		assert.equal(out, runElapsed(liveRun({ startedAt: 9_000 }), 11_000));
	});

	it("falls back to startedAt when executionStartedAt is absent", () => {
		const out = runElapsed(liveRun({ startedAt: 4_000 }), 9_000);
		assert.equal(out, runElapsed(liveRun({ startedAt: 4_000, executionStartedAt: undefined }), 9_000));
		assert.notEqual(out, "");
	});
});
