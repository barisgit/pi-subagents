import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { nestedSubagentUsageFromToolEvent, publishSubagentUsage } from "../../src/dispatch/executor-helpers.ts";
import { SUBAGENT_USAGE_EVENT, type SubagentUsageRecord } from "../../src/protocol/types.ts";

describe("nested subagent usage extraction", () => {
	it("reads direct subagent tool results", () => {
		const usage = nestedSubagentUsageFromToolEvent({
			type: "tool_execution_end",
			toolName: "subagent",
			result: {
				details: { mode: "single", results: [], totalUsage: { input: 10, output: 4, cacheRead: 2, cost: 0.3 } },
			},
		});

		assert.deepEqual(usage, { input: 10, output: 4, cacheRead: 2, cacheWrite: 0, cost: 0.3, turns: 0 });
	});

	it("reads subagent tool results hidden inside a run sandbox timeline", () => {
		const usage = nestedSubagentUsageFromToolEvent({
			type: "tool_execution_end",
			toolName: "run",
			result: {
				details: {
					kind: "sandbox.result",
					timeline: [
						{
							kind: "tool",
							toolName: "read",
							result: { details: { totalUsage: { input: 999, output: 999 } } },
						},
						{
							kind: "tool",
							toolName: "subagent",
							result: {
								details: {
									mode: "single",
									results: [],
									totalUsage: { input: 20, output: 5, cacheWrite: 3 },
								},
							},
						},
						{
							kind: "tool",
							toolName: "subagent",
							result: {
								details: {
									mode: "parallel",
									results: [],
									totalUsage: { input: 7, output: 8, cacheRead: 1 },
								},
							},
						},
					],
				},
			},
		});

		assert.deepEqual(usage, { input: 27, output: 13, cacheRead: 1, cacheWrite: 3, cost: 0, turns: 0 });
	});

	it("publishes stable usage records through event and branch entry surfaces", () => {
		const emitted: unknown[] = [];
		const appended: unknown[] = [];
		const state: { usageByRun?: Map<string, SubagentUsageRecord> } = {};
		const record = {
			runId: "run-1",
			rootRunId: "root-1",
			mode: "single" as const,
			source: "sync" as const,
			totalUsage: { input: 11, output: 6, cacheRead: 2, cacheWrite: 0, cost: 0.12 },
			timestamp: 123,
		};

		publishSubagentUsage(
			{
				events: { emit: (event: string, payload: unknown) => emitted.push({ event, payload }) },
				appendEntry: (customType: string, data: unknown) => appended.push({ customType, data }),
			} as never,
			state,
			record,
		);

		assert.deepEqual(emitted, [{ event: SUBAGENT_USAGE_EVENT, payload: record }]);
		assert.deepEqual(appended, [{ customType: "subagent_usage", data: record }]);
		assert.ok(state.usageByRun);
		assert.deepEqual([...state.usageByRun.values()], [record]);
	});
});
