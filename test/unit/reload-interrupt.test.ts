import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { spawnRun, awaitRun, type Layer0PreparedRunStep, type Layer0RunAgent } from "../../src/dispatch/layer0-runs.ts";
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
		outputText: "done",
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

describe("interrupt across module reload", () => {
	it("a fresh module instance's interruptRun aborts a run spawned by another instance", async () => {
		// The host reloads extensions by re-importing modules in the SAME process. A
		// run spawned pre-reload keeps executing inside the OLD module instance; the
		// post-reload interrupt path resolves through the NEW instance. The abort
		// controller map is shared via processGlobal, so the new instance must find
		// and abort the old instance's run — this was the reload-uninterruptible bug.
		const root = setupTempHome("layer0-reload-interrupt-");
		const runAgent: Layer0RunAgent = async (step, ctx) => {
			await new Promise<void>((resolve) =>
				ctx.abortSignal.addEventListener("abort", () => resolve(), { once: true }),
			);
			return { ...resultFor(step), state: "interrupted", exitCode: 1, outputText: "interrupted after reload" };
		};
		const handle = spawnRun(
			{ agentName: "fixer", task: "survive reload", cwd: root },
			{ rootRunId: "root", notifyPolicy: "silent", runAgent, defaultSessionDir: path.join(root, "runs") },
		);

		// Cache-busted import = the post-reload module instance.
		const url = new URL("../../src/dispatch/layer0-runs.ts", import.meta.url).href;
		const reloaded = (await import(`${url}?post-reload`)) as typeof import("../../src/dispatch/layer0-runs.ts");
		const interruptResult = reloaded.interruptRun(handle.runId, { cascade: true });

		assert.deepEqual(interruptResult.interruptedRunIds, [handle.runId]);
		const result = await awaitRun(handle);
		assert.equal(result.state, "interrupted");
	});
});
