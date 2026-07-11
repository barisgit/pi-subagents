import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createSubagentToolDefinitions } from "../../src/dispatch/subagent-tool.ts";
import type { SubagentToolResult } from "../../src/protocol/types.ts";

const ctx = {} as never;
const signal = new AbortController().signal;

function toolsReturning(result: SubagentToolResult) {
	const executor = {
		execute: async () => result,
		openWorkflowGroup: () => undefined,
	};
	return createSubagentToolDefinitions({ executor: executor as never });
}

describe("registered tool failure boundary", () => {
	it("throws empty validation and dispatch failures so SDK 0.75 records failure", async () => {
		const { tool } = toolsReturning({
			content: [{ type: "text", text: "Unknown agent" }],
			isError: true,
			details: { mode: "single", results: [] },
		});

		await assert.rejects(
			tool.execute?.("call", { run: [] }, signal, () => {}, ctx),
			/Unknown agent/,
		);
	});

	it("preserves partial failure details for extension rendering", async () => {
		const partial: SubagentToolResult = {
			content: [{ type: "text", text: "one child failed" }],
			isError: true,
			details: {
				mode: "parallel",
				results: [
					{
						agent: "worker",
						task: "task",
						exitCode: 1,
						error: "boom",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
					},
				],
			},
		};
		const { tool } = toolsReturning(partial);

		assert.equal(await tool.execute?.("call", { run: [] }, signal, () => {}, ctx), partial);
	});

	it("throws workflow script failures at the registered boundary", async () => {
		const { workflowTool } = toolsReturning({
			content: [{ type: "text", text: "unused" }],
			details: { mode: "management", results: [] },
		});

		await assert.rejects(
			workflowTool.execute?.("wf", { script: "throw new Error('workflow boom')" }, signal, () => {}, ctx),
			/workflow boom/,
		);
	});
});
