import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { renderSubagentResult } from "../../src/surfaces/render.ts";
import { rmRun, tool, writeRun } from "./inline-nested-helpers.ts";

const parent = "inline-suppress-parent";
const child = "inline-suppress-child";
const childTask = "You are the nested SYNC child. Read /Users/example/file.txt";

const theme = {
	fg: (_name: string, text: string) => text,
	bold: (text: string) => text,
} as never;
const usage = { input: 0, output: 0, total: 0 };

afterEach(() => [parent, child].forEach(rmRun));

describe("inline sync subagent history suppression", () => {
	it("replaces the plain subagent history line with nested child output", () => {
		writeRun(child, { parentRunId: parent, agent: "fixer", label: "nested sync", tokens: 512, events: [tool("read", { path: "/tmp/a" })] });
		const now = Date.now();
		const widget = renderSubagentResult({
			content: [{ type: "text", text: "(running...)" }],
			details: {
				mode: "single",
				runId: parent,
				results: [{
					agent: "parent",
					task: "parent task",
					exitCode: 0,
					messages: [],
					usage,
					progress: {
						index: 0,
						agent: "parent",
						status: "running",
						task: "parent task",
						recentTools: [{ tool: "subagent", args: childTask, rawArgs: { agent: "fixer", task: childTask, label: "nested sync" }, endMs: now }],
						recentOutput: [],
						toolCount: 1,
						tokens: 0,
						durationMs: 100,
					},
				}],
			},
		}, { expanded: false }, theme);

		const text = widget.render(120).join("\n");
		assert.match(text, /◇ subagent: fixer · nested sync/);
		assert.doesNotMatch(text, /← subagent: You are the nested SYNC child/);
	});
});
