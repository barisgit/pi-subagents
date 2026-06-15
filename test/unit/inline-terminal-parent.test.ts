import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { renderSubagentResult } from "../../src/surfaces/render-result.ts";
import { rmRun, tool, writeRun } from "./inline-nested-helpers.ts";

const parent = "inline-terminal-parent";
const child = "inline-terminal-child";
const childTask = "You are the nested SYNC child. Summarize terminal work.";

const theme = {
	fg: (_name: string, text: string) => text,
	bold: (text: string) => text,
} as never;
const usage = { input: 0, output: 0, total: 0 };

afterEach(() => [parent, child].forEach(rmRun));

describe("terminal parent inline nesting", () => {
	it("summarises completed sync children in the header tally without re-expanding the child card", () => {
		writeRun(child, {
			parentRunId: parent,
			state: "complete",
			agent: "fixer",
			label: "finished child",
			tokens: 2048,
			startedAt: 1_000,
			endedAt: 2_500,
			events: [tool("read", { path: "/tmp/a" })],
		});
		const widget = renderSubagentResult(
			{
				content: [{ type: "text", text: "done" }],
				details: {
					mode: "single",
					runId: parent,
					results: [
						{
							agent: "parent",
							task: "parent task",
							exitCode: 0,
							messages: [],
							usage,
							progress: {
								index: 0,
								agent: "parent",
								status: "completed",
								task: "parent task",
								recentTools: [
									{
										tool: "subagent",
										args: childTask,
										rawArgs: { agent: "fixer", task: childTask, label: "finished child" },
										endMs: 2_500,
									},
								],
								recentOutput: [],
								toolCount: 1,
								tokens: 0,
								durationMs: 2_500,
							},
						},
					],
				},
			},
			{ expanded: false },
			theme,
		);

		const text = widget.render(120).join("\n");
		// Header tail now carries the child tally; the full child card is no longer
		// re-expanded on completion (dashboard / right pane is the source of truth).
		assert.match(text, /· 1 subagent\b/);
		assert.doesNotMatch(text, /✓ subagent: finished child/);
		assert.doesNotMatch(text, /← subagent: You are the nested SYNC child/);
	});
});
