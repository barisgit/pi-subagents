import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { statusToRunView } from "../../src/state/async-status.ts";
import { ChildAgentRegistry, __setChildAgentExecutorDepsForTest } from "../../src/dispatch/in-process-executor.ts";
import { appendRunEntry, setRegistryPathForTests } from "../../src/state/runs-registry.ts";
import { createSubagentExecutor } from "../../src/dispatch/subagent-executor.ts";
import { __setStatusWriterWriteJsonForTest } from "../../src/state/status-writer.ts";
import { setCurrentPi } from "../../src/shared/current-pi.ts";
import { createTempDir, makeAgent, removeTempDir } from "../support/helpers.ts";
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
	tempDir = createTempDir("pi-subagent-resume-display-fields-");
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

function seedRun(root: string, startedAt = 4444, extra: Record<string, unknown> = {}) {
	const runId = "display-fields-run";
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
			...extra,
		}),
		"utf8",
	);
	return { runId, runRecordDir, startedAt };
}

describe("resume display fields", () => {
	it("persists resumeCount and resumedAt on accepted resume while preserving startedAt", async () => {
		const h = setup();
		const run = seedRun(tempDir!, 9_876);
		const writes: Array<Record<string, any>> = [];
		const restore = __setStatusWriterWriteJsonForTest((filePath, payload) => {
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
		const init = writes.find((write) => write.state === "running");
		assert.ok(init, "expected resume initialize write");
		assert.equal(init!.resumeCount, 1);
		assert.equal(typeof init!.resumedAt, "number");
		assert.ok(init!.resumedAt >= before);
		assert.equal(init!.startedAt, run.startedAt);
		const finalStatus = JSON.parse(fs.readFileSync(path.join(run.runRecordDir, "status.json"), "utf8"));
		assert.equal(finalStatus.resumeCount, 1);
		assert.equal(finalStatus.startedAt, run.startedAt);
	});

	it("increments resumeCount by one and overwrites resumedAt on each accepted resume", async () => {
		const h = setup();
		const run = seedRun(tempDir!, 4_444);
		await h.execute({ action: "resume", id: run.runId, message: "first", async: false });
		const first = JSON.parse(fs.readFileSync(path.join(run.runRecordDir, "status.json"), "utf8"));
		await new Promise((resolve) => setTimeout(resolve, 5));
		await h.execute({ action: "resume", id: run.runId, message: "second", async: false });
		const second = JSON.parse(fs.readFileSync(path.join(run.runRecordDir, "status.json"), "utf8"));
		assert.equal(first.resumeCount, 1);
		assert.equal(second.resumeCount, 2);
		assert.ok(second.resumedAt >= first.resumedAt);
		assert.equal(second.startedAt, run.startedAt);
	});

	it("defaults missing fields to never-resumed summary values", () => {
		const legacy = statusToRunView("/tmp/legacy", {
			runId: "legacy",
			mode: "single",
			state: "complete",
			startedAt: 1_000,
			endedAt: 2_000,
			steps: [],
		});
		assert.equal(legacy.resumeCount, 0);
		assert.equal(legacy.resumedAt, undefined);
	});
});
