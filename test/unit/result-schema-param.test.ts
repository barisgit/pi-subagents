import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { createSubmitResultTool } from "../../src/protocol/submit-result.ts";

describe("submit_result result schema seam", () => {
	it("defaults result to string", () => {
		const tool = createSubmitResultTool();
		validateToolArguments(tool, { type: "toolCall", id: "string", name: "submit_result", arguments: { status: "ok", summary: "done", result: "text" } });
		assert.throws(() => validateToolArguments(tool, { type: "toolCall", id: "object", name: "submit_result", arguments: { status: "ok", summary: "done", result: { value: 1 } } }), /result|Expected string/);
	});

	it("accepts an optional per-invocation TypeBox schema", () => {
		const tool = createSubmitResultTool(Type.Object({ value: Type.Number() }, { additionalProperties: false }));
		const envelope = { status: "ok", summary: "done", result: { value: 1 } };
		assert.deepEqual(validateToolArguments(tool, { type: "toolCall", id: "object", name: "submit_result", arguments: envelope }), envelope);
		assert.throws(() => validateToolArguments(tool, { type: "toolCall", id: "string", name: "submit_result", arguments: { status: "ok", summary: "done", result: "text" } }), /result|Expected object/);
	});
});
