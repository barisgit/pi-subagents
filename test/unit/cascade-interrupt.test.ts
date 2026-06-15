import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	awaitRun,
	interruptRun,
	openGroup,
	spawnRun,
	type Layer0PreparedRunStep,
	type Layer0RunAgent,
} from "../../src/dispatch/layer0-runs.ts";
import { setRegistryPathForTests } from "../../src/state/runs-registry.ts";
import type { ChildAgentResult } from "../../src/dispatch/in-process-executor.ts";

const tmpRoots: string[] = [];
let previousHome: string | undefined;

function setupTempHome(prefix: string): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tmpRoots.push(root);
	previousHome = process.env.HOME;
	process.env.HOME = root;
	setRegistryPathForTests(path.join(root, ".pi", "agent", "pi-subagents", "runs-index.jsonl"));
	return root;
}

function interruptedResultFor(step: Layer0PreparedRunStep, startedAt: number): ChildAgentResult {
	return {
		runId: step.runId,
		stepIndex: 0,
		state: "interrupted",
		exitCode: 1,
		outputText: `interrupted ${step.agentName}`,
		toolCallCount: 0,
		toolResultCount: 0,
		toolErrorCount: 0,
		durationMs: 1,
		startedAt,
		endedAt: startedAt + 1,
		sessionFile: step.sessionFile,
	};
}

afterEach(() => {
	setRegistryPathForTests(null);
	if (previousHome === undefined) delete process.env.HOME;
	else process.env.HOME = previousHome;
	previousHome = undefined;
	for (const root of tmpRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Layer-0 cascade interrupt", () => {
	it("cascade interrupt cancels subtree but not siblings", async () => {
		const root = setupTempHome("cascade-interrupt-test-");
		const abortedRunIds: string[] = [];
		const runAgent: Layer0RunAgent = async (step, ctx) => {
			const startedAt = Date.now();
			await new Promise<void>((resolve) =>
				ctx.abortSignal.addEventListener(
					"abort",
					() => {
						abortedRunIds.push(step.runId);
						resolve();
					},
					{ once: true },
				),
			);
			return interruptedResultFor(step, startedAt);
		};

		const groupA = openGroup({
			cwd: root,
			rootRunId: "root-run",
			notifyPolicy: "silent",
			defaultSessionDir: path.join(root, "runs"),
		});
		const groupB = openGroup({
			cwd: root,
			rootRunId: "root-run",
			notifyPolicy: "silent",
			defaultSessionDir: path.join(root, "runs"),
		});
		const groupAChildren = ["A1", "A2"].map((agentName) =>
			spawnRun(
				{ agentName, task: `run ${agentName}`, cwd: root },
				{
					parentRunId: groupA.runId,
					rootRunId: "root-run",
					notifyPolicy: "silent",
					runAgent,
					defaultSessionDir: path.join(root, "runs"),
				},
			),
		);
		const groupBChildren = ["B1", "B2"].map((agentName) =>
			spawnRun(
				{ agentName, task: `run ${agentName}`, cwd: root },
				{
					parentRunId: groupB.runId,
					rootRunId: "root-run",
					notifyPolicy: "silent",
					runAgent,
					defaultSessionDir: path.join(root, "runs"),
				},
			),
		);

		const interruptResult = interruptRun(groupA.runId, { cascade: true });
		await Promise.all(groupAChildren.map((handle) => awaitRun(handle)));

		const groupAChildRunIds = groupAChildren.map((handle) => handle.runId).sort();
		const groupBChildRunIds = groupBChildren.map((handle) => handle.runId).sort();
		assert.deepEqual(interruptResult.interruptedRunIds.sort(), groupAChildRunIds);
		assert.deepEqual(abortedRunIds.filter((runId) => groupAChildRunIds.includes(runId)).sort(), groupAChildRunIds);
		assert.deepEqual(
			abortedRunIds.filter((runId) => groupBChildRunIds.includes(runId)),
			[],
		);

		interruptRun(groupB.runId, { cascade: true });
		await Promise.all(groupBChildren.map((handle) => awaitRun(handle)));
	});
});
