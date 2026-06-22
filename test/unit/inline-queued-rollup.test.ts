import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { countQueuedInlineChildren } from "../../src/surfaces/render-inline.ts";
import { renderSubagentResult } from "../../src/surfaces/render-result.ts";
import { rmRun, writeRun } from "./inline-nested-helpers.ts";

const theme = {
	fg: (_name: string, text: string) => text,
	bold: (text: string) => text,
} as never;
const usage = { input: 0, output: 0, total: 0 };

const ids = [
	"inline-queued-parent",
	"inline-queued-run-1",
	"inline-queued-run-2",
	"inline-queued-q1",
	"inline-queued-q2",
];

afterEach(() => ids.forEach(rmRun));

describe("countQueuedInlineChildren", () => {
	it("counts only direct children still in the queued state", () => {
		writeRun(ids[0]!);
		writeRun(ids[1]!, { parentRunId: ids[0], state: "running", agent: "fixer" });
		writeRun(ids[2]!, { parentRunId: ids[0], state: "running", agent: "explorer" });
		writeRun(ids[3]!, { parentRunId: ids[0], state: "queued", agent: "fixer" });
		writeRun(ids[4]!, { parentRunId: ids[0], state: "queued", agent: "explorer" });
		assert.equal(countQueuedInlineChildren(ids[0]!), 2);
	});

	it("excludes children already rendered as their own rows via the used set", () => {
		writeRun(ids[0]!);
		writeRun(ids[3]!, { parentRunId: ids[0], state: "queued", agent: "fixer" });
		writeRun(ids[4]!, { parentRunId: ids[0], state: "queued", agent: "explorer" });
		assert.equal(countQueuedInlineChildren(ids[0]!, new Set([ids[3]!])), 1);
	});
});

describe("inline +N queued rollup rendering", () => {
	it("renders +N queued when ALL of a parent's children are queued and none are running", () => {
		// Pool saturated by other parents: this parent's children are all queued, with one
		// sibling already settled, so no result is running (hasRunning === false). The
		// rollup must still surface the queued children (the bug gated it on hasRunning).
		writeRun(ids[0]!);
		writeRun(ids[3]!, { parentRunId: ids[0], state: "queued", agent: "fixer" });
		writeRun(ids[4]!, { parentRunId: ids[0], state: "queued", agent: "explorer" });
		const widget = renderSubagentResult(
			{
				content: [{ type: "text", text: "(running...)" }],
				details: {
					mode: "parallel",
					runId: ids[0],
					results: [
						{
							agent: "settled-agent",
							task: "already done",
							exitCode: 0,
							messages: [],
							usage,
							progress: {
								index: 0,
								agent: "settled-agent",
								status: "completed",
								task: "already done",
								recentTools: [],
								recentOutput: [],
								toolCount: 0,
								tokens: 0,
								durationMs: 10,
							},
						},
					],
				},
			},
			{ expanded: false },
			theme,
		);
		const text = widget.render(140).join("\n");
		assert.match(text, /\+2 queued/);
	});
});
