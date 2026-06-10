import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentConfig } from "../../src/shared/agents.ts";
import { resolveAgentToolPatterns, resolveToolPatterns } from "../../src/dispatch/resolve-tool-patterns.ts";

const AVAILABLE = [
	"read",
	"bash",
	"edit",
	"write",
	"apply_patch",
	"grep",
	"ast_grep",
	"find",
	"ls",
	"scan_files",
	"mcp",
	"fetch",
	"exa_web_search_exa",
	"auggie_codebase-retrieval",
	"compress",
	"subagent",
	"task_manage",
	"task_next",
];

function makeAgent(tools: string[]): AgentConfig {
	return {
		name: "test",
		description: "test agent",
		tools,
		systemPrompt: "",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		source: "user",
		filePath: "/tmp/test.md",
	};
}

describe("resolveToolPatterns", () => {
	it("passes exact matches through", () => {
		const result = resolveToolPatterns(["read", "bash", "grep"], AVAILABLE);
		assert.deepEqual(result, ["read", "bash", "grep"]);
	});

	it("expands glob patterns against available tools", () => {
		const result = resolveToolPatterns(["task_*"], AVAILABLE);
		assert.deepEqual(result.sort(), ["task_manage", "task_next"].sort());
	});

	it("expands prefix glob", () => {
		const result = resolveToolPatterns(["auggie_*"], AVAILABLE);
		assert.deepEqual(result, ["auggie_codebase-retrieval"]);
	});

	it("removes negated exact tools", () => {
		const result = resolveToolPatterns(["read", "bash", "grep", "!bash"], AVAILABLE);
		assert.deepEqual(result, ["read", "grep"]);
	});

	it("removes negated glob tools", () => {
		const result = resolveToolPatterns(["read", "bash", "!auggie_*"], AVAILABLE);
		assert.deepEqual(result, ["read", "bash"]);
	});

	it("handles star then negation (all except)", () => {
		const result = resolveToolPatterns(["*", "!edit", "!write", "!apply_patch"], AVAILABLE);
		assert.ok(!result.includes("edit"));
		assert.ok(!result.includes("write"));
		assert.ok(!result.includes("apply_patch"));
		assert.ok(result.includes("read"));
		assert.ok(result.includes("bash"));
		assert.ok(result.includes("grep"));
	});

	it("deduplicates results", () => {
		const result = resolveToolPatterns(["read", "read", "bash"], AVAILABLE);
		assert.deepEqual(result, ["read", "bash"]);
	});

	it("passes unknown exact tools through silently", () => {
		const result = resolveToolPatterns(["read", "nonexistent_tool"], AVAILABLE);
		assert.deepEqual(result, ["read", "nonexistent_tool"]);
	});

	it("returns empty for empty input", () => {
		assert.deepEqual(resolveToolPatterns([], AVAILABLE), []);
	});

	it("glob that matches nothing returns empty", () => {
		assert.deepEqual(resolveToolPatterns(["xyz_*"], AVAILABLE), []);
	});

	it("handles multiple glob patterns", () => {
		const result = resolveToolPatterns(["task_*", "auggie_*"], AVAILABLE);
		assert.deepEqual(result.sort(), ["auggie_codebase-retrieval", "task_manage", "task_next"].sort());
	});

	it("negation removes from earlier glob expansion", () => {
		const result = resolveToolPatterns(["task_*", "!task_next"], AVAILABLE);
		assert.deepEqual(result, ["task_manage"]);
	});
});

describe("resolveAgentToolPatterns", () => {
	it("returns same config when no patterns present", () => {
		const agent = makeAgent(["read", "bash"]);
		const result = resolveAgentToolPatterns(agent, AVAILABLE);
		assert.equal(result, agent); // same reference
	});

	it("returns same config when tools is undefined", () => {
		const agent = makeAgent(undefined!);
		const result = resolveAgentToolPatterns(agent, AVAILABLE);
		assert.equal(result, agent);
	});

	it("returns same config when tools is empty", () => {
		const agent = makeAgent([]);
		const result = resolveAgentToolPatterns(agent, AVAILABLE);
		assert.equal(result, agent);
	});

	it("resolves patterns and returns new config", () => {
		const agent = makeAgent(["read", "task_*", "!task_next"]);
		const result = resolveAgentToolPatterns(agent, AVAILABLE);
		assert.notEqual(result, agent);
		assert.deepEqual(result.tools, ["read", "task_manage"]);
		assert.equal(result.name, "test");
	});
});
