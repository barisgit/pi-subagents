import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { awaitRun, interruptRun, openGroup, spawnRun, type Layer0PreparedRunStep, type Layer0RunAgent } from "../../layer0-runs.ts";
import { setRegistryPathForTests } from "../../runs-registry.ts";
import type { ChildAgentResult } from "../../in-process-executor.ts";

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
		outputText: "done without handler",
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

describe("Layer-0 decoupled primitives", () => {
	it("spawnRun/awaitRun/interruptRun/openGroup are callable without the tool handler", async () => {
		const root = setupTempHome("layer0-decoupled-test-");
		let executorCalled = false;
		const runAgent: Layer0RunAgent = async (step, ctx) => {
			executorCalled = true;
			await new Promise<void>((resolve) => ctx.abortSignal.addEventListener("abort", () => resolve(), { once: true }));
			return { ...resultFor(step), state: "interrupted", exitCode: 1, outputText: "interrupted without handler" };
		};

		const group = openGroup({
			cwd: root,
			rootRunId: "root-run",
			notifyPolicy: "silent",
			defaultSessionDir: path.join(root, "runs"),
		});
		const handle = spawnRun({ agentName: "fixer", task: "direct primitive call", cwd: root }, {
			parentRunId: group.runId,
			rootRunId: "root-run",
			notifyPolicy: "silent",
			runAgent,
			defaultSessionDir: path.join(root, "runs"),
		});

		const interruptResult = interruptRun(handle.runId, { cascade: false });
		const result = await awaitRun(handle);

		assert.equal(executorCalled, true);
		assert.equal(result.runId, handle.runId);
		assert.equal(result.state, "interrupted");
		assert.deepEqual(interruptResult.interruptedRunIds, [handle.runId]);
		assert.equal(fs.existsSync(path.join(handle.runRecordDir, "status.json")), true);
	});
});
