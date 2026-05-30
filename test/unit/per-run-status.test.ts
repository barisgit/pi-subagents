import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { createSubagentExecutor } from "../../subagent-executor.ts";
import { ChildAgentRegistry, __setChildAgentExecutorDepsForTest } from "../../in-process-executor.ts";
import { readAllEntries, setRegistryPathForTests } from "../../runs-registry.ts";
import { STATUS_JSON_VERSION } from "../../status-writer.ts";
import { makeAgent } from "../support/helpers.ts";

const tmpRoots: string[] = [];
let previousHome: string | undefined;
let restoreRuntime: (() => void) | undefined;

class FakeResourceLoader {
	async reload(): Promise<void> {}
}

async function waitForCompleteStatus(runRecordDir: string): Promise<void> {
	for (let i = 0; i < 50; i++) {
		const statusPath = path.join(runRecordDir, "status.json");
		if (fs.existsSync(statusPath)) {
			const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as { state?: string };
			if (status.state === "complete" || status.state === "failed" || status.state === "interrupted") return;
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.fail(`timed out waiting for ${runRecordDir} status.json to complete`);
}

class FakeAgentSession {
	subscribe(): () => void { return () => {}; }
	async prompt(): Promise<void> {}
	getLastAssistantText(): string { return "done"; }
	async abort(): Promise<void> {}
	dispose(): void {}
	setActiveToolsByName(): void {}
}

function setupTempHome(prefix: string): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tmpRoots.push(root);
	previousHome = process.env.HOME;
	process.env.HOME = root;
	setRegistryPathForTests(path.join(root, ".pi", "agent", "pi-subagents", "runs-index.jsonl"));
	return root;
}

function installFakeRuntime(): void {
	restoreRuntime = __setChildAgentExecutorDepsForTest({
		DefaultResourceLoader: FakeResourceLoader as never,
		getAgentDir: () => "/tmp/pi-agent",
		SessionManager: { open: (file: string) => ({ getSessionId: () => `session-${file}` }) as never },
		createAgentSession: async () => ({ session: new FakeAgentSession() as never, extensionsResult: { extensions: [], diagnostics: [] } }) as never,
	});
}

function makeExecutor(cwd: string, emitted: Array<{ event: string; payload: Record<string, unknown> }>) {
	return createSubagentExecutor({
		pi: {
			events: { emit: (event: string, payload: Record<string, unknown>) => emitted.push({ event, payload }) },
			getSessionName: () => undefined,
			setSessionName: () => {},
			getAllTools: () => [],
		},
		state: {
			baseCwd: cwd,
			currentSessionId: null,
			asyncJobs: new Map(),
			foregroundControls: new Map(),
			lastForegroundControlId: null,
			cleanupTimers: new Map(),
			lastUiContext: null,
			poller: null,
		},
		config: { parallel: { concurrency: 2 } },
		asyncByDefault: false,
		tempArtifactsDir: cwd,
		childRegistry: new ChildAgentRegistry(),
		expandTilde: (value: string) => value,
		discoverAgents: () => ({ agents: ["A", "B"].map((name) => makeAgent(name, { model: "mock/test-model" })) }),
	} as never);
}

function makeCtx(cwd: string) {
	return {
		cwd,
		hasUI: false,
		ui: {},
		sessionManager: { getSessionId: () => "session-per-run-status", getSessionFile: () => null },
		modelRegistry: { getAvailable: () => [{ provider: "mock", id: "test-model" }] },
		model: { provider: "mock" },
	};
}

async function execute(cwd: string, emitted: Array<{ event: string; payload: Record<string, unknown> }>): Promise<{ details?: { runId?: string } }> {
	return await makeExecutor(cwd, emitted).execute(
		"id",
		{ async: true, run: [{ agent: "A", task: "alpha" }, { agent: "B", task: "bravo" }] } as never,
		new AbortController().signal,
		undefined,
		makeCtx(cwd) as never,
	) as { details?: { runId?: string } };
}

async function waitForEntries(count: number): Promise<void> {
	for (let i = 0; i < 50; i++) {
		if (readAllEntries().length >= count) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.equal(readAllEntries().length, count);
}

afterEach(() => {
	restoreRuntime?.();
	restoreRuntime = undefined;
	setRegistryPathForTests(null);
	if (previousHome === undefined) delete process.env.HOME;
	else process.env.HOME = previousHome;
	previousHome = undefined;
	for (const root of tmpRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("async parallel per-run status", () => {
	it("each parallel task writes its own versioned status.json", async () => {
		const root = setupTempHome("per-run-status-test-");
		installFakeRuntime();
		const emitted: Array<{ event: string; payload: Record<string, unknown> }> = [];

		await execute(root, emitted);
		await waitForEntries(3);

		const entries = readAllEntries();
		const group = entries.find((entry) => !Object.hasOwn(entry, "agentName"));
		assert.ok(group, "expected a first-class group registry entry");
		const children = entries.filter((entry) => entry.parentRunId === group.runId);
		assert.equal(children.length, 2);
		await Promise.all(children.map((child) => waitForCompleteStatus(child.runRecordDir)));
		assert.equal(new Set(children.map((entry) => entry.runRecordDir)).size, 2);

		for (const child of children) {
			const statusPath = path.join(child.runRecordDir, "status.json");
			assert.equal(fs.existsSync(statusPath), true);
			const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as { version?: number; runId?: string; mode?: string; steps?: unknown[] };
			assert.equal(status.version, STATUS_JSON_VERSION);
			assert.equal(status.runId, child.runId);
			assert.equal(status.mode, "single");
			assert.equal(status.steps?.length, 1);
		}
	});
});
