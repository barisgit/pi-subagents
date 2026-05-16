import assert from "node:assert/strict";
import { describe, it } from "node:test";

const { buildWidgetLines, renderWidget, stopResultAnimations, stopWidgetAnimation, syncResultAnimation } = await import("../../render.ts") as {
	buildWidgetLines: (jobs: Array<Record<string, unknown>>, theme: { fg(name: string, text: string): string; bold(text: string): string }, width?: number) => string[];
	renderWidget: (ctx: Record<string, unknown>, jobs: Array<Record<string, unknown>>) => void;
	stopResultAnimations: () => void;
	stopWidgetAnimation: () => void;
	syncResultAnimation: (result: Record<string, unknown>, context: { state: { subagentResultAnimationTimer?: ReturnType<typeof setInterval> }; invalidate: () => void }) => void;
};

const theme = {
	fg: (_name: string, text: string) => text,
	bold: (text: string) => text,
};

function createUiContext() {
	const widgets: unknown[] = [];
	let renderRequests = 0;
	const ctx = {
		hasUI: true,
		ui: {
			theme,
			setWidget: (_key: string, value: unknown) => {
				widgets.push(value);
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
			state: {},
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
});
