import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { createSubagentExecutor } from "../../subagent-executor.ts";
import { ChildAgentRegistry, __setChildAgentExecutorDepsForTest } from "../../in-process-executor.ts";
import { readAllEntries, setRegistryPathForTests } from "../../runs-registry.ts";
import { makeAgent } from "../support/helpers.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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
		sessionManager: { getSessionId: () => "session-parallel-n-runs", getSessionFile: () => null },
		modelRegistry: { getAvailable: () => [{ provider: "mock", id: "test-model" }] },
		model: { provider: "mock" },
	};
}

async function execute(cwd: string, params: Record<string, unknown>, emitted: Array<{ event: string; payload: Record<string, unknown> }>) {
	return await makeExecutor(cwd, emitted).execute("id", params as never, new AbortController().signal, undefined, makeCtx(cwd) as never) as { details?: { runId?: string; asyncDir?: string } };
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

describe("async parallel Layer-0 run wiring", () => {
	it("parallel mints N child runs under a group; chain stays single runId", async () => {
		const root = setupTempHome("parallel-n-runs-test-");
		installFakeRuntime();
		const emitted: Array<{ event: string; payload: Record<string, unknown> }> = [];

		const parallel = await execute(root, { async: true, run: [{ agent: "A", task: "alpha" }, { agent: "B", task: "bravo" }] }, emitted);
		await waitForEntries(3);

		const entries = readAllEntries();
		const group = entries.find((entry) => entry.runId === parallel.details?.runId);
		assert.ok(group, "expected returned asyncId/runId to be the group runId");
		assert.equal(group.agentName, undefined);
		assert.equal(Object.hasOwn(group, "agentName"), false);

		const children = entries.filter((entry) => entry.parentRunId === group.runId);
		await Promise.all(children.map((child) => waitForCompleteStatus(child.runRecordDir)));
		assert.equal(children.length, 2);
		assert.equal(new Set(children.map((entry) => entry.runId)).size, 2);
		assert.equal(children.every((entry) => UUID_RE.test(entry.runId)), true);
		assert.deepEqual(children.map((entry) => entry.agentName).sort(), ["A", "B"]);

		setRegistryPathForTests(path.join(root, ".pi", "agent", "pi-subagents", "chain-runs-index.jsonl"));
		const chain = await execute(root, { async: true, chain: true, run: [{ agent: "A", task: "first" }, { agent: "B", task: "second {previous}" }] }, emitted);
		await waitForEntries(1);
		await waitForCompleteStatus(chain.details!.asyncDir!);
		const chainEntries = readAllEntries();
		assert.equal(chainEntries.length, 1);
		assert.equal(chainEntries[0]?.runId, chain.details?.runId);
		assert.equal(chainEntries[0]?.mode, "chain");
		const status = JSON.parse(fs.readFileSync(path.join(chain.details!.asyncDir!, "status.json"), "utf-8")) as { steps?: unknown[] };
		assert.equal(status.steps?.length, 2);
	});
});
