import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Type } from "typebox";
import { parseOutputEnvelope } from "../../src/protocol/output-contract.ts";

describe("output result schema seam", () => {
	it("defaults result to a string so an unprompted child cannot self-invent structure", () => {
		// Principle: structure in `result` exists ONLY when a workflow author demands it
		// via a per-invocation schema. With no schema the <output> block IS the string
		// result — a child cannot decide its own shape, it returns text.
		const parsed = parseOutputEnvelope("narration\n<output>text</output>");
		assert.deepEqual(parsed, { ok: true, envelope: { result: "text" } });
	});

	it("validates the <output> block against an optional per-invocation TypeBox schema", () => {
		const schema = Type.Object({ value: Type.Number() }, { additionalProperties: false });
		const good = parseOutputEnvelope('<output>{"value": 1}</output>', schema);
		assert.deepEqual(good, { ok: true, envelope: { result: { value: 1 } } });

		// A plain string where the schema demands an object fails closed (steers a reprompt).
		assert.deepEqual(parseOutputEnvelope("<output>text</output>", schema), { ok: false });
		// Wrong field type fails closed.
		assert.deepEqual(parseOutputEnvelope('<output>{"value": "x"}</output>', schema), { ok: false });
	});
});
