import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeGroupStatus } from "../../src/state/group-status.ts";

describe("computeGroupStatus", () => {
	it("keeps a group running while any child is active", () => {
		assert.equal(computeGroupStatus(["complete", "lost", "running"]), "running");
	});

	it("maps paused and lost children to the supported failed aggregate", () => {
		assert.equal(computeGroupStatus(["complete", "paused"]), "failed");
		assert.equal(computeGroupStatus(["complete", "lost"]), "failed");
		assert.equal(computeGroupStatus(["paused", "lost"]), "failed");
	});
});
