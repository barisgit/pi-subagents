import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveChildTools } from "../../src/dispatch/executor-helpers.ts";

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
	it("keeps an explicit tool allowlist", () => {
		const { activeToolNames } = resolveChildTools(makeAgentConfig(["read"]));
		assert.deepEqual(activeToolNames, ["read"]);
	});

	it("strips delegation tools (subagent + workflow) when canDelegate is false", () => {
		const { activeToolNames } = resolveChildTools(
			makeAgentConfig(["read", "bash", "subagent", "workflow"], { canDelegate: false }),
		);
		assert.deepEqual(activeToolNames, ["read", "bash"]);
	});

	it("keeps delegation tools when canDelegate is not false", () => {
		const { activeToolNames } = resolveChildTools(
			makeAgentConfig(["read", "subagent", "workflow"], { canDelegate: true }),
		);
		assert.deepEqual(activeToolNames, ["read", "subagent", "workflow"]);
	});

	it("undefined tools frontmatter keeps no allowlist (child sees all tools)", () => {
		const { activeToolNames } = resolveChildTools(makeAgentConfig());
		assert.equal(activeToolNames, undefined);
	});

	it("adds mcpDirectTools to an explicit allowlist", () => {
		const { activeToolNames } = resolveChildTools(
			makeAgentConfig(["read"], { mcpDirectTools: ["xcodebuild_list_sims"] }),
		);
		assert.deepEqual(activeToolNames, ["read", "xcodebuild_list_sims"]);
	});

	it("leaves mcpDirectTools unbounded when no tools frontmatter is present", () => {
		const { activeToolNames } = resolveChildTools(
			makeAgentConfig(undefined, { mcpDirectTools: ["xcodebuild_list_sims"] }),
		);
		assert.equal(activeToolNames, undefined);
	});
});
