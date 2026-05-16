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

	it("shows header and summary with running and queued counts", () => {
		const lines = buildWidgetLines([
			{ asyncId: "run-1", asyncDir: "/tmp/1", status: "running", agents: ["scout"] },
			{ asyncId: "run-2", asyncDir: "/tmp/2", status: "running", agents: ["planner"] },
			{ asyncId: "queued-1", asyncDir: "/tmp/q", status: "queued", agents: ["reviewer"] },
		], theme, 120);

		assert.equal(lines.length, 2);
		assert.ok(lines[0]!.includes("Agents"), "header should include 'Agents'");
		assert.match(lines[1]!, /2 running/);
		assert.match(lines[1]!, /1 queued/);
	});

	it("shows need-attention count when any running job is in needs_attention", () => {
		const lines = buildWidgetLines([
			{ asyncId: "run-1", asyncDir: "/tmp/1", status: "running", agents: ["scout"], activityState: "needs_attention" },
		], theme, 120);

		assert.equal(lines.length, 2);
		assert.match(lines[1]!, /1 need attention/);
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
			const initialWidgetCount = ui.widgets.length;
			await new Promise((resolve) => setTimeout(resolve, 190));
			assert.ok(ui.widgets.length > initialWidgetCount, "animation should refresh widget lines");
			assert.ok(ui.renderRequests > 0, "animation should request UI renders");

			renderWidget(ui.ctx as never, []);
			const afterClearCount = ui.widgets.length;
			await new Promise((resolve) => setTimeout(resolve, 190));
			assert.equal(ui.widgets.length, afterClearCount, "cleared widget should stop animating");
			assert.equal(ui.widgets.at(-1), undefined);
		} finally {
			stopWidgetAnimation();
		}
	});
});
