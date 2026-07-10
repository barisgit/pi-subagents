import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { singleResultToChildAgentResult } from "../../src/dispatch/executor-helpers.ts";

describe("singleResultToChildAgentResult", () => {
	it("derives start and end timestamps from one clock sample", () => {
		const originalNow = Date.now;
		let calls = 0;
		Date.now = () => {
			calls++;
			return 1_000;
		};
		try {
			const result = singleResultToChildAgentResult(
				{
					agent: "test-agent",
					task: "test task",
					exitCode: 0,
					usage: { input: 0, output: 0 },
					finalOutput: "done",
					progressSummary: { durationMs: 250, toolCount: 0, tokens: 0 },
				},
				{ runId: "run-1", sessionFile: "session.jsonl" },
			);

			assert.equal(calls, 1);
			assert.equal(result.durationMs, 250);
			assert.equal(result.startedAt, 750);
			assert.equal(result.endedAt, 1_000);
		} finally {
			Date.now = originalNow;
		}
	});
});
