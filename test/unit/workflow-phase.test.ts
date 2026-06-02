import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createWorkflowPhaseEmitter, runWorkflowScript } from "../../workflow.ts";
import type { Details } from "../../types.ts";

describe("workflow phase global (VAL-PHASE)", () => {
	it("emits a progress line through onUpdate without changing the script return value", async () => {
		const updates: Array<{ content: Array<{ type: string; text: string }>; details: Details }> = [];
		const value = await runWorkflowScript({
			dispatch: async () => ({ status: "ok", summary: "unused", result: "unused" }),
			onPhase: createWorkflowPhaseEmitter("wf", (update) => updates.push(update as typeof updates[number])),
			script: "phase('Inventory');\nreturn 'done';",
		});

		assert.equal(value, "done");
		assert.equal(updates.length, 1);
		assert.equal(updates[0]?.content[0]?.text, "Inventory");
		assert.equal(updates[0]?.details.mode, "parallel");
		assert.deepEqual(updates[0]?.details.progress, []);
		assert.match(String(updates[0]?.details.label), /^Phase \d+: Inventory/);
	});

	it("ignores phase emitter errors", async () => {
		const value = await runWorkflowScript({
			dispatch: async () => ({ status: "ok", summary: "unused", result: "unused" }),
			onPhase: () => { throw new Error("render failed"); },
			script: "phase('Inventory');\nreturn 5;",
		});

		assert.equal(value, 5);
	});
});
