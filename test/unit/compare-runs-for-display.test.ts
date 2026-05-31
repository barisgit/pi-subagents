import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compareRunsForDisplay } from "../../run-liveness.ts";

describe("compareRunsForDisplay", () => {
	it("terminal bucket orders by coalesced endedAt descending", () => {
		const revived = { state: "complete", startedAt: 1_000, endedAt: 20_000 };
		const older = { state: "complete", startedAt: 19_000, endedAt: 10_000 };
		assert.deepEqual([older, revived].sort(compareRunsForDisplay), [revived, older]);
	});

	it("active bucket orders by startedAt ascending", () => {
		const first = { state: "running", displayState: "quiet" as const, startedAt: 1_000 };
		const spawnedLater = { state: "running", displayState: "quiet" as const, startedAt: 2_000 };
		assert.deepEqual([spawnedLater, first].sort(compareRunsForDisplay), [first, spawnedLater]);
	});

	it("uses updatedAt as a defined terminal key when endedAt is absent", () => {
		const updatedOnly = { state: "complete", startedAt: 1_000, updatedAt: 30_000 };
		const ended = { state: "complete", startedAt: 25_000, endedAt: 20_000 };
		assert.deepEqual([ended, updatedOnly].sort(compareRunsForDisplay), [updatedOnly, ended]);
	});

	it("preserves active above terminal bucketing", () => {
		const active = { state: "running", displayState: "quiet" as const, startedAt: 1_000 };
		const terminal = { state: "complete", startedAt: 2_000, endedAt: 3_000 };
		assert.deepEqual([terminal, active].sort(compareRunsForDisplay), [active, terminal]);
	});
});
