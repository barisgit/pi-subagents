import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getSingleResultDisplayOutput, getSingleResultOutput } from "../../src/shared/utils.ts";

describe("getSingleResultOutput (semantic / parent-visible)", () => {
	it("returns finalOutput verbatim, including a strict-contract full-text fallback", () => {
		// The semantic helper must NOT strip: parent-visible/persisted text keeps the
		// strict contract's fail-closed-to-full-text behavior at the data boundary.
		assert.equal(
			getSingleResultOutput({ finalOutput: "preamble\n<output>x</output>\ntrailing" }),
			"preamble\n<output>x</output>\ntrailing",
		);
	});
});

describe("getSingleResultDisplayOutput (TUI render surface)", () => {
	it("returns the structured envelope's string result verbatim", () => {
		assert.equal(getSingleResultDisplayOutput({ structuredResult: { result: "clean answer" } }), "clean answer");
	});

	it("pretty-prints a structured (non-string) envelope result as JSON", () => {
		const out = getSingleResultDisplayOutput({ structuredResult: { result: { verdict: "approved", score: 9 } } });
		assert.equal(out, JSON.stringify({ verdict: "approved", score: 9 }, null, 2));
	});

	it("leniently strips trailing prose from a string envelope result (fallback path)", () => {
		// When the strict contract fell back to full text, structuredResult.result is the
		// full message string with prose around the block; display must show only the block.
		assert.equal(
			getSingleResultDisplayOutput({
				structuredResult: { result: "PREAMBLE\n<output>the result</output>\nthanks!" },
			}),
			"the result",
		);
	});

	it("leniently strips trailing prose when only finalOutput is available (no envelope)", () => {
		assert.equal(
			getSingleResultDisplayOutput({ finalOutput: "PREAMBLE narration\n<output>the result</output>\nthanks!" }),
			"the result",
		);
	});

	it("returns the text unchanged when it carries no <output> block", () => {
		assert.equal(getSingleResultDisplayOutput({ finalOutput: "plain prose, no block" }), "plain prose, no block");
	});

	it("prefers the structured envelope over finalOutput when both are present", () => {
		assert.equal(
			getSingleResultDisplayOutput({ structuredResult: { result: "envelope" }, finalOutput: "stale full text" }),
			"envelope",
		);
	});
});
