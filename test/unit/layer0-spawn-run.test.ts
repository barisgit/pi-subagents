import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { spawnRun, awaitRun, type Layer0PreparedRunStep, type Layer0RunAgent } from "../../src/dispatch/layer0-runs.ts";
import { readAllEntries, setRegistryPathForTests } from "../../src/state/runs-registry.ts";
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

function resultFor(step: Layer0PreparedRunStep): ChildAgentResult {
	const startedAt = Date.now();
	return {
		runId: step.runId,
		stepIndex: 0,
		state: "complete",
		exitCode: 0,
		outputText: `done ${step.agentName}`,
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

describe("Layer-0 spawnRun", () => {
	it("mints one independent runId per spawned agent", async () => {
		const root = setupTempHome("layer0-spawn-run-test-");
		const runAgent: Layer0RunAgent = async (step) => resultFor(step);

		const handles = ["fixer", "qa", "review"].map((agentName) =>
			spawnRun(
				{ agentName, task: `do ${agentName}`, cwd: root },
				{
					rootRunId: "root-run",
					notifyPolicy: "silent",
					runAgent,
					defaultSessionDir: path.join(root, "runs"),
				},
			),
		);

		assert.equal(new Set(handles.map((handle) => handle.runId)).size, handles.length);
		assert.equal(new Set(handles.map((handle) => handle.runRecordDir)).size, handles.length);
		for (const handle of handles) {
			assert.equal(fs.existsSync(path.join(handle.runRecordDir, "status.json")), true);
		}

		const entries = readAllEntries();
		assert.equal(entries.length, handles.length);
		assert.equal(new Set(entries.map((entry) => entry.runId)).size, handles.length);
		assert.equal(new Set(entries.map((entry) => entry.runRecordDir)).size, handles.length);

		await Promise.all(handles.map((handle) => awaitRun(handle)));
	});
});
