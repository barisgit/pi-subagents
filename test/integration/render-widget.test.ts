import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";

const { buildWidgetLines, renderWidget, stopWidgetAnimation } = await import("../../src/surfaces/render-widget.ts") as unknown as {
	buildWidgetLines: (jobs: Array<Record<string, unknown>>, theme: { fg(name: string, text: string): string; bold(text: string): string }, width?: number) => string[];
	renderWidget: (ctx: Record<string, unknown>, jobs: Array<Record<string, unknown>>) => void;
	stopWidgetAnimation: () => void;
};
const { stopResultAnimations, syncResultAnimation } = await import("../../src/surfaces/render-result.ts") as unknown as {
	stopResultAnimations: () => void;
	syncResultAnimation: (result: Record<string, unknown>, context: { state: { subagentResultAnimationTimer?: ReturnType<typeof setInterval> }; invalidate: () => void }) => void;
};

const theme = {
	fg: (_name: string, text: string) => text,
	bold: (text: string) => text,
};

let testsRun = 0;
afterEach(() => { testsRun++; });
after(() => { process.stdout.write(`# tests ${testsRun}\n`); });

function createUiContext() {
	const widgets: unknown[] = [];
	let renderRequests = 0;
	const ctx = {
		hasUI: true,
		ui: {
			theme,
			setWidget: (_key: string, value: unknown) => {
				widgets.push(value);
				if (typeof value === "function") value({ requestRender: () => { renderRequests += 1; } }, theme);
			},
			requestRender: () => {
				renderRequests += 1;
			},
		},
	};
	return {
		ctx,
		widgets,
		get renderRequests() {
			return renderRequests;
		},
	};
}

describe("subagent async widget rendering", () => {
	it("returns empty for no jobs", () => {
		assert.deepEqual(buildWidgetLines([], theme, 120), []);
	});

	it("renders one row per job under the header", () => {
		const lines = buildWidgetLines([
			{ asyncId: "run-1", asyncDir: "/tmp/1", status: "running", agents: ["scout"], currentAgent: "scout" },
			{ asyncId: "run-2", asyncDir: "/tmp/2", status: "running", agents: ["planner"], currentAgent: "planner" },
			{ asyncId: "queued-1", asyncDir: "/tmp/q", status: "queued", agents: ["reviewer"], currentAgent: "reviewer" },
		], theme, 200);

		// header + 3 job rows + trailing blank for vertical breathing room.
		assert.equal(lines.length, 5);
		assert.ok(lines[0]!.includes("Agents"), "header should include 'Agents'");
		assert.match(lines[1]!, /scout/);
		assert.match(lines[2]!, /planner/);
		assert.match(lines[3]!, /reviewer/);
		assert.equal(lines[4], "", "trailing newline");
	});

	it("tints real async agent names by their configured color (widget had no fallback)", () => {
		// Regression: job.agentColor(s) are never populated by the async start event or
		// status.json, and unlike the dashboard the widget had no colorForAgentName
		// fallback -- so async agent names rendered uncolored. tintAgentName emits the
		// ANSI escape directly (bypassing theme.fg), so a color-stripping theme still
		// preserves the tint. explorer=cyan(51), fixer=green(76).
		const cyan = "\u001b[38;5;51m";
		const green = "\u001b[38;5;76m";
		const single = buildWidgetLines([
			{ asyncId: "r-single", asyncDir: "/tmp/s", status: "running", agents: ["explorer"], currentAgent: "explorer" },
		], theme, 200);
		assert.ok(single[1]!.includes(`${cyan}explorer`), "single async explorer name should be tinted cyan");

		const mixed = buildWidgetLines([
			{ asyncId: "r-par", asyncDir: "/tmp/p", status: "running", mode: "parallel", agents: ["explorer", "fixer"], currentAgent: "explorer" },
		], theme, 200);
		assert.ok(mixed[1]!.includes(`${cyan}explorer`), "parallel explorer piece should be tinted cyan");
		assert.ok(mixed[1]!.includes(`${green}fixer`), "parallel fixer piece should be tinted green");
	});

	it("caps visible rows at MAX_WIDGET_JOBS and adds an overflow line", () => {
		const jobs = Array.from({ length: 7 }, (_, i) => ({
			asyncId: `run-${i}`,
			asyncDir: `/tmp/${i}`,
			status: "running" as const,
			agents: [`agent${i}`],
			currentAgent: `agent${i}`,
		}));
		const lines = buildWidgetLines(jobs, theme, 200);
		// header + 4 visible + 1 overflow line + 1 trailing blank = 7.
		assert.equal(lines.length, 7);
		assert.match(lines[5]!, /\+3 more/);
		assert.equal(lines[6], "");
	});

	it("appends a caller-provided label to job rows when present", () => {
		const lines = buildWidgetLines([
			{ asyncId: "run-labeled", asyncDir: "/tmp/labeled", status: "running", agents: ["scout"], currentAgent: "scout", label: "fix null check" },
			{ asyncId: "run-plain", asyncDir: "/tmp/plain", status: "running", agents: ["planner"], currentAgent: "planner" },
		], theme, 200);
		assert.match(lines[1]!, /fix null check/, "labeled row should include the caller-provided label");
		assert.doesNotMatch(lines[2]!, /fix null check/);
	});

	it("shows completed counts for running parallel jobs", () => {
		const lines = buildWidgetLines([
			{
				asyncId: "parallel-progress",
				asyncDir: "/tmp/parallel-progress",
				status: "running",
				mode: "parallel",
				agents: ["review", "review", "review", "review", "review"],
				stepsTotal: 5,
				currentStep: 0,
				stepStatuses: ["complete", "running", "complete", "failed", "running"],
			},
		], theme, 200);

		assert.match(lines[1]!, /parallel 3\/5/);
		assert.doesNotMatch(lines[1]!, /parallel 1\/5/);
	});

	it("renders explicit display state labels for running jobs", () => {
		const lines = buildWidgetLines([
			{ asyncId: "lost", asyncDir: "/tmp/lost", status: "running", displayState: "lost", agents: ["lost"], currentAgent: "lost", startedAt: 10 },
			{ asyncId: "tool", asyncDir: "/tmp/tool", status: "running", displayState: "tool_running", currentTool: "bash", agents: ["tool"], currentAgent: "tool", startedAt: 20 },
		], theme, 200);

		assert.match(lines[1]!, /tool bash|lost/);
		assert.match(lines.join("\n"), /lost/);
		assert.match(lines.join("\n"), /tool bash/);
	});

	it("pins needs_attention rows to the top of the running bucket", () => {
		const lines = buildWidgetLines([
			{ asyncId: "calm", asyncDir: "/tmp/a", status: "running", agents: ["calm"], currentAgent: "calm" },
			{ asyncId: "alert", asyncDir: "/tmp/b", status: "running", agents: ["alert"], currentAgent: "alert", activityState: "needs_attention" },
		], theme, 200);

		// header + 2 rows + trailing blank.
		assert.equal(lines.length, 4);
		assert.match(lines[1]!, /alert/, "needs_attention row should come first");
		assert.match(lines[2]!, /calm/);
		assert.equal(lines[3], "");
	});

	it("orders and indents child jobs under their parent", () => {
		const lines = buildWidgetLines([
			{ asyncId: "child", parentRunId: "parent", asyncDir: "/tmp/child", status: "running", agents: ["child"], currentAgent: "child", startedAt: 200 },
			{ asyncId: "parent", asyncDir: "/tmp/parent", status: "running", agents: ["parent"], currentAgent: "parent", startedAt: 100 },
			{ asyncId: "sibling", asyncDir: "/tmp/sibling", status: "running", agents: ["sibling"], currentAgent: "sibling", startedAt: 300 },
		], theme, 200);
		const joined = lines.join("\n");
		assert.ok(joined.indexOf("parent") < joined.indexOf("child"), joined);
		assert.match(lines.find((line) => line.includes("child")) ?? "", /├─|└─/);
	});

	it("renders child-only jobs at top level and preserves overflow", () => {
		const jobs = Array.from({ length: 5 }, (_, i) => ({ asyncId: `run-${i}`, parentRunId: i === 0 ? "missing" : undefined, asyncDir: `/tmp/${i}`, status: "running", agents: [`agent${i}`], currentAgent: `agent${i}`, startedAt: i }));
		const lines = buildWidgetLines(jobs, theme, 200);
		assert.match(lines[1]!, /agent4/);
		assert.match(lines.at(-2) ?? "", /\+1 more/);
	});

	it("does not animate queued-only widgets", async () => {
		const ui = createUiContext();
		try {
			renderWidget(ui.ctx as never, [{ asyncId: "queued-only", asyncDir: "/tmp/queued", status: "queued", agents: ["planner"] }]);
			const initialWidgetCount = ui.widgets.length;
			await new Promise((resolve) => setTimeout(resolve, 190));
			assert.equal(ui.widgets.length, initialWidgetCount, "static queued widget should not refresh at animation cadence");
			assert.equal(ui.renderRequests, 0);
		} finally {
			stopWidgetAnimation();
		}
	});

	it("invalidates running result rows and stops after completion", async () => {
		let invalidations = 0;
		const context = {
			state: {} as { subagentResultAnimationTimer?: ReturnType<typeof setInterval> },
			invalidate: () => {
				invalidations += 1;
			},
		};
		try {
			syncResultAnimation({
				content: [{ type: "text", text: "running" }],
				details: {
					mode: "parallel",
					results: [{ agent: "scout", task: "scan", exitCode: 0, progress: { status: "running" } }],
				},
			}, context);
			await new Promise((resolve) => setTimeout(resolve, 190));
			assert.ok(invalidations > 0, "running result should request row redraws");
			assert.ok(context.state.subagentResultAnimationTimer, "running result should store its timer handle");
			stopResultAnimations();
			assert.equal(context.state.subagentResultAnimationTimer, undefined, "global cleanup should clear row timer state");

			syncResultAnimation({
				content: [{ type: "text", text: "running again" }],
				details: {
					mode: "parallel",
					results: [{ agent: "scout", task: "scan", exitCode: 0, progress: { status: "running" } }],
				},
			}, context);
			assert.ok(context.state.subagentResultAnimationTimer, "running result should restart after global cleanup");

			syncResultAnimation({
				content: [{ type: "text", text: "done" }],
				details: {
					mode: "parallel",
					results: [{ agent: "scout", task: "scan", exitCode: 0, progress: { status: "completed" } }],
				},
			}, context);
			const afterComplete = invalidations;
			await new Promise((resolve) => setTimeout(resolve, 190));
			assert.equal(invalidations, afterComplete, "completed result should stop row redraws");
			assert.equal(context.state.subagentResultAnimationTimer, undefined);
		} finally {
			stopResultAnimations();
		}
	});

	it("animates while active and stops after the widget is cleared", async () => {
		const ui = createUiContext();
		try {
			renderWidget(ui.ctx as never, [{ asyncId: "run-anim", asyncDir: "/tmp/run", status: "running", agents: ["scout"] }]);
			// Widget is now installed via a factory: a single setWidget call registers
			// the component, and the animation loop just calls requestRender(). So we
			// assert renderRequests grow instead of widgets growing.
			assert.equal(ui.widgets.length, 1, "factory should be registered exactly once");
			const initialRenderRequests = ui.renderRequests;
			await new Promise((resolve) => setTimeout(resolve, 190));
			assert.ok(ui.renderRequests > initialRenderRequests, "animation should request UI renders");

			renderWidget(ui.ctx as never, []);
			const clearedRenderRequests = ui.renderRequests;
			await new Promise((resolve) => setTimeout(resolve, 190));
			assert.equal(ui.renderRequests, clearedRenderRequests, "cleared widget should stop animating");
			assert.equal(ui.widgets.at(-1), undefined, "clearing should send undefined");
		} finally {
			stopWidgetAnimation();
		}
	});
	it("lost glyph wins over a frozen active phase (force-killed run)", () => {
		// Regression: a force-killed run leaves a stale active phase (e.g. 'thinking')
		// frozen in status.json. The runner heartbeat goes stale so displayState is
		// 'lost' — that must win over the frozen phase, otherwise a dead run renders
		// as a live spinner with a ticking phase clock.
		const lines = buildWidgetLines([
			{
				asyncId: "active-phase",
				asyncDir: "/tmp/active-phase",
				status: "running",
				displayState: "lost",
				phase: "thinking",
				phaseStartedAt: Date.now() - 12_000,
				agents: ["thinker"],
				currentAgent: "thinker",
			},
		], theme, 200);
		const row = lines.find((line) => line.includes("thinker")) ?? "";

		assert.match(row, /! .*thinker/);
		assert.match(row, /lost/);
		assert.doesNotMatch(row, /thinking 12\.0s/);
	});

	it("phase label keeps the lost glyph for stale unknown-phase jobs", () => {
		const lines = buildWidgetLines([
			{
				asyncId: "unknown-phase",
				asyncDir: "/tmp/unknown-phase",
				status: "running",
				displayState: "lost",
				phase: "unknown_phase",
				runnerHeartbeatAt: Date.now() - 30_000,
				agents: ["legacy"],
				currentAgent: "legacy",
			},
		], theme, 200);
		const row = lines.find((line) => line.includes("legacy")) ?? "";

		assert.match(row, /! .*legacy/);
		assert.match(row, /lost/);
	});

	it("renders a workflow as one row and hides its children", () => {
		const lines = buildWidgetLines([
			{ asyncId: "wf-group", asyncDir: "/tmp/wf", status: "running", kind: "workflow", agents: ["workflow"], label: "Phase 2: verify", currentStep: 1, stepsTotal: 3, startedAt: Date.now() - 5000 },
			{ asyncId: "wf-child-a", asyncDir: "/tmp/wf/a", status: "running", parentRunId: "wf-group", agents: ["explorer"], currentAgent: "explorer" },
			{ asyncId: "wf-child-b", asyncDir: "/tmp/wf/b", status: "complete", parentRunId: "wf-group", agents: ["qa"], currentAgent: "qa" },
			{ asyncId: "other-1", asyncDir: "/tmp/o", status: "running", agents: ["fixer"], currentAgent: "fixer" },
		], theme, 200);
		const body = lines.join("\n");

		assert.match(body, /workflow/, "workflow group row renders");
		assert.match(body, /Phase 2: verify/, "group row carries the current phase label");
		assert.match(body, /1\/3/, "group row carries children-derived progress");
		assert.doesNotMatch(body, /explorer/, "workflow children must not render as widget rows");
		assert.doesNotMatch(body, /\bqa\b/, "workflow children must not render as widget rows");
		assert.match(body, /fixer/, "non-workflow jobs render normally");
		// header + workflow row + fixer row + trailing blank.
		assert.equal(lines.length, 4, "exactly one row for the workflow, one for the plain job");
	});

	it("keeps children of non-workflow parents visible and hides the container", () => {
		const lines = buildWidgetLines([
			{ asyncId: "par-group", asyncDir: "/tmp/p", status: "running", mode: "parallel", agents: ["explorer", "qa"] },
			{ asyncId: "par-child", asyncDir: "/tmp/p/c", status: "running", parentRunId: "par-group", agents: ["explorer"], currentAgent: "explorer" },
		], theme, 200);
		const body = lines.join("\n");

		assert.match(body, /explorer/, "plain parallel children stay visible");
		assert.doesNotMatch(body, /qa/, "plain parallel container is hidden");
		const childLine = lines.find((line) => line.includes("explorer")) ?? "";
		assert.doesNotMatch(childLine, /  [├└]─/, "child renders at top-level widget depth");
	});

	it("keeps a single (non-parallel) parent visible when it has child rows", () => {
		const lines = buildWidgetLines([
			{ asyncId: "single-parent", asyncDir: "/tmp/s", status: "running", mode: "single", agents: ["oracle"], currentAgent: "oracle" },
			{ asyncId: "nested-child", asyncDir: "/tmp/s/c", status: "running", parentRunId: "single-parent", agents: ["explorer"], currentAgent: "explorer" },
		], theme, 200);
		const body = lines.join("\n");

		assert.match(body, /oracle/, "a single async run that spawned a child still renders");
		assert.match(body, /explorer/, "its child renders too");
	});

});
