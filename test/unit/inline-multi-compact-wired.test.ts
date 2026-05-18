import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { renderSubagentResult } from "../../render.ts";
import { rmRun, tool, writeRun } from "./inline-nested-helpers.ts";

const ids = ["inline-multi-parent", "inline-multi-child-a", "inline-multi-child-b"];

const theme = {
	fg: (_name: string, text: string) => text,
	bold: (text: string) => text,
};
const usage = { input: 0, output: 0, total: 0 };

afterEach(() => ids.forEach(rmRun));

describe("multi compact inline nesting", () => {
	it("renders nested child lines for each row without plain sync subagent lines", () => {
		writeRun(ids[1]!, { parentRunId: ids[0], agent: "fixer", label: "child a", events: [tool("read", { path: "/tmp/a" })] });
		writeRun(ids[2]!, { parentRunId: ids[0], state: "complete", agent: "explorer", label: "child b", tokens: 1024, startedAt: 1_000, endedAt: 2_000, events: [tool("bash", { command: "echo b" })] });
		const textA = "You are nested child A";
		const textB = "You are nested child B";
		const widget = renderSubagentResult({
			content: [{ type: "text", text: "(running...)" }],
			details: {
				mode: "parallel",
				runId: ids[0],
				results: [{
					agent: "parent-a",
					task: "parent a",
					exitCode: 0,
					messages: [],
					usage,
					progress: {
						index: 0,
						agent: "parent-a",
						status: "running",
						task: "parent a",
						recentTools: [{ tool: "subagent", args: textA, rawArgs: { agent: "fixer", task: textA, label: "child a" }, endMs: Date.now() }],
						recentOutput: [],
						toolCount: 1,
						tokens: 0,
						durationMs: 100,
					},
				}, {
					agent: "parent-b",
					task: "parent b",
					exitCode: 0,
					messages: [],
					usage,
					progress: {
						index: 1,
						agent: "parent-b",
						status: "completed",
						task: "parent b",
						recentTools: [{ tool: "subagent", args: textB, rawArgs: { agent: "explorer", task: textB, label: "child b" }, endMs: 2_000 }],
						recentOutput: [],
						toolCount: 1,
						tokens: 0,
						durationMs: 1_000,
					},
				}],
			},
		}, { expanded: false }, theme);

		const text = widget.render(140).join("\n");
		// Running parent (A) keeps the expanded child card.
		assert.match(text, /◇ subagent: fixer · child a/);
		// Completed parent (B) shows the child tally in its header tail; the child
		// card itself is no longer re-expanded.
		assert.match(text, /parent-b · 1 tool use · 1\.0s · 1 subagent\b/);
		assert.doesNotMatch(text, /✓ subagent: child b/);
		assert.doesNotMatch(text, /← subagent: You are nested child A/);
		assert.doesNotMatch(text, /← subagent: You are nested child B/);
	});
});
