import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

function readRegisteredToolDescription(
	sourceFile: string,
	toolName: string,
	descriptionStart: string,
	parametersName: string,
): string {
	const testDir = path.dirname(fileURLToPath(import.meta.url));
	const indexSource = fs.readFileSync(path.resolve(testDir, "..", "..", sourceFile), "utf-8");
	const match = indexSource.match(
		new RegExp(
			`${descriptionStart}[\\s\\S]*?description:\\s*\`([\\s\\S]*?)\`,\\r?\\n\\t\\tparameters: ${parametersName},`,
		),
	);
	assert.ok(match, `expected to find the registered ${toolName} tool description`);
	return match[1]!;
}

function readRegisteredSubagentDescription(): string {
	return readRegisteredToolDescription(
		"src/dispatch/subagent-tool.ts",
		"subagent",
		'name:\\s*"subagent",',
		"SubagentParams",
	);
}

function readRegisteredWorkflowDescription(): string {
	return readRegisteredToolDescription(
		"src/workflow/workflow.ts",
		"workflow",
		'name:\\s*"workflow",',
		"WorkflowParams",
	);
}

const hardcodedPersonaNames = ["scout", "worker", "planner", "reviewer", "explorer", "fixer", "qa"];

function assertNoHardcodedPersonaNames(description: string): void {
	for (const personaName of hardcodedPersonaNames) {
		assert.doesNotMatch(description, new RegExp(`\\b${personaName}\\b`));
	}
	assert.doesNotMatch(description, /agent\("review"/);
}

describe("registered subagent tool description", () => {
	it("does not advertise hardcoded builtin agent names", () => {
		const description = readRegisteredSubagentDescription();

		assertNoHardcodedPersonaNames(description);
		assert.doesNotMatch(description, /before executing, use \{ action: "list" \}/i);
		assert.match(description, /use \{ action: "list" \} when available agents are unknown or may have changed/i);
		assert.match(description, /executable\/non-disabled/i);
		assert.match(description, /resume steers a live run[\s\S]*without interrupting first/i);
		assert.match(description, /either stop or continue only work that neither overlaps nor duplicates/i);
		assert.match(description, /do not poll or redo the child's investigation, implementation, or verification/i);
		assert.match(description, /10–15 minutes or longer/i);
	});
});

describe("registered workflow tool description", () => {
	it("teaches placeholders instead of hardcoded persona names", () => {
		const description = readRegisteredWorkflowDescription();

		assertNoHardcodedPersonaNames(description);
		assert.match(description, /role is a string chosen from the caller's configured agent roles/i);
		assert.match(description, /<implementation-role>/);
		assert.match(description, /process-wide leaf-concurrency pool/i);
	});

	it("presents uncapped programmable orchestration without prescribing one topology", () => {
		const description = readRegisteredWorkflowDescription();

		assert.doesNotMatch(description, /prefer one child|2–4|default to pipeline/i);
		assert.match(description, /no prompt-imposed child count/i);
		assert.match(description, /ordinary JavaScript/i);
		assert.match(description, /pipeline\(\).*streams[\s\S]*parallel\(\).*barrier/i);
		assert.match(description, /nested[\s\S]*loops and branches/i);
		assert.match(description, /fan-in[\s\S]*requeue[\s\S]*gate/i);
		assert.match(description, /not templates or limits/i);
		assert.match(description, /not canonical recipes/i);
		assert.ok(description.length <= 6_000, `workflow description has ${description.length} characters`);
	});
});
