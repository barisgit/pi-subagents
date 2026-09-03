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

	it("parses legacy pipeline metadata without declared counts", () => {
		const value = {
			runId: "x",
			mode: "single",
			state: "complete",
			startedAt: 1,
			pipeline: { id: "pipe-1", itemIndex: 0, stageIndex: 0, itemLabel: "physics" },
		};
		assert.deepEqual(parsePersistedRunStatus(JSON.stringify(value)), { ok: true, value });
	});

	it("normalizes a legacy chain status to parallel", () => {
		const value = { runId: "x", mode: "chain", state: "complete", startedAt: 1, steps: [] };
		const result = parsePersistedRunStatus(JSON.stringify(value));
		assert.deepEqual(result, { ok: true, value: { ...value, mode: "parallel" } });
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

	it("rejects a status with a malformed nested step", () => {
		const raw = JSON.stringify({ runId: "x", mode: "single", state: "running", startedAt: 1, steps: [null] });
		assert.deepEqual(parsePersistedRunStatus(raw), { ok: false, reason: "invalid-shape" });
	});

	it("accepts a valid status with an optional steps array", () => {
		const value = { runId: "x", mode: "parallel", state: "complete", startedAt: 1, steps: [] };
		const result = parsePersistedRunStatus(JSON.stringify(value));
		assert.deepEqual(result, { ok: true, value });
	});

	it("parses an old record that lacks executionStartedAt (backward compatible)", () => {
		const value = { runId: "x", mode: "single", state: "running", startedAt: 1_000 };
		const result = parsePersistedRunStatus(JSON.stringify(value));
		assert.deepEqual(result, { ok: true, value });
		if (result.ok) assert.equal(result.value.executionStartedAt, undefined);
	});

	it("copies executionStartedAt through when present", () => {
		const value = { runId: "x", mode: "single", state: "running", startedAt: 1_000, executionStartedAt: 1_500 };
		const result = parsePersistedRunStatus(JSON.stringify(value));
		assert.deepEqual(result, { ok: true, value });
	});

	it("fails closed when executionStartedAt is present but not a number", () => {
		const raw = JSON.stringify({
			runId: "x",
			mode: "single",
			state: "running",
			startedAt: 1,
			executionStartedAt: "soon",
		});
		assert.deepEqual(parsePersistedRunStatus(raw), { ok: false, reason: "invalid-shape" });
	});

	it("parses an old record that lacks runnerPid/runnerToken (backward compatible)", () => {
		const value = { runId: "x", mode: "single", state: "running", startedAt: 1_000 };
		const result = parsePersistedRunStatus(JSON.stringify(value));
		assert.deepEqual(result, { ok: true, value });
		if (result.ok) {
			assert.equal(result.value.runnerPid, undefined);
			assert.equal(result.value.runnerToken, undefined);
		}
	});

	it("rejects wrong-typed runnerPid/runnerToken (fails closed)", () => {
		const base = { runId: "x", mode: "single", state: "running", startedAt: 1 };
		assert.deepEqual(parsePersistedRunStatus(JSON.stringify({ ...base, runnerPid: "123" })), {
			ok: false,
			reason: "invalid-shape",
		});
		assert.deepEqual(parsePersistedRunStatus(JSON.stringify({ ...base, runnerToken: 42 })), {
			ok: false,
			reason: "invalid-shape",
		});

		it("accepts a resolved control config and rejects malformed policy fields", () => {
			const base = { runId: "x", mode: "single", state: "running", startedAt: 1 };
			const controlConfig = {
				enabled: true,
				needsAttentionAfterMs: 123,
				notifyOn: ["needs_attention"],
				notifyChannels: ["event", "async"],
			};
			assert.deepEqual(parsePersistedRunStatus(JSON.stringify({ ...base, controlConfig })), {
				ok: true,
				value: { ...base, controlConfig },
			});
			assert.deepEqual(
				parsePersistedRunStatus(
					JSON.stringify({ ...base, controlConfig: { ...controlConfig, needsAttentionAfterMs: "soon" } }),
				),
				{ ok: true, value: base },
			);
		});
	});
});

describe("parsePersistedRunStatus liveness-field validation", () => {
	const base = { runId: "x", mode: "single", state: "running", startedAt: 1_000 };

	it("strips a malformed runnerHeartbeatAt instead of trusting it (fails closed to absence)", () => {
		const result = parsePersistedRunStatus(JSON.stringify({ ...base, runnerHeartbeatAt: "invalid" }));
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.equal(result.value.runnerHeartbeatAt, undefined);
			assert.equal(result.value.state, "running");
		}
	});

	it("strips malformed lastUpdate/lastActivityAt/endedAt values", () => {
		const raw = JSON.stringify({ ...base, lastUpdate: "soon", lastActivityAt: {}, endedAt: [1] });
		const result = parsePersistedRunStatus(raw);
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.equal(result.value.lastUpdate, undefined);
			assert.equal(result.value.lastActivityAt, undefined);
			assert.equal(result.value.endedAt, undefined);
		}
	});

	it("strips non-finite JSON numbers (1e400 parses to Infinity)", () => {
		const raw =
			'{"runId":"x","mode":"single","state":"running","startedAt":1000,"runnerHeartbeatAt":1e400,"lastUpdate":-1e400}';
		const result = parsePersistedRunStatus(raw);
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.equal(result.value.runnerHeartbeatAt, undefined);
			assert.equal(result.value.lastUpdate, undefined);
		}
	});

	it("strips malformed phaseStartedAt/currentToolStartedAt/resumedAt/resumeCount", () => {
		const raw = JSON.stringify({
			...base,
			phaseStartedAt: "x",
			currentToolStartedAt: null,
			resumedAt: false,
			resumeCount: "2",
		});
		const result = parsePersistedRunStatus(raw);
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.equal(result.value.phaseStartedAt, undefined);
			assert.equal(result.value.currentToolStartedAt, undefined);
			assert.equal(result.value.resumedAt, undefined);
			assert.equal(result.value.resumeCount, undefined);
		}
	});

	it("keeps well-formed liveness fields untouched (backward-readable)", () => {
		const value = { ...base, runnerHeartbeatAt: 2_000, lastUpdate: 2_100, lastActivityAt: 2_050, endedAt: 3_000 };
		const result = parsePersistedRunStatus(JSON.stringify(value));
		assert.deepEqual(result, { ok: true, value });
	});

	it("rejects a non-finite required startedAt (invalid-shape)", () => {
		const raw = '{"runId":"x","mode":"single","state":"running","startedAt":1e400}';
		assert.deepEqual(parsePersistedRunStatus(raw), { ok: false, reason: "invalid-shape" });
	});

	it("rejects a non-finite executionStartedAt/runnerPid (identity + additive fields stay whole-record strict)", () => {
		assert.deepEqual(
			parsePersistedRunStatus(
				'{"runId":"x","mode":"single","state":"running","startedAt":1,"executionStartedAt":1e400}',
			),
			{ ok: false, reason: "invalid-shape" },
		);
		assert.deepEqual(
			parsePersistedRunStatus('{"runId":"x","mode":"single","state":"running","startedAt":1,"runnerPid":1e400}'),
			{ ok: false, reason: "invalid-shape" },
		);
	});
});
