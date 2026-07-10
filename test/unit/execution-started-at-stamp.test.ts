import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PersistedRunStatus, PersistedRunStep } from "../../src/protocol/status-types.ts";
import { applyPatchToStatus } from "../../src/state/status-patch.ts";

function baseStatus(): PersistedRunStatus & { steps: PersistedRunStep[] } {
	return {
		version: 1,
		runId: "run-1",
		mode: "single",
		state: "queued",
		startedAt: 1_000,
		steps: [],
	};
}

describe("applyPatchToStatus executionStartedAt stamp", () => {
	it("stamps executionStartedAt on the queued->running flip", () => {
		const status = baseStatus();
		assert.equal(status.executionStartedAt, undefined);
		applyPatchToStatus(status, { runId: "run-1", stepIndex: 0, state: "running" });
		assert.equal(status.state, "running");
		assert.equal(typeof status.executionStartedAt, "number");
	});

	it("does not overwrite an existing executionStartedAt on later running patches", () => {
		const status = baseStatus();
		status.executionStartedAt = 1_234;
		applyPatchToStatus(status, { runId: "run-1", stepIndex: 0, state: "running" });
		assert.equal(status.executionStartedAt, 1_234);
	});

	it("does not stamp executionStartedAt while still queued", () => {
		const status = baseStatus();
		applyPatchToStatus(status, { runId: "run-1", stepIndex: 0, state: "queued" });
		assert.equal(status.executionStartedAt, undefined);
	});
});
