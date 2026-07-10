import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	DESCRIPTION_TOKEN_LIMIT,
	countCl100kTokens,
	descriptionTokenCheck,
	readRegisteredSubagentDescription,
} from "../../lib/count-tokens.ts";

function tokens(count: number): string {
	return " a".repeat(count);
}

describe("description tokens", () => {
	it("description-tokens", () => {
		assert.equal(DESCRIPTION_TOKEN_LIMIT, 700);
	});

	it("description-under-700", () => {
		const result = descriptionTokenCheck(readRegisteredSubagentDescription());

		assert.equal(result.limit, 700);
		assert.equal(result.ok, true, `description has ${result.count} tokens`);
		assert.ok(result.count <= 700);
	});

	it("synthetic-701-fails", () => {
		const text = tokens(701);

		assert.equal(countCl100kTokens(text), 701);
		assert.equal(descriptionTokenCheck(text).ok, false);
	});

	it("exact-700-passes", () => {
		const text = tokens(700);

		assert.equal(countCl100kTokens(text), 700);
		assert.equal(descriptionTokenCheck(text).ok, true);
	});

	it("tokenizer-deterministic", () => {
		const text = "run:[{agent,task}] uses {task}/{in}";

		assert.equal(countCl100kTokens(text), countCl100kTokens(text));
	});
});
