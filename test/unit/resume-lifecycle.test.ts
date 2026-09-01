import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { createSubagentExecutor } from "../../src/dispatch/subagent-executor.ts";
import { __setStatusWriterWriteJsonForTest } from "../../src/state/status-writer.ts";
import { ChildAgentRegistry, __setChildAgentExecutorDepsForTest } from "../../src/dispatch/in-process-executor.ts";
import { appendRunEntry, setRegistryPathForTests } from "../../src/state/runs-registry.ts";
import { setCurrentPi } from "../../src/shared/current-pi.ts";
import { createTempDir, makeAgent, removeTempDir } from "../support/helpers.ts";
import { createAsyncJobTracker } from "../../src/surfaces/async-job-tracker.ts";
import type { SubagentState } from "../../src/protocol/types.ts";

let tempDir: string | undefined;
let restoreDeps: (() => void) | undefined;
afterEach(() => {
	restoreDeps?.();
	restoreDeps = undefined;
	setRegistryPathForTests(null);
	if (tempDir) removeTempDir(tempDir);
	tempDir = undefined;
});

function state(cwd: string): SubagentState {
	return {
		baseCwd: cwd,
		currentSessionId: null,
		asyncJobs: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
	};
}
class DoneSession {
	async bindExtensions(): Promise<void> {}
	subscribe() {
		return () => {};
	}
	setActiveToolsByName() {}
	getLastAssistantText() {
		return "done again";
	}
	dispose() {}
	async abort() {}
	async prompt() {}
}
function setup() {
	tempDir = createTempDir("pi-subagent-resume-lifecycle-");
	setRegistryPathForTests(path.join(tempDir, "runs-index.jsonl"));
	const events: Array<{ channel: string; data: any }> = [];
	const pi = {
		events: { emit: (channel: string, data: unknown) => events.push({ channel, data }) },
		getSessionName: () => undefined,
		setSessionName: () => {},
		getAllTools: () => [],
	};
	setCurrentPi(pi as never);
	restoreDeps = __setChildAgentExecutorDepsForTest({
		SessionManager: { open: () => ({ getSessionId: () => "same-session" }) } as never,
		DefaultResourceLoader: class {
			async reload() {}
		} as never,
		getAgentDir: () => tempDir!,
		createAgentSession: async () => ({ session: new DoneSession() }) as never,
	});
	const s = state(tempDir);
	const executor = createSubagentExecutor({
		pi,
		state: s,
		config: {},
		asyncByDefault: false,
		tempArtifactsDir: tempDir,
		childRegistry: new ChildAgentRegistry(),
		expandTilde: (v: string) => v,
		discoverAgents: () => ({ agents: [makeAgent("fixer", { model: "mock/test-model" })] }),
	} as never);
	const execute = (params: Record<string, unknown>) =>
		executor.execute("id", params as never, new AbortController().signal, undefined, {
			cwd: tempDir!,
			hasUI: false,
			ui: {},
			sessionManager: { getSessionId: () => "parent", getSessionFile: () => null },
			modelRegistry: { getAvailable: () => [{ provider: "mock", id: "test-model" }] },
			model: { provider: "mock" },
		} as never) as Promise<{ isError?: boolean; content: Array<{ text?: string }> }>;
	return { execute, events, state: s };
}
function seedRun(root: string, startedAt = 4444) {
	const runId = "lifecycle-run";
	const runRecordDir = path.join(root, runId);
	fs.mkdirSync(path.join(runRecordDir, "run-0"), { recursive: true });
	fs.writeFileSync(path.join(runRecordDir, "run-0", "session.jsonl"), "{}\n", "utf8");
	appendRunEntry({
		runId,
		runRecordDir,
		mode: "single",
		source: "sync",
		agentName: "fixer",
		rootRunId: runId,
		rootSessionId: "parent",
		cwd: root,
		startedAt,
	});
	fs.writeFileSync(
		path.join(runRecordDir, "status.json"),
		JSON.stringify({
			runId,
			mode: "single",
			state: "complete",
			startedAt,
			endedAt: startedAt + 1,
			cwd: root,
			steps: [{ agent: "fixer", status: "complete" }],
		}),
		"utf8",
	);
	return { runId, runRecordDir, startedAt };
}

describe("resume lifecycle", () => {
	it("status cycle rewrites complete to running then complete", async () => {
		const h = setup();
		const run = seedRun(tempDir!);
		await h.execute({ action: "resume", id: run.runId, message: "again", async: false });
		const status = JSON.parse(fs.readFileSync(path.join(run.runRecordDir, "status.json"), "utf8"));
		assert.equal(status.state, "complete");
		assert.equal(status.endedAt >= run.startedAt, true);
	});
	it("tracker reanimate overwrites a terminal async job on started event", () => {
		const h = setup();
		const run = seedRun(tempDir!);
		h.state.asyncJobs.set(run.runId, {
			asyncId: run.runId,
			asyncDir: run.runRecordDir,
			status: "complete",
			updatedAt: 1,
		});
		const tracker = createAsyncJobTracker({ events: { on: () => () => {} } } as never, h.state, {
			pollIntervalMs: 100000,
			completionRetentionMs: 100000,
		});
		tracker.handleStarted({ id: run.runId, asyncDir: run.runRecordDir, agent: "fixer" });
		assert.equal(h.state.asyncJobs.get(run.runId)?.status, "queued");
	});
	it("resume reseeds the activity clock so the inactivity watchdog restarts", async () => {
		const h = setup();
		const run = seedRun(tempDir!, 4444);
		// Capture every status write; the FIRST running-state write is the resume
		// initialize, observed before the child posts activity or finalizes. The bug
		// lived in exactly that window: initialize left lastActivityAt unset and
		// lastUpdate pinned to the original startedAt, so the watchdog measured the
		// pre-resume idle gap and fired "needs attention" instantly.
		const writes: Array<Record<string, any>> = [];
		const restore = __setStatusWriterWriteJsonForTest((filePath, payload) => {
			// StatusWriter mutates one status object in place across writes, so snapshot
			// each payload at capture time rather than retaining the live reference.
			if (filePath.includes(run.runId)) writes.push(JSON.parse(JSON.stringify(payload)));
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, JSON.stringify(payload), "utf8");
		});
		const before = Date.now();
		try {
			await h.execute({ action: "resume", id: run.runId, message: "again", async: false });
		} finally {
			restore();
		}
		const init = writes.find((w) => w.state === "running");
		assert.ok(init, "expected a running-state status write on resume");
		// startedAt stays in the past (immutable), but the activity/heartbeat clocks
		// must be reseeded to the resume moment at initialize time.
		assert.equal(init!.startedAt, 4444);
		assert.equal(typeof init!.lastActivityAt, "number");
		assert.ok(
			init!.lastActivityAt >= before,
			`lastActivityAt ${init!.lastActivityAt} should be >= resume time ${before}`,
		);
		assert.ok(
			init!.lastActivityAt - init!.startedAt > 1000,
			"activity clock must not stay pinned to the original startedAt",
		);
		assert.ok((init!.runnerHeartbeatAt ?? 0) >= before, "runner heartbeat must be reseeded on resume");
		assert.equal(
			init!.lastUpdate >= before,
			true,
			"lastUpdate must advance to the resume moment, not stay at startedAt",
		);
	});
	it("startedAt immutable across disk resume", async () => {
		const h = setup();
		const run = seedRun(tempDir!, 9876);
		await h.execute({ action: "resume", id: run.runId, message: "again", async: false });
		const status = JSON.parse(fs.readFileSync(path.join(run.runRecordDir, "status.json"), "utf8"));
		assert.equal(status.startedAt, 9876);
	});
});
