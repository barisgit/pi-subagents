import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runWorkflowScript, WorkflowAgentError } from "../../workflow.ts";

describe("workflow agent global (VAL-AGENT-GLOBAL)", () => {
	it("resolves to the submit_result envelope returned by an injected dispatch", async () => {
		const envelope = { status: "ok" as const, summary: "done", result: { answer: 7 }, artifacts: ["artifact.txt"] };
		const value = await runWorkflowScript({
			dispatch: async (role, task) => {
				assert.equal(role, "explorer");
				assert.equal(task, "inventory");
				return envelope;
			},
			script: "return await agent('explorer', 'inventory');",
		});

		assert.deepEqual(value, envelope);
	});

	it("surfaces dispatch failure and does not return a masking fallback status:ok envelope", async () => {
		const maskingEnvelope = { status: "ok" as const, summary: "fallback text", result: "fallback text", artifacts: [] };
		await assert.rejects(
			runWorkflowScript({
				dispatch: async () => ({ envelope: maskingEnvelope, exitCode: 1, error: "child failed" }),
				script: "return await agent('explorer', 'task');",
			}),
			(error: unknown) => {
				assert.ok(error instanceof WorkflowAgentError);
				assert.equal(error.envelope, maskingEnvelope);
				assert.match(error.message, /child failed/);
				return true;
			},
		);
	});

	it("surfaces interrupted dispatches even when the child fallback envelope says ok", async () => {
		await assert.rejects(
			runWorkflowScript({
				dispatch: async () => ({ envelope: { status: "ok", summary: "fallback", result: "fallback" }, interrupted: true }),
				script: "return await agent('explorer', 'task');",
			}),
			/was interrupted/,
		);
	});
});
