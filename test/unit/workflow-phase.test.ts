import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createWorkflowPhaseEmitter, runWorkflowScript } from "../../src/workflow/workflow.ts";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { AgentProgress, Details, SingleResult } from "../../src/protocol/types.ts";

describe("workflow phase global (VAL-PHASE)", () => {
	it("emits a progress line through onUpdate without changing the script return value", async () => {
		const updates: Array<{ content: Array<{ type: string; text: string }>; details: Details }> = [];
		const value = await runWorkflowScript({
			dispatch: async () => ({ result: "unused" }),
			onPhase: createWorkflowPhaseEmitter("wf", (update) => updates.push(update as (typeof updates)[number])),
			script: "phase('Inventory');\nreturn 'done';",
		});

		assert.equal(value, "done");
		assert.equal(updates.length, 1);
		assert.equal(updates[0]?.content[0]?.text, "Inventory");
		assert.equal(updates[0]?.details.mode, "parallel");
		assert.deepEqual(updates[0]?.details.progress, []);
		assert.match(String(updates[0]?.details.label), /^Phase \d+: Inventory/);
	});

	it("childProgress repaints the running placeholder, then is ignored after settle", () => {
		const updates: Array<AgentToolResult<Details>> = [];
		const emitter = createWorkflowPhaseEmitter("wf", (u) => updates.push(u));
		emitter.childStarted("explorer", "scan", 0);
		const startedFrames = updates.length;
		assert.equal(emitter.snapshot().progress?.[0]?.status, "running");
		assert.equal(emitter.snapshot().progress?.[0]?.toolCount, 0);

		// Live mid-run frame: a fresh progress snapshot for the same running child.
		const liveProgress: AgentProgress = {
			index: 0,
			agent: "explorer",
			status: "running",
			task: "scan",
			recentTools: [{ tool: "grep", args: "TODO", endMs: Date.now() }],
			recentOutput: [],
			toolCount: 3,
			tokens: 120,
			durationMs: 500,
			lastActivityAt: Date.now(),
		};
		emitter.childProgress(0, liveProgress);
		assert.ok(updates.length > startedFrames, "childProgress re-emits a live frame");
		assert.equal(emitter.snapshot().progress?.[0]?.toolCount, 3, "running placeholder reflects live tool count");

		// After settle, a late childProgress frame must not resurrect a running status.
		const settled: SingleResult = {
			agent: "explorer",
			task: "scan",
			exitCode: 0,
			usage: { input: 0, output: 0 },
		};
		emitter.childSettled(settled, 0);
		assert.equal(emitter.snapshot().progress?.[0]?.status, "completed");
		const settledFrames = updates.length;
		emitter.childProgress(0, { ...liveProgress, toolCount: 99 });
		assert.equal(updates.length, settledFrames, "childProgress is a no-op once the child settled");
		assert.equal(emitter.snapshot().progress?.[0]?.status, "completed");
		assert.notEqual(emitter.snapshot().progress?.[0]?.toolCount, 99);
	});

	it("ignores phase emitter errors", async () => {
		const value = await runWorkflowScript({
			dispatch: async () => ({ result: "unused" }),
			onPhase: () => {
				throw new Error("render failed");
			},
			script: "phase('Inventory');\nreturn 5;",
		});

		assert.equal(value, 5);
	});
});
