import assert from "node:assert/strict";
import { describe, it } from "node:test";

type RenderSubagentResult = (
	result: {
		content: Array<{ type: "text"; text: string }>;
		details?: {
			mode: "single" | "parallel" | "workflow" | "management";
			context?: "fresh" | "fork";
			results: unknown[];
			agentGroups?: string[];
			totalSteps?: number;
			expectedAgents?: number;
			currentStepIndex?: number;
			progressSummary?: { toolCount: number; tokens: number; durationMs: number };
		};
	},
	options: { expanded: boolean },
	theme: {
		fg(name: string, text: string): string;
		bold(text: string): string;
	},
) => { render(width: number): string[] };

let renderSubagentResult: RenderSubagentResult | undefined;
({ renderSubagentResult } = (await import("../../src/surfaces/render-result.ts")) as unknown as {
	renderSubagentResult?: RenderSubagentResult;
});

const theme = {
	fg: (_name: string, text: string) => text,
	bold: (text: string) => text,
};

const emptyUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };

function withTerminalWidth<T>(columns: number, fn: () => T): T {
	const original = process.stdout.columns;
	Object.defineProperty(process.stdout, "columns", {
		value: columns,
		configurable: true,
	});
	try {
		return fn();
	} finally {
		Object.defineProperty(process.stdout, "columns", {
			value: original,
			configurable: true,
		});
	}
}

describe("renderSubagentResult fork indicator", () => {
	it("shows [fork] when details are empty but context is fork", () => {
		const widget = renderSubagentResult!(
			{
				content: [{ type: "text", text: "Async: reviewer [abc123]" }],
				details: { mode: "single", context: "fork", results: [] },
			},
			{ expanded: false },
			theme,
		);

		const text = widget.render(120).join("\n");
		assert.match(text, /\[fork\]/);
	});

	it("renders multiline empty-result management output line by line", () => {
		const widget = withTerminalWidth(80, () =>
			renderSubagentResult!(
				{
					content: [
						{
							type: "text",
							text: "Executable agents:\n- explorer (user): read-only recon with a long description that truncates\n- fixer (user): focused implementation",
						},
					],
					details: { mode: "management", results: [] },
				},
				{ expanded: false },
				theme,
			),
		);

		const text = widget.render(120).join("\n");
		assert.match(text, /Executable agents:/);
		assert.match(text, /- explorer/);
		assert.match(text, /- fixer/);
	});

	it("shows [fork] on single-result header", () => {
		const widget = renderSubagentResult!(
			{
				content: [{ type: "text", text: "done" }],
				details: {
					mode: "single",
					context: "fork",
					results: [
						{
							agent: "reviewer",
							task: "review",
							exitCode: 0,
							messages: [],
							usage: emptyUsage,
						},
					],
				},
			},
			{ expanded: false },
			theme,
		);

		const text = widget.render(120).join("\n");
		assert.match(text, /\[fork\]/);
	});

	it("uses compacted tool-call summaries when messages were stripped", () => {
		const widget = renderSubagentResult!(
			{
				content: [{ type: "text", text: "done" }],
				details: {
					mode: "single",
					results: [
						{
							agent: "reviewer",
							task: "review",
							exitCode: 0,
							messages: undefined,
							toolCalls: [
								{
									text: "$ npm test -- --watch...",
									expandedText: "$ npm test -- --watch --runInBand --reporter=dot",
								},
							],
							usage: emptyUsage,
						},
					],
				},
			},
			{ expanded: true },
			theme,
		);

		const text = widget.render(120).join("\n");
		assert.match(text, /npm test -- --watch --runInBand --reporter=dot/);
	});

	it("shows the full task in expanded mode", () => {
		const longTask =
			"Review the auth flow, trace the race condition, and document the precise failing tool sequence at the end.";
		const collapsed = withTerminalWidth(40, () =>
			renderSubagentResult!(
				{
					content: [{ type: "text", text: "done" }],
					details: {
						mode: "single",
						results: [
							{
								agent: "reviewer",
								task: longTask,
								exitCode: 0,
								messages: [],
								usage: emptyUsage,
							},
						],
					},
				},
				{ expanded: false },
				theme,
			)
				.render(40)
				.join("\n"),
		);

		const expanded = withTerminalWidth(40, () =>
			renderSubagentResult!(
				{
					content: [{ type: "text", text: "done" }],
					details: {
						mode: "single",
						results: [
							{
								agent: "reviewer",
								task: longTask,
								exitCode: 0,
								messages: [],
								usage: emptyUsage,
							},
						],
					},
				},
				{ expanded: true },
				theme,
			)
				.render(40)
				.join("\n"),
		);

		const unwrap = (text: string) => text.replace(/\s+/g, "");
		assert.doesNotMatch(unwrap(collapsed), /precisefailingtoolsequenceattheend\./);
		assert.match(unwrap(expanded), /precisefailingtoolsequenceattheend\./);
	});

	it("uses an agent-first completed title for a sync single result", () => {
		const widget = renderSubagentResult!(
			{
				content: [{ type: "text", text: "done" }],
				details: {
					mode: "single",
					results: [
						{
							agent: "reviewer",
							task: "review",
							exitCode: 0,
							messages: [],
							usage: { ...emptyUsage, turns: 2 },
							progressSummary: { toolCount: 3, tokens: 1200, durationMs: 1500 },
							sessionFile: "/tmp/session.jsonl",
						},
					],
				},
			},
			{ expanded: false },
			theme,
		);

		const text = widget.render(120).join("\n");
		assert.match(text, /^reviewer completed in 1\.5s/);
		assert.doesNotMatch(text, /^✓/);
		assert.match(text, /└─ Done/);
		// 'session:' line was dropped by design — the URL-encoded session path is gunk in this view.
		assert.doesNotMatch(text, /session: \/tmp\/session\.jsonl/);
	});

	it("keeps failure reasons visible in compact rendering", () => {
		const widget = renderSubagentResult!(
			{
				content: [{ type: "text", text: "failed" }],
				details: {
					mode: "single",
					results: [
						{
							agent: "reviewer",
							task: "review",
							exitCode: 1,
							error: "boom",
							messages: [],
							usage: emptyUsage,
						},
					],
				},
			},
			{ expanded: false },
			theme,
		);

		const text = widget.render(120).join("\n");
		assert.match(text, /^✗ reviewer/);
		assert.match(text, /└─ Error: boom/);
	});

	it("shows live detail hints for running subagents", () => {
		const now = Date.now();
		const widget = renderSubagentResult!(
			{
				content: [{ type: "text", text: "(running...)" }],
				details: {
					mode: "single",
					results: [
						{
							agent: "reviewer",
							task: "review",
							exitCode: 0,
							messages: [],
							artifactPaths: {
								outputPath: "/tmp/reviewer_output.md",
							},
							usage: emptyUsage,
							progress: {
								index: 0,
								agent: "reviewer",
								status: "running",
								task: "review",
								lastActivityAt: now - 2_000,
								currentTool: "read",
								currentToolArgs: "package.json",
								currentToolStartedAt: now - 3_000,
								recentTools: [],
								recentOutput: [],
								toolCount: 1,
								tokens: 42,
								durationMs: 3_000,
							},
						},
					],
				},
			},
			{ expanded: false },
			theme,
		);

		const text = widget.render(120).join("\n");
		assert.match(text, /^reviewer \[working\] +\n  review/);
		// Tool is currently executing → "current" line shows the tool with elapsed time.
		assert.match(text, /read: package\.json \| 3\.0s/);
		// While running, the 'output:' line is hidden to keep the row count down;
		// the Ctrl+O hint lives in the status bar instead of inline per-block.
		assert.doesNotMatch(text, /Press Ctrl\+O for live detail/);
		assert.doesNotMatch(text, /output: \/tmp\/reviewer_output\.md/);
	});

	it("keeps paused multi-result runs visible in the compact headline", () => {
		const widget = renderSubagentResult!(
			{
				content: [{ type: "text", text: "paused" }],
				details: {
					mode: "workflow",
					agentGroups: ["worker"],
					results: [
						{
							agent: "worker",
							task: "pause",
							exitCode: 0,
							interrupted: true,
							messages: [],
							usage: emptyUsage,
						},
					],
				},
			},
			{ expanded: false },
			theme,
		);

		const text = widget.render(120).join("\n");
		// The aggregate glyph treats a settled interrupted member as terminal while the member row keeps ■.
		assert.match(text, /^✓ workflow/);
		assert.match(text, /└─ Paused/);
	});

	it("keeps empty-output warnings visible in compact multi-result rendering", () => {
		const widget = renderSubagentResult!(
			{
				content: [{ type: "text", text: "done" }],
				details: {
					mode: "workflow",
					agentGroups: ["worker"],
					results: [
						{
							agent: "worker",
							task: "check without output target",
							exitCode: 0,
							messages: [],
							usage: emptyUsage,
						},
					],
				},
			},
			{ expanded: false },
			theme,
		);

		const text = widget.render(120).join("\n");
		assert.match(text, /└─ Done \(no text output\)/);
		assert.doesNotMatch(text, /0ms/);
	});

	it("keeps pending placeholder steps pending in compact rendering", () => {
		const widget = renderSubagentResult!(
			{
				content: [{ type: "text", text: "running" }],
				details: {
					mode: "workflow",
					agentGroups: ["a", "b"],
					totalSteps: 2,
					currentStepIndex: 0,
					results: [
						{
							agent: "a",
							task: "first",
							exitCode: 0,
							messages: [],
							usage: emptyUsage,
							progress: {
								index: 0,
								agent: "a",
								status: "running",
								task: "first",
								recentTools: [],
								recentOutput: [],
								toolCount: 0,
								tokens: 0,
								durationMs: 0,
							},
						},
						{
							agent: "b",
							task: "second",
							exitCode: 0,
							messages: [],
							usage: emptyUsage,
							progress: {
								index: 1,
								agent: "b",
								status: "pending",
								task: "second",
								recentTools: [],
								recentOutput: [],
								toolCount: 0,
								tokens: 0,
								durationMs: 0,
							},
						},
					],
				},
			},
			{ expanded: false },
			theme,
		);

		const lines = widget.render(120);
		const pendingIndex = lines.findIndex((line) => /Step 2: b/.test(line));
		assert.notEqual(pendingIndex, -1);
		// Pending result rows use the shared queued glyph.
		assert.match(lines[pendingIndex]!, /○ Step 2: b · pending/);
		assert.doesNotMatch(lines[pendingIndex]!, /0ms/);
		assert.doesNotMatch(lines[pendingIndex + 1] ?? "", /Done \(no text output\)/);
	});

	it("uses agent labels and the tracked progress index for live parallel rendering", () => {
		const widget = renderSubagentResult!(
			{
				content: [{ type: "text", text: "(running...)" }],
				details: {
					mode: "parallel",
					totalSteps: 3,
					expectedAgents: 3,
					results: [
						{
							agent: "worker",
							task: "third task",
							exitCode: 0,
							messages: [],
							usage: emptyUsage,
							progress: {
								index: 2,
								agent: "worker",
								status: "running",
								task: "third task",
								recentTools: [],
								recentOutput: [],
								toolCount: 1,
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

		const text = widget.render(120).join("\n");
		assert.match(text, /^Parallel · 3 agents/);
		assert.match(text, /Agent 3: worker/);
		assert.doesNotMatch(text, /Step 3: worker/);
		assert.doesNotMatch(text, /Agent 1: worker/);
	});

	it("summarizes a completed sync parallel result in its title", () => {
		const widget = renderSubagentResult!(
			{
				content: [{ type: "text", text: "done" }],
				details: {
					mode: "parallel",
					results: [
						{ agent: "left", task: "left", exitCode: 0, messages: [], usage: emptyUsage },
						{ agent: "right", task: "right", exitCode: 0, messages: [], usage: emptyUsage },
					],
					progressSummary: { toolCount: 4, tokens: 1200, durationMs: 1500 },
				},
			},
			{ expanded: false },
			theme,
		);

		const text = widget.render(120).join("\n");
		assert.match(text, /^2 agents completed in 1\.5s · 1\.2k tokens/);
	});

	it("renders nested parallel workflow with parent-step counts and ∥ sub-step labels", () => {
		const widget = renderSubagentResult!(
			{
				content: [{ type: "text", text: "done" }],
				details: {
					mode: "workflow",
					// workflow shape: seed -> [left, right] -> tail
					agentGroups: ["explorer", "[explorer+explorer]", "explorer"],
					totalSteps: 4,
					results: [
						{ agent: "explorer", task: "seed", exitCode: 0, messages: [], usage: emptyUsage },
						{ agent: "explorer", task: "left", exitCode: 0, messages: [], usage: emptyUsage },
						{ agent: "explorer", task: "right", exitCode: 0, messages: [], usage: emptyUsage },
						{ agent: "explorer", task: "tail", exitCode: 0, messages: [], usage: emptyUsage },
					],
				},
			},
			{ expanded: false },
			theme,
		);

		const text = widget.render(160).join("\n");
		// Body shows parent-step total (3), not flattened (4)
		assert.match(text, /step 3\/3/);
		// Sub-step labels for the parallel group use parent.child∥ form
		assert.match(text, /Step 2\.1∥/);
		assert.match(text, /Step 2\.2∥/);
		// Sequential bookends keep flat numbering
		assert.match(text, /Step 1:/);
		assert.match(text, /Step 3:/);
		// Must NOT fall back to false-sequential numbering for parallel siblings
		assert.doesNotMatch(text, /Step 4:/);
	});
});
