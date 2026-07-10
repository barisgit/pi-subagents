import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { createSubagentExecutor } from "../../src/dispatch/subagent-executor.ts";
import { interruptRun } from "../../src/dispatch/layer0-runs.ts";
import { ChildAgentRegistry, __setChildAgentExecutorDepsForTest } from "../../src/dispatch/in-process-executor.ts";
import { readAllEntries, setRegistryPathForTests } from "../../src/state/runs-registry.ts";
import { STATUS_JSON_VERSION } from "../../src/state/status-writer.ts";
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
	subscribe(): () => void {
		return () => {};
	}
	async prompt(): Promise<void> {}
	getLastAssistantText(): string {
		return "done";
	}
	async abort(): Promise<void> {}
	dispose(): void {}
	setActiveToolsByName(): void {}
}

class BlockingFakeAgentSession extends FakeAgentSession {
	private releasePrompt: () => void = () => {};
	private readonly promptReleased = new Promise<void>((resolve) => {
		this.releasePrompt = resolve;
	});

	override async prompt(): Promise<void> {
		await this.promptReleased;
	}

	override async abort(): Promise<void> {
		this.releasePrompt();
	}
}

function setupTempHome(prefix: string): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tmpRoots.push(root);
	previousHome = process.env.HOME;
	process.env.HOME = root;
	setRegistryPathForTests(path.join(root, ".pi", "agent", "pi-subagents", "runs-index.jsonl"));
	return root;
}

function installFakeRuntime(createSession: () => FakeAgentSession = () => new FakeAgentSession()): void {
	restoreRuntime = __setChildAgentExecutorDepsForTest({
		DefaultResourceLoader: FakeResourceLoader as never,
		getAgentDir: () => "/tmp/pi-agent",
		SessionManager: { open: (file: string) => ({ getSessionId: () => `session-${file}` }) as never },
		createAgentSession: async () =>
			({
				session: createSession() as never,
				extensionsResult: { extensions: [], diagnostics: [] },
			}) as never,
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
		config: {},
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

async function execute(
	cwd: string,
	emitted: Array<{ event: string; payload: Record<string, unknown> }>,
): Promise<{ details?: { runId?: string } }> {
	return (await makeExecutor(cwd, emitted).execute(
		"id",
		{
			async: true,
			run: [
				{ agent: "A", task: "alpha" },
				{ agent: "B", task: "bravo" },
			],
		} as never,
		new AbortController().signal,
		undefined,
		makeCtx(cwd) as never,
	)) as { details?: { runId?: string } };
}

async function executeSingle(
	cwd: string,
	emitted: Array<{ event: string; payload: Record<string, unknown> }>,
	output: string,
): Promise<{ details?: { runId?: string; asyncDir?: string } }> {
	return (await makeExecutor(cwd, emitted).execute(
		"id",
		{
			async: true,
			run: [{ agent: "A", task: "alpha", output }],
		} as never,
		new AbortController().signal,
		undefined,
		makeCtx(cwd) as never,
	)) as { details?: { runId?: string; asyncDir?: string } };
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
			const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as {
				version?: number;
				runId?: string;
				mode?: string;
				steps?: unknown[];
			};
			assert.equal(status.version, STATUS_JSON_VERSION);
			assert.equal(status.runId, child.runId);
			assert.equal(status.mode, "single");
			assert.equal(status.steps?.length, 1);
		}
	});

	it("interrupts an individual running child through its layer0 controller", async () => {
		const root = setupTempHome("per-run-interrupt-test-");
		const sessions: BlockingFakeAgentSession[] = [];
		installFakeRuntime(() => {
			const session = new BlockingFakeAgentSession();
			sessions.push(session);
			return session;
		});
		const emitted: Array<{ event: string; payload: Record<string, unknown> }> = [];

		await execute(root, emitted);
		await waitForEntries(3);
		for (let i = 0; i < 50 && sessions.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(sessions.length, 2, "expected both child sessions to be running");

		const entries = readAllEntries();
		const group = entries.find((entry) => !Object.hasOwn(entry, "agentName"));
		assert.ok(group);
		const children = entries.filter((entry) => entry.parentRunId === group.runId);
		const target = children[0];
		assert.ok(target);
		assert.deepEqual(interruptRun(target.runId, { cascade: false }).interruptedRunIds, [target.runId]);
		await waitForCompleteStatus(target.runRecordDir);
		const targetStatus = JSON.parse(fs.readFileSync(path.join(target.runRecordDir, "status.json"), "utf-8")) as {
			state?: string;
		};
		assert.equal(targetStatus.state, "interrupted");

		for (const child of children.slice(1)) interruptRun(child.runId, { cascade: false });
		await Promise.all(children.slice(1).map((child) => waitForCompleteStatus(child.runRecordDir)));
	});

	it("resolves single-output files before finalizing async single status", async () => {
		const root = setupTempHome("per-run-output-test-");
		installFakeRuntime();
		const emitted: Array<{ event: string; payload: Record<string, unknown> }> = [];
		const outputPath = path.join(root, "reports", "result.md");

		const result = await executeSingle(root, emitted, outputPath);
		assert.ok(result.details?.asyncDir);
		await waitForCompleteStatus(result.details.asyncDir);

		assert.equal(fs.readFileSync(outputPath, "utf-8"), "done");
		const status = JSON.parse(fs.readFileSync(path.join(result.details.asyncDir, "status.json"), "utf-8")) as {
			outputText?: string;
			steps?: Array<{ live?: { outputText?: string } }>;
		};
		assert.equal(status.outputText, "done");
		assert.equal(status.steps?.[0]?.live?.outputText, "done");
	});
});
