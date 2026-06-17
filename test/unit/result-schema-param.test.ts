import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { createSubmitResultTool } from "../../src/protocol/submit-result.ts";

describe("submit_result result schema seam", () => {
	it("defaults result to a string so an unprompted child cannot self-invent structure", () => {
		// Principle: structure in `result` exists ONLY when a workflow author demands it
		// via a per-invocation schema. With no schema the default is a string, so a child
		// cannot decide its own shape — it returns text. A structured submit is rejected
		// here and the reprompt loop steers the child back to a string.
		const tool = createSubmitResultTool();
		assert.deepEqual(
			validateToolArguments(tool, {
				type: "toolCall",
				id: "string",
				name: "submit_result",
				arguments: { result: "text" },
			}),
			{ result: "text" },
		);
		assert.throws(
			() =>
				validateToolArguments(tool, {
					type: "toolCall",
					id: "object",
					name: "submit_result",
					arguments: { result: { value: 1 } },
				}),
			/result|Expected string/,
		);
	});

	it("accepts an optional per-invocation TypeBox schema", () => {
		const tool = createSubmitResultTool(Type.Object({ value: Type.Number() }, { additionalProperties: false }));
		const envelope = { result: { value: 1 } };
		assert.deepEqual(
			validateToolArguments(tool, { type: "toolCall", id: "object", name: "submit_result", arguments: envelope }),
			envelope,
		);
		assert.throws(
			() =>
				validateToolArguments(tool, {
					type: "toolCall",
					id: "string",
					name: "submit_result",
					arguments: { result: "text" },
				}),
			/result|Expected object/,
		);
	});
});
