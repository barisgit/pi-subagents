import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Type } from "typebox";
import {
	buildOutputContractAppend,
	extractOutputBlock,
	fallbackSubmitResultEnvelope,
	hasOutputBlock,
	OUTPUT_REPROMPT,
	OUTPUT_SYSTEM_INSTRUCTION,
	parseOutputEnvelope,
	renderSchemaInstruction,
	schemaReprompt,
} from "../../src/protocol/output-contract.ts";

describe("output contract", () => {
	it("extracts the LAST <output> block and trims it", () => {
		const text = [
			"Here is a sample: <output>not the real one</output>",
			"more narration",
			"<output>\n  the real result\n</output>",
		].join("\n");
		assert.equal(extractOutputBlock(text), "the real result");
		assert.equal(hasOutputBlock(text), true);
	});

	it("handles multiline content inside the block", () => {
		const text = "prefix\n<output>line one\nline two\nline three</output>";
		assert.equal(extractOutputBlock(text), "line one\nline two\nline three");
	});

	it("returns undefined for no block and for an unterminated block (fail closed)", () => {
		assert.equal(extractOutputBlock("no markers here"), undefined);
		assert.equal(hasOutputBlock("no markers here"), false);
		// Missing close tag: not a valid block, never extracted to end-of-string.
		assert.equal(extractOutputBlock("<output>started but never closed"), undefined);
		assert.equal(extractOutputBlock(""), undefined);
	});

	it("defaults to the block text as the string result when no schema is supplied", () => {
		const parsed = parseOutputEnvelope("narration\n<output>final answer</output>");
		assert.deepEqual(parsed, { ok: true, envelope: { result: "final answer" } });
	});

	it("fails closed when no block is present", () => {
		assert.deepEqual(parseOutputEnvelope("just prose, no block"), { ok: false });
	});

	it("JSON-parses and TypeBox-validates the block against a supplied schema", () => {
		const schema = Type.Object(
			{ approved: Type.Boolean(), notes: Type.String() },
			{ additionalProperties: false },
		);
		const good = parseOutputEnvelope('<output>{"approved": true, "notes": "ok"}</output>', schema);
		assert.deepEqual(good, { ok: true, envelope: { result: { approved: true, notes: "ok" } } });

		// Schema miss (wrong type) fails closed.
		assert.deepEqual(
			parseOutputEnvelope('<output>{"approved": "yes", "notes": "ok"}</output>', schema),
			{ ok: false },
		);
		// Extra property (additionalProperties:false) fails closed.
		assert.deepEqual(
			parseOutputEnvelope('<output>{"approved": true, "notes": "ok", "extra": 1}</output>', schema),
			{ ok: false },
		);
		// Missing required property fails closed.
		assert.deepEqual(parseOutputEnvelope('<output>{"approved": true}</output>', schema), { ok: false });
		// Non-JSON content with a schema fails closed rather than throwing.
		assert.deepEqual(parseOutputEnvelope("<output>not json</output>", schema), { ok: false });
	});

	it("takes the LAST block even with a schema, so earlier samples are ignored", () => {
		const schema = Type.Object({ n: Type.Number() }, { additionalProperties: false });
		const text = 'example <output>{"n": 1}</output> then real <output>{"n": 42}</output>';
		assert.deepEqual(parseOutputEnvelope(text, schema), { ok: true, envelope: { result: { n: 42 } } });
	});

	it("fallback wraps arbitrary text as the result", () => {
		assert.deepEqual(fallbackSubmitResultEnvelope("raw text"), { result: "raw text" });
	});

	it("contract text instructs the end-of-prompt convention generically (no tool, no persona)", () => {
		assert.match(OUTPUT_SYSTEM_INSTRUCTION, /<output>/);
		assert.match(OUTPUT_SYSTEM_INSTRUCTION, /LAST/);
		assert.match(OUTPUT_SYSTEM_INSTRUCTION, /do not call any finish tool/i);
		assert.doesNotMatch(OUTPUT_SYSTEM_INSTRUCTION, /submit_result/);
		assert.match(
			OUTPUT_SYSTEM_INSTRUCTION,
			/Pi will send a completion or needs-attention message and trigger a new turn/,
		);
	});

	it("reprompt text directs finishing with a trailing block", () => {
		assert.match(OUTPUT_REPROMPT, /<output>/);
		assert.match(OUTPUT_REPROMPT, /did not end with/i);
		assert.doesNotMatch(OUTPUT_REPROMPT, /submit_result/);
	});

	it("buildOutputContractAppend adds the schema shape only when a schema is supplied", () => {
		assert.equal(buildOutputContractAppend(), OUTPUT_SYSTEM_INSTRUCTION);
		const schema = Type.Object({ ok: Type.Boolean() }, { additionalProperties: false });
		const withSchema = buildOutputContractAppend(schema);
		assert.ok(withSchema.startsWith(OUTPUT_SYSTEM_INSTRUCTION));
		assert.match(withSchema, /MUST contain a single JSON value/);
		assert.match(withSchema, /"ok"/);
	});

	it("renderSchemaInstruction serializes the schema as JSON shape guidance", () => {
		const schema = Type.Object({ count: Type.Number() }, { additionalProperties: false });
		const instruction = renderSchemaInstruction(schema);
		assert.match(instruction, /<output>/);
		assert.match(instruction, /"count"/);
	});

	it("schemaReprompt includes the required schema shape", () => {
		const schema = Type.Object({ count: Type.Number() }, { additionalProperties: false });
		const reprompt = schemaReprompt(schema);
		assert.match(reprompt, /did not match the required JSON shape/);
		assert.match(reprompt, /<output>/);
		assert.match(reprompt, /"count"/);
	});
});
