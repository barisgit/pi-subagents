import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveChildTools } from "../../src/dispatch/subagent-executor.ts";

function makeAgentConfig(tools?: string[], extra?: Record<string, unknown>) {
	return {
		name: "fixer",
		description: "Fix things",
		...(tools ? { tools } : {}),
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		systemPrompt: "Fix things.",
		source: "builtin",
		filePath: "fixer.md",
		...extra,
	} as never;
}

describe("child tool injection", () => {
	it("passes an executable submit_result and makes it active for explicit allowlists", async () => {
		const { activeToolNames, customTools } = resolveChildTools(makeAgentConfig(["read"]), {
			getAllTools: () => [],
		} as never);
		const submit = customTools.find((tool) => tool.name === "submit_result");

		assert.deepEqual(activeToolNames, ["read", "submit_result"]);
		assert.ok(submit, "submit_result custom tool is injected");
		assert.equal(submit?.label, "Submit result");
		assert.equal(typeof submit?.execute, "function", "submit_result is executable, not a metadata stub");
		const result = await submit?.execute?.(
			"manual",
			{ result: "payload" },
			new AbortController().signal,
			() => {},
			{} as never,
		);
		assert.equal(result?.terminate, true);
	});

	it("strips delegation tools (subagent + workflow) when canDelegate is false", () => {
		const { activeToolNames } = resolveChildTools(
			makeAgentConfig(["read", "bash", "subagent", "workflow"], { canDelegate: false }),
			{ getAllTools: () => [] } as never,
		);
		assert.deepEqual(activeToolNames, ["read", "bash", "submit_result"]);
	});

	it("keeps delegation tools when canDelegate is not false", () => {
		const { activeToolNames } = resolveChildTools(
			makeAgentConfig(["read", "subagent", "workflow"], { canDelegate: true }),
			{ getAllTools: () => [] } as never,
		);
		assert.deepEqual(activeToolNames, ["read", "subagent", "workflow", "submit_result"]);
	});
});
