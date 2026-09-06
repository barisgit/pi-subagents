import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	openRunRecord,
	spawnRun,
	awaitRun,
	type Layer0PreparedRunStep,
	type Layer0RunAgent,
} from "../../src/dispatch/layer0-runs.ts";
import { readAllEntries, setRegistryPathForTests } from "../../src/state/runs-registry.ts";
import { __setStatusWriterWriteJsonForTest } from "../../src/state/status-writer.ts";
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

	it("opens each group child as queued until it acquires a permit", async () => {
		const root = setupTempHome("layer0-spawn-queued-test-");
		const gate = new Promise<void>(() => {}); // never resolves: children stay pre-finalize
		const runAgent: Layer0RunAgent = async (step) => {
			await gate;
			return resultFor(step);
		};

		const handle = spawnRun(
			{ agentName: "fixer", task: "queued probe", cwd: root },
			{ rootRunId: "root-run", notifyPolicy: "silent", runAgent, defaultSessionDir: path.join(root, "runs") },
		);

		// openRunRecord writes the initial status synchronously during spawnRun. The
		// bare runAgent emits no status patch, so the record stays at its opened
		// state: a group child must open "queued" (run + first step), NOT "running",
		// so it never looks active while blocked on the leaf-concurrency pool.
		const status = JSON.parse(fs.readFileSync(path.join(handle.runRecordDir, "status.json"), "utf8"));
		assert.equal(status.state, "queued");
		assert.equal(status.steps[0].status, "queued");
	});
});

describe("Layer-0 openRunRecord registration", () => {
	function openTwice(root: string) {
		const runId = "fixed-run-id";
		const runRecordDir = path.join(root, "runs", runId);
		const open = () =>
			openRunRecord(
				{ agentName: "fixer", task: "retry me", cwd: root },
				{
					runId,
					runRecordDir,
					sessionFile: path.join(runRecordDir, "session.jsonl"),
					rootRunId: runId,
					source: "async",
					variant: "async-detached",
					initialize: { mode: "single", cwd: root, startedAt: Date.now(), currentStep: 0, steps: [] },
				},
			);
		return { open, runRecordDir };
	}

	it("retrying the same runId does not duplicate global registry rows", () => {
		const root = setupTempHome("layer0-open-retry-test-");
		const { open } = openTwice(root);
		open().statusWriter.dispose();
		open().statusWriter.dispose();
		assert.equal(readAllEntries().length, 1);
	});

	it("cleans up status.json and surfaces one clear error when the global registry append fails", () => {
		const root = setupTempHome("layer0-open-cleanup-test-");
		// Point the registry path at a DIRECTORY so appendFileSync fails.
		const registryDir = path.join(root, "registry-as-dir");
		fs.mkdirSync(registryDir, { recursive: true });
		setRegistryPathForTests(registryDir);
		const { open, runRecordDir } = openTwice(root);
		assert.throws(open, /register/i);
		assert.equal(
			fs.existsSync(path.join(runRecordDir, "status.json")),
			false,
			"partial status.json must be cleaned up",
		);
	});
});

describe("Layer-0 spawnRun rejection", () => {
	it("finalizes status.json as failed when runAgent rejects", async () => {
		const root = setupTempHome("layer0-spawn-reject-test-");
		const runAgent: Layer0RunAgent = async () => {
			throw new Error("leaf exploded");
		};
		const handle = spawnRun(
			{ agentName: "fixer", task: "boom", cwd: root },
			{ rootRunId: "root-run", notifyPolicy: "silent", runAgent, defaultSessionDir: path.join(root, "runs") },
		);
		await assert.rejects(handle.completed, /leaf exploded/);
		const status = JSON.parse(fs.readFileSync(path.join(handle.runRecordDir, "status.json"), "utf8"));
		assert.equal(status.state, "failed");
		assert.equal(typeof status.endedAt, "number");
		assert.match(String(status.error), /leaf exploded/);
		assert.equal(status.steps[0].status, "failed");
	});
});

describe("Layer-0 terminal persistence failure", () => {
	it("surfaces the persistence error when recording an already-rejected child", async () => {
		const root = setupTempHome("layer0-rejected-enospc-");
		const failure = Object.assign(new Error("ENOSPC: failed child final status write"), { code: "ENOSPC" });
		const handle = spawnRun(
			{ agentName: "worker", task: "failed execution", cwd: root },
			{
				rootRunId: "root-run",
				notifyPolicy: "silent",
				defaultSessionDir: path.join(root, "runs"),
				runAgent: async () => {
					throw new Error("execution failed first");
				},
			},
		);
		const restore = __setStatusWriterWriteJsonForTest(() => {
			throw failure;
		});
		try {
			await assert.rejects(awaitRun(handle), (error) => error === failure);
		} finally {
			restore();
		}
	});
	it("rejects completion instead of announcing success when the final write fails", async () => {
		const root = setupTempHome("layer0-finalize-enospc-");
		const completed: Array<{ result?: ChildAgentResult; error?: unknown }> = [];
		const handle = spawnRun(
			{ agentName: "worker", task: "persist result", cwd: root },
			{
				rootRunId: "root-run",
				notifyPolicy: "silent",
				defaultSessionDir: path.join(root, "runs"),
				runAgent: async (step) => resultFor(step),
				onLifecycle: (event) => {
					if (event.type === "run.completed") completed.push(event);
				},
			},
		);
		const failure = Object.assign(new Error("ENOSPC: final status write"), { code: "ENOSPC" });
		const restore = __setStatusWriterWriteJsonForTest(() => {
			throw failure;
		});
		try {
			await assert.rejects(awaitRun(handle), (error) => error === failure);
			assert.equal(completed.length, 1, "the lifecycle must settle once with the persistence error");
			assert.equal(completed[0]?.error, failure);
			assert.equal(completed[0]?.result, undefined, "no successful lifecycle result before persistence");
		} finally {
			restore();
		}
	});
});
