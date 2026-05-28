import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { Compile } from "typebox/compile";
import { SubagentParams } from "../../schemas.ts";
import { validateSubagentToolInput } from "../../subagent-executor.ts";

const validator = Compile(SubagentParams);

function valid(input: unknown): boolean {
	return validator.Check(input) && validateSubagentToolInput(input) === null;
}

describe("context enum", () => {
	it("accepts an absent context as fresh default", () => {
		assert.equal(valid({ run: [{ agent: "main", task: "work" }] }), true);
	});

	it("accepts context fresh", () => {
		assert.equal(valid({ run: [{ agent: "explorer", task: "inspect", context: "fresh" }] }), true);
	});

	it("accepts context fork for main", () => {
		assert.equal(valid({ run: [{ agent: "main", task: "continue", context: "fork" }] }), true);
	});

	it("accepts context fork for any agent (same-agent enforced at dispatch)", () => {
		assert.equal(valid({ run: [{ agent: "fixer", task: "second pass", context: "fork" }] }), true);
		assert.equal(valid({ run: [{ agent: "explorer", task: "branch out", context: "fork" }] }), true);
	});

	it("rejects summarized until the reserved future mode is implemented", () => {
		const input = { run: [{ agent: "main", task: "work", context: "summarized" }] };

		assert.equal(validator.Check(input), false);
	});

	it("documents summarized as a future extension point", () => {
		const source = readFileSync("schemas.ts", "utf8");

		assert.match(source, /Future context mode `summarized` is reserved/);
	});
});
