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
	it("no longer injects a finish tool: the allowlist is exactly the agent's tools", () => {
		// The submit_result tool was replaced by the <output> end-of-prompt contract, so an
		// explicit allowlist is passed through verbatim with no extra finish tool appended.
		const { activeToolNames, customTools } = resolveChildTools(makeAgentConfig(["read"]), {
			getAllTools: () => [],
		} as never);

		assert.deepEqual(activeToolNames, ["read"]);
		assert.deepEqual(customTools, []);
	});

	it("strips delegation tools (subagent + workflow) when canDelegate is false", () => {
		const { activeToolNames } = resolveChildTools(
			makeAgentConfig(["read", "bash", "subagent", "workflow"], { canDelegate: false }),
			{ getAllTools: () => [] } as never,
		);
		assert.deepEqual(activeToolNames, ["read", "bash"]);
	});

	it("keeps delegation tools when canDelegate is not false", () => {
		const { activeToolNames } = resolveChildTools(
			makeAgentConfig(["read", "subagent", "workflow"], { canDelegate: true }),
			{ getAllTools: () => [] } as never,
		);
		assert.deepEqual(activeToolNames, ["read", "subagent", "workflow"]);
	});

	it("undefined tools frontmatter keeps no allowlist (child sees all tools)", () => {
		const { activeToolNames, customTools } = resolveChildTools(makeAgentConfig(), {
			getAllTools: () => [],
		} as never);
		assert.equal(activeToolNames, undefined);
		assert.deepEqual(customTools, []);
	});
});
