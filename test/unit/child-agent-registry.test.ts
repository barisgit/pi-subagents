import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { afterEach, describe, it } from "node:test";
import {
	ChildAgentRegistry,
	type ChildAgentHandle,
	type RunViewSeed,
} from "../../src/dispatch/child-agent-registry.ts";
import type { ChildAgentResult, StatusPatch } from "../../src/protocol/status-types.ts";

// The production code reaches disk through `import * as fs from "node:fs"`
// namespace bindings, which are non-configurable and cannot be reassigned.
// Builtins share one underlying function object between the ESM namespace and
// the CJS require() object, so patching the require()'d object IS observed by
// the namespace consumers — that is the seam used to forbid disk reads.
const fsCjs = createRequire(import.meta.url)("node:fs") as typeof import("node:fs");

const restoreFns: Array<() => void> = [];

afterEach(() => {
	while (restoreFns.length > 0) restoreFns.pop()?.();
});

const RUN_ID = "run-runview-test";
// Deliberately NONEXISTENT: proves getRunView never touches disk for this dir.
const ASYNC_DIR = `/tmp/does-not-exist-${RUN_ID}`;

function makeSeed(): RunViewSeed {
	return {
		mode: "single",
		state: "queued",
		startedAt: 1_000,
		cwd: "/work/dir",
		label: "build the thing",
		parentRunId: "parent-run",
		parentSessionId: "parent-session",
		rootSessionId: "root-session",
		currentStep: 0,
		sessionFile: `${ASYNC_DIR}/session.jsonl`,
		sessionDir: ASYNC_DIR,
		asyncDir: ASYNC_DIR,
		steps: [{ agent: "fixer", label: "build the thing", status: "queued" }],
	};
}

/** Throw on ANY disk read so the test proves the registry projection is memory-only. */
function forbidDiskReads(): void {
	const origRead = fsCjs.readFileSync;
	const origStat = fsCjs.statSync;
	(fsCjs as { readFileSync: unknown }).readFileSync = (...args: unknown[]) => {
		throw new Error(`disk read forbidden: readFileSync(${String(args[0])})`);
	};
	(fsCjs as { statSync: unknown }).statSync = (...args: unknown[]) => {
		throw new Error(`disk read forbidden: statSync(${String(args[0])})`);
	};
	restoreFns.push(() => {
		(fsCjs as { readFileSync: unknown }).readFileSync = origRead;
		(fsCjs as { statSync: unknown }).statSync = origStat;
	});
}

function makeHandle(runId: string, stepIndex: number): ChildAgentHandle {
	return {
		runId,
		stepIndex,
		get session(): never {
			throw new Error("session not available in test");
		},
		completed: Promise.resolve({} as ChildAgentResult),
		async abort(): Promise<void> {},
	};
}

describe("ChildAgentRegistry RunView mirror", () => {
	it("exposes every dashboard-row field from memory without reading disk", () => {
		const registry = new ChildAgentRegistry();
		registry.seedRunView(RUN_ID, makeSeed());

		// From here on, any disk read is a test failure.
		forbidDiskReads();

		// Seed-only view: run-level + step-level identity is present.
		const seeded = registry.getRunView(RUN_ID);
		assert.ok(seeded, "getRunView returns a view after seeding");
		assert.equal(seeded.id, RUN_ID);
		assert.equal(seeded.mode, "single");
		assert.equal(seeded.state, "queued");
		assert.equal(seeded.startedAt, 1_000);
		assert.equal(seeded.cwd, "/work/dir");
		assert.equal(seeded.label, "build the thing");
		assert.equal(seeded.parentRunId, "parent-run");
		assert.equal(seeded.parentSessionId, "parent-session");
		assert.equal(seeded.rootSessionId, "root-session");
		assert.equal(seeded.steps[0]?.agent, "fixer");
		assert.equal(seeded.steps[0]?.status, "queued");

		// Drive the executor-equivalent patch sequence through applyStatusPatch.
		// Timestamps are `now`-relative so the derived liveness fields are stable:
		// a fresh heartbeat keeps the run out of the "lost" bucket, and currentTool
		// pins displayState to "tool_running" independent of wall-clock drift.
		const now = Date.now();
		const patches: StatusPatch[] = [
			{ runId: RUN_ID, stepIndex: 0, state: "running" },
			{ runId: RUN_ID, stepIndex: 0, activity: { state: "tool_running", toolName: "Read", updatedAt: now } },
			{ runId: RUN_ID, stepIndex: 0, tokens: { input: 100, output: 50, total: 150 } },
			{ runId: RUN_ID, stepIndex: 0, phase: "tool_running", phaseStartedAt: now },
			{ runId: RUN_ID, stepIndex: 0, runnerHeartbeatAt: now },
		];
		for (const patch of patches) registry.applyStatusPatch(patch);

		const view = registry.getRunView(RUN_ID);
		assert.ok(view, "getRunView returns a view after patches");
		// Run-level dashboard-row fields. Every field a dashboard row reads must be
		// present on the projection (optional liveness fields are asserted by key
		// exposure since the producer assigns ownership/values later).
		assert.equal(view.id, RUN_ID);
		assert.equal(view.mode, "single");
		assert.equal(view.state, "running");
		assert.equal(view.startedAt, 1_000);
		assert.equal(view.cwd, "/work/dir");
		assert.equal(view.label, "build the thing");
		assert.equal(view.parentRunId, "parent-run");
		assert.equal(view.rootSessionId, "root-session");
		assert.equal(view.currentStep, 0);
		assert.equal(view.lastActivityAt, now);
		assert.equal(view.currentTool, "Read");
		assert.equal(view.currentToolStartedAt, now);
		assert.equal(view.phase, "tool_running");
		assert.equal(view.phaseStartedAt, now);
		assert.equal(view.runnerHeartbeatAt, now);
		// activityState is config-derived; assert the field is exposed on the row
		// rather than a specific value (its truthiness depends on shared control
		// config that other suites may toggle). displayState is pinned by currentTool.
		assert.ok("activityState" in view, "activityState field exposed");
		assert.equal(view.displayState, "tool_running");
		// Step-level dashboard-row fields.
		const step = view.steps[0];
		assert.ok(step, "step 0 present");
		assert.equal(step.agent, "fixer");
		assert.equal(step.status, "running");
		// The step mirrors the run-level activityState derivation regardless of
		// whether control config is enabled, so this equality holds in any suite order.
		assert.equal(step.activityState, view.activityState);
		assert.equal(step.displayState, "tool_running");
		assert.equal(step.currentTool, "Read");
		assert.equal(step.tokens?.total, 150);
	});

	it("retains terminal result metadata through the window, then sweeps", () => {
		const registry = new ChildAgentRegistry({ retentionMs: 5_000 });
		registry.seedRunView(RUN_ID, makeSeed());
		registry.applyStatusPatch({ runId: RUN_ID, stepIndex: 0, state: "running" });

		const terminalAt = 9_000;
		registry.applyStatusPatch({ runId: RUN_ID, stepIndex: 0, state: "complete", endedAt: terminalAt });
		const result: ChildAgentResult = {
			runId: RUN_ID,
			stepIndex: 0,
			state: "complete",
			exitCode: 0,
			outputText: "done",
			toolCallCount: 1,
			toolResultCount: 1,
			toolErrorCount: 0,
			durationMs: 8_000,
			startedAt: 1_000,
			endedAt: terminalAt,
			sessionFile: `${ASYNC_DIR}/session.jsonl`,
			usage: { input: 200, output: 100, cacheRead: 0, cacheWrite: 0, cost: 0.5, turns: 3 },
		};
		registry.finalizeView(RUN_ID, result);

		// finalizeView lands the terminal result metadata NOT carried in the patch
		// stream (output, final usage, and endedAt). Run-level state flip stays a producer
		// concern (deferred): the terminal STEP patch deliberately does not flip it.
		const beforeWindow = registry.getRunView(RUN_ID);
		assert.ok(beforeWindow, "view retained before window elapses");
		assert.equal(beforeWindow.endedAt, terminalAt);
		assert.equal(beforeWindow.finalOutput, "done");
		assert.equal(beforeWindow.totalTokens?.total, 300);

		// Sweep happens lazily in listRunViews once retention elapses. terminalAt is
		// stamped at real wall-clock time inside finalizeView, so advance from now.
		const swept = registry.listRunViews(Date.now() + 5_001);
		assert.equal(
			swept.find((v) => v.id === RUN_ID),
			undefined,
			"run swept after retention window",
		);
		assert.equal(registry.getRunView(RUN_ID), undefined, "view gone after sweep");
	});

	it("keeps the RunView alive after its handle is deleted", () => {
		const registry = new ChildAgentRegistry();
		registry.seedRunView(RUN_ID, makeSeed());
		registry.register(makeHandle(RUN_ID, 0));

		registry.delete(RUN_ID, 0);
		assert.equal(registry.get(RUN_ID), undefined, "handle removed");

		const view = registry.getRunView(RUN_ID);
		assert.ok(view, "view outlives the handle");
		assert.equal(view.id, RUN_ID);
	});

	it("aborts each handle once when a run has multiple steps", async () => {
		const registry = new ChildAgentRegistry();
		const calls: string[] = [];
		for (const stepIndex of [0, 1]) {
			registry.register({
				runId: RUN_ID,
				stepIndex,
				get session(): never {
					throw new Error("session not available in test");
				},
				completed: Promise.resolve({} as ChildAgentResult),
				async abort(reason: string): Promise<void> {
					calls.push(`${stepIndex}:${reason}`);
				},
			});
		}

		await registry.abortAll("shutdown");

		assert.deepEqual(calls, ["0:shutdown", "1:shutdown"]);
	});
});
