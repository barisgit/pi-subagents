import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { runWorkflowScript, type WorkflowDispatchTags } from "../../src/workflow/workflow.ts";

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

function readWorkflowExample(): string {
	const description = readRegisteredWorkflowDescription();
	const match = description.match(/One compositional example follows\.[\s\S]*?:\n([\s\S]*?)\n\nTop-level await/);
	assert.ok(match, "expected one extractable compositional workflow example");
	return match[1]!
		.split("\n")
		.map((line) => (line.startsWith("    ") ? line.slice(4) : line))
		.join("\n")
		.replace(/<[^>]+-role>/g, "configured-role");
}

const hardcodedPersonaNames = ["scout", "worker", "planner", "reviewer", "explorer", "fixer", "qa"];

function assertNoHardcodedPersonaNames(description: string): void {
	for (const personaName of hardcodedPersonaNames) {
		assert.doesNotMatch(description, new RegExp(`\\b${personaName}\\b`));
	}
	assert.doesNotMatch(description, /agent\("review"/);
}

describe("registered subagent tool description", () => {
	it("documents configured roles, run management, and nested async semantics", () => {
		const description = readRegisteredSubagentDescription();

		assertNoHardcodedPersonaNames(description);
		assert.match(description, /one or more entries[\s\S]*execute in parallel/i);
		assert.match(description, /context[\s\S]*fresh[\s\S]*fork[\s\S]*same-role self-branching/i);
		assert.match(description, /forced to synchronous execution unless[\s\S]*allowNestedAsync/i);
		assert.match(description, /completion starts a new turn in the immediate parent session/i);
		assert.match(description, /configured roles are unknown or may have changed[\s\S]*action: "list"/i);
		assert.match(description, /executable\/non-disabled/i);
		assert.match(description, /resume[\s\S]*steers a live run without first interrupting/i);
		assert.match(description, /do not poll or duplicate its work/i);
	});
});

describe("registered workflow tool description", () => {
	it("documents the complete programmable contract with configured-role placeholders", () => {
		const description = readRegisteredWorkflowDescription();

		assertNoHardcodedPersonaNames(description);
		assert.match(description, /role strings come from the caller's configured roles/i);
		assert.match(description, /<implementation-role>/);
		assert.match(description, /process-global active-leaf/i);
		assert.match(description, /workflow\.maxPipelineItemsInFlight/i);
		assert.match(description, /meta\(\{ name, description, phases \}\)/i);
		assert.match(description, /six sandbox globals/i);
		assert.match(description, /opts\.schema[\s\S]*structured result/i);
		assert.match(description, /opts\.phase[\s\S]*opts\.label[\s\S]*opts\.cwd/i);
		assert.match(description, /opts\.phase[\s\S]*must match a phase declared by meta/i);
		assert.match(description, /relative paths resolved from the caller\/session cwd/i);
		assert.match(description, /parallelSettled\(thunks\)[\s\S]*error: string/i);
		assert.match(description, /previousResult, originalItem, index/i);
		assert.match(description, /pipeline is fail-fast[\s\S]*failure rejects it/i);
		assert.match(description, /pipeline\(\) streams item chains[\s\S]*parallel\(\)[\s\S]*barriers/i);
		assert.match(description, /forced synchronous unless[\s\S]*allowNestedAsync/i);
		assert.match(description, /immediate parent session/i);
		assert.doesNotMatch(description, /prefer one child|2–4|default to pipeline/i);
		for (const capability of [
			"dynamic fan-out",
			"fan-in",
			"streaming pipelines",
			"partial failure",
			"feedback",
			"bounded requeue",
			"convergence",
		]) {
			assert.ok(description.includes(capability), `missing workflow capability: ${capability}`);
		}
		assert.equal(description.match(/One compositional example follows/g)?.length, 1);
	});

	it("runs the documented example through branching, partial failure, and convergence", async () => {
		const calls: Array<{ task: string; tags?: WorkflowDispatchTags }> = [];
		const phases: string[] = [];
		const repairs = new Map<string, number>();
		let gateRound = 0;
		const value = await runWorkflowScript({
			script: readWorkflowExample(),
			onPhase: (title) => phases.push(title),
			dispatch: async (_role, task, tags) => {
				calls.push({ task, ...(tags ? { tags } : {}) });
				if (task.startsWith("Inspect the repository")) {
					return {
						result: [
							{ id: "api", cwd: "packages/api" },
							{ id: "db", cwd: "packages/db" },
							{ id: "ui", cwd: "packages/ui" },
						],
					};
				}
				if (task.startsWith("Analyze component api")) {
					return { result: { summary: "API needs repair", gaps: ["missing retry", "weak assertion"] } };
				}
				if (task.startsWith("Analyze component db")) {
					return { result: { summary: "DB needs repair", gaps: ["missing rollback"] } };
				}
				if (task.startsWith("Analyze component ui")) {
					return { result: { summary: "UI is clear", gaps: [] } };
				}
				if (task.startsWith("Challenge the gaps")) {
					return { isError: true, error: "challenge unavailable" };
				}
				if (task.startsWith("Propose a minimal repair")) return { result: "retry proposal" };
				if (task.startsWith("Repair api")) {
					repairs.set("api", (repairs.get("api") ?? 0) + 1);
					return { result: { id: "api", resolved: true, evidence: "api tests pass" } };
				}
				if (task.startsWith("Repair db")) {
					const count = (repairs.get("db") ?? 0) + 1;
					repairs.set("db", count);
					return {
						result: {
							id: "db",
							resolved: count === 2,
							evidence: count === 2 ? "db tests pass" : "db test still fails",
						},
					};
				}
				if (task.startsWith("Verify actual files")) {
					gateRound++;
					return gateRound === 1
						? { result: [{ id: "db", cwd: "packages/db", gaps: ["missing rollback"] }] }
						: { result: [] };
				}
				if (task.startsWith("Produce a decision-ready report")) return { result: "repair complete" };
				throw new Error(`unexpected example task: ${task}`);
			},
		});

		assert.equal(value, "repair complete");
		assert.deepEqual(phases, ["Discover", "Analyze", "Converge", "Synthesize"]);
		assert.deepEqual(Object.fromEntries(repairs), { api: 1, db: 2 });
		assert.equal(gateRound, 2);
		const synthesisTask = calls.find(({ task }) => task.startsWith("Produce a decision-ready report"))?.task;
		assert.ok(synthesisTask?.includes('"evidence":"api tests pass"'));
		assert.ok(synthesisTask?.includes('"evidence":"db tests pass"'));
		assert.ok(synthesisTask?.includes('"error":"agent \'configured-role\' failed: challenge unavailable"'));
		assert.ok(synthesisTask?.includes('"round":2'));
		assert.ok(calls.some(({ tags }) => tags?.cwd === "packages/api" && tags.label === "Analyze api"));
		assert.ok(calls.some(({ tags }) => tags?.phaseTitle === "Converge" && tags.resultSchema));
	});
});
