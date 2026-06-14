import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createForegroundRunController } from "../../src/dispatch/foreground-run-controller.ts";
import type { AgentProgress } from "../../src/protocol/types.ts";

function makeProgress(overrides: Partial<AgentProgress> = {}): AgentProgress {
	return {
		index: 0,
		agent: "explorer",
		status: "running",
		activityState: "tool_running",
		task: "trace the run tree",
		lastActivityAt: 1111,
		currentTool: "read",
		currentToolStartedAt: 1000,
		phase: "streaming_text",
		phaseStartedAt: 900,
		lastToolEndAt: 1050,
		recentTools: [{ tool: "read", args: "render.ts", endMs: 1050 }],
		recentOutput: ["line one", "line two"],
		color: 51,
		...overrides,
	} as AgentProgress;
}

describe("createForegroundRunController", () => {
	it("drives a control through start -> progress -> needs_attention -> complete", () => {
		const control: Record<string, unknown> = {};
		const fg = createForegroundRunController(control as never);

		// start step
		const interrupt = () => true;
		fg.beginStep("fixer", 2, interrupt);
		assert.equal(control.currentAgent, "fixer");
		assert.equal(control.currentIndex, 2);
		assert.equal(control.currentActivityState, undefined);
		assert.equal(control.interrupt, interrupt);
		assert.equal(typeof control.updatedAt, "number");

		// progress copies the snapshot fields
		fg.applyProgress("fixer", 2, makeProgress(), "interim output");
		assert.equal(control.currentActivityState, "tool_running");
		assert.equal(control.lastActivityAt, 1111);
		assert.equal(control.currentTool, "read");
		assert.equal(control.currentToolStartedAt, 1000);
		assert.equal(control.phase, "streaming_text");
		assert.equal(control.phaseStartedAt, 900);
		assert.equal(control.lastToolEndAt, 1050);
		assert.deepEqual(control.recentTools, [{ tool: "read", args: "render.ts", endMs: 1050 }]);
		assert.deepEqual(control.recentOutput, ["line one", "line two"]);
		assert.equal(control.currentAgentColor, 51);
		assert.equal(control.finalOutput, "interim output");

		// needs_attention clears only activity (interrupt closure stays installed)
		fg.markNeedsAttention();
		assert.equal(control.currentActivityState, undefined);
		assert.equal(control.interrupt, interrupt);

		// complete copies the final snapshot subset and clears interrupt
		const finalProgress = makeProgress({
			activityState: "needs_attention",
			lastActivityAt: 2222,
			currentTool: "write",
			currentToolStartedAt: 2000,
			phase: "finishing",
			phaseStartedAt: 1900,
			lastToolEndAt: 2100,
			recentTools: [{ tool: "write", args: "x.ts", endMs: 2100 }],
			recentOutput: ["final line"],
		});
		fg.finalizeStep(2, { progress: finalProgress, finalOutput: "the final output" });
		assert.equal(control.interrupt, undefined);
		assert.equal(control.currentActivityState, "needs_attention");
		assert.equal(control.lastActivityAt, 2222);
		assert.equal(control.currentTool, "write");
		assert.equal(control.currentToolStartedAt, 2000);
		assert.equal(control.phase, "finishing");
		assert.equal(control.phaseStartedAt, 1900);
		assert.equal(control.lastToolEndAt, 2100);
		assert.deepEqual(control.recentTools, [{ tool: "write", args: "x.ts", endMs: 2100 }]);
		assert.deepEqual(control.recentOutput, ["final line"]);
		assert.equal(control.finalOutput, "the final output");
	});

	it("finalizeStep without final only clears interrupt (parallel case)", () => {
		const control: Record<string, unknown> = {};
		const fg = createForegroundRunController(control as never);
		fg.beginStep("fixer", 1, () => true);
		fg.applyProgress("fixer", 1, makeProgress(), undefined);

		fg.finalizeStep(1);

		assert.equal(control.interrupt, undefined);
		// activity fields are NOT touched when final is omitted
		assert.equal(control.currentActivityState, "tool_running");
		assert.equal(control.currentTool, "read");
	});

	it("finalizeStep is a no-op when the active index differs", () => {
		const control: Record<string, unknown> = {};
		const fg = createForegroundRunController(control as never);
		const interrupt = () => true;
		fg.beginStep("fixer", 3, interrupt);

		fg.finalizeStep(0, { progress: makeProgress(), finalOutput: "x" });

		// index mismatch -> control untouched
		assert.equal(control.interrupt, interrupt);
		assert.equal(control.finalOutput, undefined);
	});

	it("installs an interrupt mid-run that clears activity and returns true", () => {
		const control: Record<string, unknown> = {};
		const fg = createForegroundRunController(control as never);
		let aborted = false;
		fg.beginStep("fixer", 0, () => {
			aborted = true;
			control.currentActivityState = undefined;
			control.updatedAt = Date.now();
			return true;
		});
		fg.applyProgress("fixer", 0, makeProgress(), undefined);
		assert.equal(control.currentActivityState, "tool_running");

		const result = (control.interrupt as () => boolean)();

		assert.equal(result, true);
		assert.equal(aborted, true);
		assert.equal(control.currentActivityState, undefined);
	});

	it("invokes the mirror callback on applyProgress when provided", () => {
		const control: Record<string, unknown> = {};
		const calls: Array<{ index: number; finalOutput: string | undefined }> = [];
		const fg = createForegroundRunController(control as never, {
			mirror: (firstProgress, index, finalOutput) => {
				assert.equal(firstProgress?.agent, "explorer");
				calls.push({ index, finalOutput });
			},
		});
		fg.beginStep("fixer", 4, () => true);
		fg.applyProgress("fixer", 4, makeProgress(), "out");

		assert.deepEqual(calls, [{ index: 4, finalOutput: "out" }]);
	});

	it("does not invoke any mirror when omitted", () => {
		const control: Record<string, unknown> = {};
		const fg = createForegroundRunController(control as never);
		// applyProgress must not throw without a mirror
		fg.beginStep("fixer", 0, () => true);
		fg.applyProgress("fixer", 0, makeProgress(), "out");
		assert.equal(control.finalOutput, "out");
	});

	it("is a no-op at every method when control is undefined", () => {
		const mirror = () => assert.fail("mirror must not fire when control is undefined");
		const fg = createForegroundRunController(undefined, { mirror });
		// none of these should throw
		fg.beginStep("fixer", 0, () => true);
		fg.applyProgress("fixer", 0, makeProgress(), "out");
		fg.markNeedsAttention();
		fg.finalizeStep(0, { progress: makeProgress(), finalOutput: "x" });
		fg.finalizeStep(0);
	});
});
