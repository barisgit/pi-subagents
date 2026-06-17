import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateToolArguments } from "@earendil-works/pi-ai";
import {
	appendSubmitResultSystemInstruction,
	createSubmitResultTool,
	extractSubmitResultEnvelope,
	hasSubmitResultToolResult,
	isSubmitResultEnvelope,
	SUBMIT_RESULT_SYSTEM_INSTRUCTION,
} from "../../src/protocol/submit-result.ts";

describe("submit_result tool", () => {
	it("validates the single-field envelope and terminates", async () => {
		const tool = createSubmitResultTool();
		const envelope = { result: "full result" };

		assert.deepEqual(
			validateToolArguments(tool, { type: "toolCall", id: "good", name: "submit_result", arguments: envelope }),
			envelope,
		);
		assert.throws(
			() =>
				validateToolArguments(tool, {
					type: "toolCall",
					id: "bad",
					name: "submit_result",
					arguments: {},
				}),
			/result|Expected required property/,
		);
		assert.throws(
			() =>
				validateToolArguments(tool, {
					type: "toolCall",
					id: "extra",
					name: "submit_result",
					arguments: { ...envelope, status: "ok", summary: "done", artifacts: [] },
				}),
			/status|summary|artifacts|Unexpected property/,
		);

		const parameters = tool.parameters as { properties?: Record<string, unknown> };
		assert.deepEqual(Object.keys(parameters.properties ?? {}), ["result"]);

		const result = await tool.execute?.("manual", envelope, new AbortController().signal, () => {}, {} as never);
		assert.equal(result?.terminate, true);
		assert.deepEqual(result?.details, envelope);
	});

	it("rejects invalid and error submit_result results so unvalidated args cannot leak through", () => {
		// Extra keys: a TypeBox-validated envelope (additionalProperties:false) never carries extras.
		assert.equal(isSubmitResultEnvelope({ result: { value: 1 }, surprise: true }), false);
		// Valid minimal envelope still accepted.
		assert.equal(isSubmitResultEnvelope({ result: "y" }), true);

		// An SDK-rejected (isError) submit_result toolResult must NOT count as compliant.
		const errored = [
			{ role: "toolResult", toolName: "submit_result", isError: true, details: "Invalid arguments" },
		];
		assert.equal(hasSubmitResultToolResult(errored), false);
		assert.equal(extractSubmitResultEnvelope(errored), undefined);

		// The pass2 bypass is gone: raw assistant tool-call arguments are never extracted as an envelope,
		// even when they superficially look envelope-shaped.
		const rawArgsOnly = [
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						name: "submit_result",
						arguments: { result: { value: 1 }, surprise: true },
					},
				],
			},
		];
		assert.equal(hasSubmitResultToolResult(rawArgsOnly), false);
		assert.equal(extractSubmitResultEnvelope(rawArgsOnly), undefined);

		// A valid non-error toolResult is still extracted.
		const compliant = [
			{
				role: "toolResult",
				toolName: "submit_result",
				details: { result: "payload" },
			},
		];
		assert.equal(hasSubmitResultToolResult(compliant), true);
		assert.deepEqual(extractSubmitResultEnvelope(compliant), {
			result: "payload",
		});
	});

	it("carries the finish contract on the tool description and the system-prompt helper, not the task", () => {
		// Primary carrier: the tool description (always present with the tool) directs a lone final call.
		const tool = createSubmitResultTool();
		assert.match(tool.description ?? "", /submit_result/);
		assert.match(tool.description ?? "", /lone/);
		assert.match(tool.description ?? "", /never stop with prose only/i);

		// Reinforcement carrier: the system-prompt helper appends the contract, preserving an existing prompt.
		assert.match(SUBMIT_RESULT_SYSTEM_INSTRUCTION, /submit_result/);
		assert.match(
			SUBMIT_RESULT_SYSTEM_INSTRUCTION,
			/Pi will send a completion or needs-attention message and trigger a new turn/,
		);
		assert.match(
			SUBMIT_RESULT_SYSTEM_INSTRUCTION,
			/Use status\/sleep checks only when immediate inspection is genuinely necessary/,
		);
		assert.equal(appendSubmitResultSystemInstruction(""), SUBMIT_RESULT_SYSTEM_INSTRUCTION);
		assert.equal(
			appendSubmitResultSystemInstruction("Fix things."),
			`Fix things.\n\n${SUBMIT_RESULT_SYSTEM_INSTRUCTION}`,
		);
	});
});
