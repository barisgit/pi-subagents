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

	it("teaches request-scaled fan-out and streaming quality patterns concisely", () => {
		const description = readRegisteredWorkflowDescription();

		assert.match(description, /do not apply the manual subagent child count to workflow leaves/i);
		assert.match(description, /do not silently cap/i);
		assert.match(description, /default to pipeline/i);
		assert.match(description, /barrier only when.*all prior-stage results/i);
		assert.match(description, /scope.*work-list.*pipeline/i);
		assert.match(description, /adversarial verify.*refute/i);
		assert.match(description, /loop-until-dry.*consecutive rounds/i);
		assert.ok(description.length <= 6_000, `workflow description has ${description.length} characters`);
	});
});
