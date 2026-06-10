import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";

const root = path.resolve(import.meta.dirname, "../..");

function read(rel: string): string {
	return fs.readFileSync(path.join(root, rel), "utf-8");
}

function toolDescription(source: string, marker: string, endMarker: string): string {
	const start = source.indexOf(marker);
	const end = source.indexOf(endMarker, start);
	assert.ok(start >= 0 && end > start, `${marker} description should be present`);
	return source.slice(start, end);
}

describe("chain docs eviction", () => {
	it("removes chain-mode teaching from docs and tool descriptions", () => {
		const samples = [
			["README.md", read("README.md")],
			["skills/subagent/SKILL.md", read("skills/subagent/SKILL.md")],
			["subagent description", toolDescription(read("index.ts"), "description: `Delegate a bounded task", "parameters: SubagentParams")],
			["workflow description", toolDescription(read("workflow.ts"), "description: `Orchestrate multiple subagents", "parameters: WorkflowParams")],
		] as const;

		for (const [name, text] of samples) {
			assert.doesNotMatch(text, /chain:true/, `${name} must not teach chain:true`);
			assert.doesNotMatch(text, /\{previous\}/, `${name} must not teach previous substitution`);
		}
	});

	it("routes sequential orchestration guidance to workflow", () => {
		for (const [name, text] of [["README.md", read("README.md")], ["skills/subagent/SKILL.md", read("skills/subagent/SKILL.md")]] as const) {
			assert.match(text, /workflow/i, `${name} should mention workflow`);
			assert.match(text, /sequential|orchestration|multi-step/i, `${name} should mention orchestration guidance`);
		}
	});
});
