import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { describe, it } from "node:test";
import { childResultToSingleResult, combineOptionalSignals } from "../../src/dispatch/child-step-runner.ts";

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

describe("childResultToSingleResult", () => {
	it("preserves reported zero duration and tool count", () => {
		const progress = {
			agent: "test-agent",
			status: "running" as const,
			task: "test task",
			recentTools: [],
			recentOutput: [],
			toolCount: 3,
			tokens: 0,
			durationMs: 25,
		};
		const result = childResultToSingleResult(
			{
				runId: "run-1",
				stepIndex: 0,
				state: "complete",
				exitCode: 0,
				outputText: "done",
				toolCallCount: 0,
				toolResultCount: 0,
				toolErrorCount: 0,
				durationMs: 0,
				startedAt: 0,
				endedAt: 0,
				sessionFile: "session.jsonl",
			},
			{
				resultShell: {
					agent: "test-agent",
					task: "test task",
					exitCode: 0,
					usage: { input: 0, output: 0 },
				},
				progress,
				startedAt: Date.now() - 100,
				artifactConfig: {
					enabled: false,
					includeInput: false,
					includeOutput: false,
					includeJsonl: false,
					includeMetadata: false,
					cleanupDays: 0,
				},
			},
		);

		assert.equal(result.progressSummary?.durationMs, 0);
		assert.equal(result.progressSummary?.toolCount, 0);
	});
});
