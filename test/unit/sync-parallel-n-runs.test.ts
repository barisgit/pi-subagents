import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { createSubagentExecutor } from "../../subagent-executor.ts";
import { ChildAgentRegistry, __setChildAgentExecutorDepsForTest } from "../../in-process-executor.ts";
import { readAllEntries, setRegistryPathForTests } from "../../runs-registry.ts";
import { makeAgent } from "../support/helpers.ts";

const tmpRoots: string[] = [];
let previousHome: string | undefined;
let restoreRuntime: (() => void) | undefined;

class FakeResourceLoader {
	async reload(): Promise<void> {}
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

function makeExecutor(cwd: string) {
	return createSubagentExecutor({
		pi: {
			events: { emit: () => {} },
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
		sessionManager: { getSessionId: () => "session-sync-parallel-n-runs", getSessionFile: () => null },
		modelRegistry: { getAvailable: () => [{ provider: "mock", id: "test-model" }] },
		model: { provider: "mock" },
	};
}

async function execute(cwd: string): Promise<{ details?: { runId?: string } }> {
	return await makeExecutor(cwd).execute(
		"id",
		{ run: [{ agent: "A", task: "alpha" }, { agent: "B", task: "bravo" }] } as never,
		new AbortController().signal,
		undefined,
		makeCtx(cwd) as never,
	) as { details?: { runId?: string } };
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

describe("sync parallel Layer-0 run wiring", () => {
	it("sync parallel mints N child runs under a group like async; no legacy agentNames entry", async () => {
		const root = setupTempHome("sync-parallel-n-runs-test-");
		installFakeRuntime();

		const result = await execute(root);
		const entries = readAllEntries();
		const group = entries.find((entry) => entry.runId === result.details?.runId);
		assert.ok(group, "expected returned runId to be the group runId");
		assert.equal(group.mode, "parallel");
		assert.equal(group.source, "sync");
		assert.equal(Object.hasOwn(group, "agentName"), false);
		assert.equal(Object.hasOwn(group, "agentNames"), false);

		const children = entries.filter((entry) => entry.parentRunId === group.runId);
		assert.equal(children.length, 2);
		assert.equal(new Set(children.map((entry) => entry.runId)).size, 2);
		assert.deepEqual(children.map((entry) => entry.agentName).sort(), ["A", "B"]);
		assert.equal(children.every((entry) => entry.mode === "single" && entry.source === "sync"), true);
		assert.equal(entries.some((entry) => Object.hasOwn(entry, "agentNames")), false);
	});
});
