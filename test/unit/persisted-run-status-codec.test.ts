import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parsePersistedRunStatus } from "../../src/protocol/status-types.ts";

describe("parsePersistedRunStatus", () => {
	it("accepts a valid full status and returns the parsed value", () => {
		const value = {
			version: 1,
			runId: "run-1",
			mode: "single",
			state: "running",
			startedAt: 1_000,
			label: "demo",
		};
		const result = parsePersistedRunStatus(JSON.stringify(value));
		assert.deepEqual(result, { ok: true, value });
	});

	it("rejects invalid JSON with reason invalid-json", () => {
		assert.deepEqual(parsePersistedRunStatus("{not json"), { ok: false, reason: "invalid-json" });
	});

	it("rejects a partial status missing a required field", () => {
		const raw = JSON.stringify({ runId: "x", mode: "single", state: "running" });
		assert.deepEqual(parsePersistedRunStatus(raw), { ok: false, reason: "invalid-shape" });
	});

	it("rejects non-object JSON values", () => {
		assert.deepEqual(parsePersistedRunStatus("null"), { ok: false, reason: "invalid-shape" });
		assert.deepEqual(parsePersistedRunStatus("42"), { ok: false, reason: "invalid-shape" });
	});

	it("rejects a status whose steps field is not an array", () => {
		const raw = JSON.stringify({ runId: "x", mode: "single", state: "running", startedAt: 1, steps: {} });
		assert.deepEqual(parsePersistedRunStatus(raw), { ok: false, reason: "invalid-shape" });
	});

	it("accepts a valid status with an optional steps array", () => {
		const value = { runId: "x", mode: "parallel", state: "complete", startedAt: 1, steps: [] };
		const result = parsePersistedRunStatus(JSON.stringify(value));
		assert.deepEqual(result, { ok: true, value });
	});
});
