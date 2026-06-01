import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { appendSubmitResultSystemInstruction, createSubmitResultTool, extractSubmitResultEnvelope, hasSubmitResultToolResult, isSubmitResultEnvelope, SUBMIT_RESULT_SYSTEM_INSTRUCTION } from "../../submit-result.ts";

describe("submit_result tool", () => {
	it("validates the fixed envelope and terminates", async () => {
		const tool = createSubmitResultTool();
		const envelope = { status: "ok", summary: "done", result: "full result", artifacts: ["/tmp/a"] };

		assert.deepEqual(validateToolArguments(tool, { type: "toolCall", id: "good", name: "submit_result", arguments: envelope }), envelope);
		assert.throws(() => validateToolArguments(tool, { type: "toolCall", id: "bad", name: "submit_result", arguments: { status: "ok", result: "no summary" } }), /summary|Expected required property/);
		assert.throws(() => validateToolArguments(tool, { type: "toolCall", id: "extra", name: "submit_result", arguments: { ...envelope, surprise: true } }), /surprise|Unexpected property/);

		const result = await tool.execute?.("manual", envelope, new AbortController().signal, () => {}, {} as never);
		assert.equal(result?.terminate, true);
		assert.deepEqual(result?.details, envelope);
	});

	it("rejects invalid and error submit_result results so unvalidated args cannot leak through", () => {
		// Extra keys: a TypeBox-validated envelope (additionalProperties:false) never carries extras.
		assert.equal(isSubmitResultEnvelope({ status: "ok", summary: "x", result: { value: 1 }, surprise: true }), false);
		// Valid minimal envelope still accepted.
		assert.equal(isSubmitResultEnvelope({ status: "ok", summary: "x", result: "y" }), true);

		// An SDK-rejected (isError) submit_result toolResult must NOT count as compliant.
		const errored = [{ role: "toolResult", toolName: "submit_result", isError: true, details: "Invalid arguments" }];
		assert.equal(hasSubmitResultToolResult(errored), false);
		assert.equal(extractSubmitResultEnvelope(errored), undefined);

		// The pass2 bypass is gone: raw assistant tool-call arguments are never extracted as an envelope,
		// even when they superficially look envelope-shaped.
		const rawArgsOnly = [{ role: "assistant", content: [{ type: "toolCall", name: "submit_result", arguments: { status: "ok", summary: "x", result: { value: 1 }, surprise: true } }] }];
		assert.equal(hasSubmitResultToolResult(rawArgsOnly), false);
		assert.equal(extractSubmitResultEnvelope(rawArgsOnly), undefined);

		// A valid non-error toolResult is still extracted.
		const compliant = [{ role: "toolResult", toolName: "submit_result", details: { status: "ok", summary: "done", result: "payload", artifacts: [] } }];
		assert.equal(hasSubmitResultToolResult(compliant), true);
		assert.deepEqual(extractSubmitResultEnvelope(compliant), { status: "ok", summary: "done", result: "payload", artifacts: [] });
	});

	it("carries the finish contract on the tool description and the system-prompt helper, not the task", () => {
		// Primary carrier: the tool description (always present with the tool) directs a lone final call.
		const tool = createSubmitResultTool();
		assert.match(tool.description ?? "", /submit_result/);
		assert.match(tool.description ?? "", /lone/);
		assert.match(tool.description ?? "", /never stop with prose only/i);

		// Reinforcement carrier: the system-prompt helper appends the contract, preserving an existing prompt.
		assert.match(SUBMIT_RESULT_SYSTEM_INSTRUCTION, /submit_result/);
		assert.equal(appendSubmitResultSystemInstruction(""), SUBMIT_RESULT_SYSTEM_INSTRUCTION);
		assert.equal(appendSubmitResultSystemInstruction("Fix things."), `Fix things.\n\n${SUBMIT_RESULT_SYSTEM_INSTRUCTION}`);
	});
});
