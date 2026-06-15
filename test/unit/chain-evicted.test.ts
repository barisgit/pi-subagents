import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { SubagentParams } from "../../src/protocol/schemas.ts";

const root = path.resolve(import.meta.dirname, "../..");

function read(rel: string): string {
	return fs.readFileSync(path.join(root, rel), "utf-8");
}

describe("chain eviction", () => {
	it("deletes chain-only implementation files", () => {
		for (const rel of [
			"chain-clarify.ts",
			"chain-execution.ts",
			"chain-serializer.ts",
			"agent-manager-chain-detail.ts",
		]) {
			assert.equal(fs.existsSync(path.join(root, rel)), false, `${rel} must not exist`);
		}
	});

	it("removes chain from the subagent schema and description", () => {
		const props = (SubagentParams as { properties?: Record<string, unknown> }).properties ?? {};
		assert.equal(Object.hasOwn(props, "chain"), false);
		const index = read("src/dispatch/subagent-tool.ts");
		const start = index.indexOf("description: `Delegate a bounded task");
		const end = index.indexOf("parameters: SubagentParams", start);
		assert.ok(start >= 0 && end > start, "subagent tool description should be present");
		const description = index.slice(start, end);
		assert.doesNotMatch(description, /chain/i);
	});

	it("has no root source imports from chain modules", () => {
		for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
			if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
			const text = read(entry.name);
			assert.doesNotMatch(text, /from ["']\.\/chain-/);
		}
	});

	it("removes previous-result substitution from executor source", () => {
		assert.doesNotMatch(read("src/dispatch/subagent-executor.ts"), /\{previous\}/);
	});
});
