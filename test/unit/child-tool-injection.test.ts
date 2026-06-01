import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveChildTools } from "../../subagent-executor.ts";

function makeAgentConfig(tools?: string[]) {
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
	} as never;
}

describe("child tool injection", () => {
	it("passes an executable submit_result and makes it active for explicit allowlists", async () => {
		const { activeToolNames, customTools } = resolveChildTools(makeAgentConfig(["read"]), { getAllTools: () => [] } as never);
		const submit = customTools.find((tool) => tool.name === "submit_result");

		assert.deepEqual(activeToolNames, ["read", "submit_result"]);
		assert.ok(submit, "submit_result custom tool is injected");
		assert.equal(submit?.label, "Submit result");
		assert.equal(typeof submit?.execute, "function", "submit_result is executable, not a metadata stub");
		const result = await submit?.execute?.("manual", { status: "ok", summary: "done", result: "payload" }, new AbortController().signal, () => {}, {} as never);
		assert.equal(result?.terminate, true);
	});
});
