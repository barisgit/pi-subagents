import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { SubagentParams } from "../../src/protocol/schemas.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function readSource(file: string): string {
	return fs.readFileSync(path.join(root, file), "utf8");
}

describe("description relabel guards", () => {
	it("keeps tool and slash-command descriptions mode-neutral", () => {
		const index = readSource("src/dispatch/subagent-tool.ts");
		const slash = readSource("src/surfaces/slash-commands.ts");
		const schemas = readSource("src/protocol/schemas.ts");

		assert.doesNotMatch(index, /inspect\/resume async runs/);
		assert.match(index, /inspect\/resume background runs/);
		assert.doesNotMatch(index, /\[async\]/);
		assert.match(index, /\[background\]/);
		assert.doesNotMatch(slash, /Show live sync and async subagent runs/);
		assert.match(slash, /Show live subagent runs/);
		assert.doesNotMatch(schemas, /description: "Run in background\."/);
		assert.match(schemas, /Run detached \(returns immediately\)\./);
	});

	it("exposes a detached/background async parameter description", () => {
		const asyncDescription = (SubagentParams.properties.async as { description?: string }).description ?? "";
		assert.match(asyncDescription, /detached|background/i);
		assert.doesNotMatch(asyncDescription, /^async$/i);
	});
});
