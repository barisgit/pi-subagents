import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { awaitRun, spawnRun, type Layer0PreparedRunStep, type Layer0RunAgent, type RunLifecycleEvent } from "../../src/dispatch/layer0-runs.ts";
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

describe("Layer-0 run lifecycle events", () => {
	it("per-run lifecycle event fires without user notification", async () => {
		const root = setupTempHome("run-lifecycle-event-test-");
		const lifecycleEvents: RunLifecycleEvent[] = [];
		let resolveRunAgent!: (result: ChildAgentResult) => void;
		const runAgentSettled = new Promise<ChildAgentResult>((resolve) => {
			resolveRunAgent = resolve;
		});
		const runAgent: Layer0RunAgent = async (step) => {
			resolveRunAgent(resultFor(step));
			return runAgentSettled;
		};

		const handle = spawnRun({ agentName: "fixer", task: "do fixer", cwd: root }, {
			rootRunId: "root-run",
			notifyPolicy: "each",
			runAgent,
			defaultSessionDir: path.join(root, "runs"),
			onLifecycle: (event) => lifecycleEvents.push(event),
		});

		assert.deepEqual(lifecycleEvents.map((event) => event.type), ["run.started"]);
		assert.equal(lifecycleEvents[0]?.runId, handle.runId);

		const result = await awaitRun(handle);

		assert.equal(result.runId, handle.runId);
		assert.deepEqual(lifecycleEvents.map((event) => event.type), ["run.started", "run.completed"]);
		assert.deepEqual(lifecycleEvents.map((event) => event.runId), [handle.runId, handle.runId]);
		assert.deepEqual(lifecycleEvents.filter((event) => !event.type.startsWith("run.")), []);

		await awaitRun(handle);
		assert.equal(lifecycleEvents.length, 2);
	});
});
