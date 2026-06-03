import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { renderNestedChild, renderSubagentResult } from "../../render.ts";
import { rmRun, tool, writeRun } from "./inline-nested-helpers.ts";

const ids = [
	"inline-dr-orch",
	"inline-dr-fixer",
	"inline-dr-explorer",
	"inline-dr-breadth",
];

const theme = {
	fg: (_name: string, text: string) => text,
	bold: (text: string) => text,
} as never;
const usage = { input: 0, output: 0, total: 0 };

afterEach(() => ids.forEach(rmRun));

describe("inline double-render guard", () => {
	it("does not re-render a parallel row as its own nested child", () => {
		// True tree: orchestrator -> fixer (row) -> explorer (fixer's child).
		// The fixer row's on-disk run records a subagent call to explorer using the
		// real args shape { run: [{ agent, task }] } (agent/label under run[0]).
		writeRun(ids[1]!, {
			parentRunId: ids[0],
			agent: "fixer",
			label: "nest-A",
			events: [tool("subagent", { run: [{ agent: "explorer", task: "go deep" }] }, 1_100)],
		});
		writeRun(ids[2]!, {
			parentRunId: ids[1],
			agent: "explorer",
			label: "explorer",
			events: [tool("read", { path: "/tmp/x" }), tool("bash", { command: "ls" })],
		});

		const widget = renderSubagentResult({
			content: [{ type: "text", text: "(running...)" }],
			details: {
				mode: "parallel",
				runId: ids[0],
				results: [{
					agent: "fixer",
					task: "drive nest-A",
					label: "nest-A",
					exitCode: 0,
					messages: [],
					usage,
					progress: {
						index: 0,
						agent: "fixer",
						status: "running",
						task: "drive nest-A",
						recentTools: [{ tool: "subagent", args: "go deep", rawArgs: { run: [{ agent: "explorer", task: "go deep" }] }, endMs: Date.now() }],
						recentOutput: [],
						toolCount: 1,
						tokens: 0,
						durationMs: 100,
					},
				}],
			},
		}, { expanded: false }, theme);

		const text = widget.render(140).join("\n");
		// The fixer appears only as the row header ("Agent 1: fixer"), never re-rendered
		// as a nested "subagent: fixer" child of itself.
		assert.doesNotMatch(text, /subagent: fixer/);
		// The explorer (the fixer's real child) is expanded exactly once.
		const explorerLines = text.split("\n").filter((l) => /subagent: explorer/.test(l));
		assert.equal(explorerLines.length, 1, `expected one explorer line, got ${explorerLines.length}:\n${text}`);
	});

	it("collapses a nested child with many tools to a single rolled-up line", () => {
		const events = Array.from({ length: 10 }, (_, i) => tool("read", { path: `/tmp/f${i}` }, 1_000 + i));
		writeRun(ids[3]!, { parentRunId: undefined, agent: "explorer", label: "many-tools", events });
		const lines = renderNestedChild(ids[3]!, 1, { agent: "explorer", label: "many-tools" });
		// The inline widget is a glance: a nested child renders as ONE line regardless of
		// how many tools it ran. No per-tool `read:` lines leak into the parent card.
		assert.equal(lines.length, 1, `expected exactly one line, got ${lines.length}:\n${lines.join("\n")}`);
		assert.match(lines[0]!, /subagent: explorer · many-tools · 10 tools/);
		assert.doesNotMatch(lines[0]!, /read: /);
	});
});
