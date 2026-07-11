import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyForegroundProgress } from "../../src/dispatch/executor-helpers.ts";
import type { AgentProgress } from "../../src/protocol/types.ts";

function makeProgress(overrides: Partial<AgentProgress> = {}): AgentProgress {
	return {
		index: 7,
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

describe("applyForegroundProgress", () => {
	it("copies every live progress field onto the foreground control", () => {
		const control: Record<string, unknown> = {};
		const progress = makeProgress();

		applyForegroundProgress(control as never, "fixer", 2, progress, "the final output");

		// caller-resolved fields (diverge per site)
		assert.equal(control.currentAgent, "fixer");
		assert.equal(control.currentIndex, 2);
		assert.equal(control.finalOutput, "the final output");
		// copied straight from the progress snapshot
		assert.equal(control.currentAgentColor, 51);
		assert.equal(control.currentActivityState, "tool_running");
		assert.equal(control.lastActivityAt, 1111);
		assert.equal(control.currentTool, "read");
		assert.equal(control.currentToolStartedAt, 1000);
		assert.equal(control.phase, "streaming_text");
		assert.equal(control.phaseStartedAt, 900);
		assert.equal(control.lastToolEndAt, 1050);
		assert.deepEqual(control.recentTools, [{ tool: "read", args: "render.ts", endMs: 1050 }]);
		assert.deepEqual(control.recentOutput, ["line one", "line two"]);
		assert.equal(typeof control.updatedAt, "number");
	});

	it("clears live fields when progress is undefined (only caller-resolved fields remain)", () => {
		// Seed EVERY copied field stale so a regression that preserves any of them is caught.
		const control: Record<string, unknown> = {
			currentAgent: "stale-agent",
			currentAgentColor: 99,
			currentIndex: 42,
			currentActivityState: "tool_running",
			lastActivityAt: 5555,
			currentTool: "stale-tool",
			currentToolStartedAt: 4444,
			phase: "stale-phase",
			phaseStartedAt: 3333,
			lastToolEndAt: 2222,
			recentTools: [{ tool: "old", args: "", endMs: 0 }],
			recentOutput: ["stale line"],
			finalOutput: "stale output",
		};

		applyForegroundProgress(control as never, "operator", 0, undefined, undefined);

		// caller-resolved fields update
		assert.equal(control.currentAgent, "operator");
		assert.equal(control.currentIndex, 0);
		// every progress-sourced field is cleared (no stale value survives)
		assert.equal(control.currentAgentColor, undefined);
		assert.equal(control.currentActivityState, undefined);
		assert.equal(control.lastActivityAt, undefined);
		assert.equal(control.currentTool, undefined);
		assert.equal(control.currentToolStartedAt, undefined);
		assert.equal(control.phase, undefined);
		assert.equal(control.phaseStartedAt, undefined);
		assert.equal(control.lastToolEndAt, undefined);
		assert.equal(control.recentTools, undefined);
		assert.equal(control.recentOutput, undefined);
		assert.equal(control.finalOutput, undefined);
	});
});
