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
let promptGate: { started: number; expected: number; allStarted: Promise<void>; resolveAllStarted: () => void; release: Promise<void>; resolveRelease: () => void } | undefined;
let openedSessionFiles: string[] = [];

class FakeResourceLoader {
	async reload(): Promise<void> {}
}

class FakeAgentSession {
	subscribe(): () => void { return () => {}; }
	async prompt(): Promise<void> {
		if (promptGate) {
			promptGate.started++;
			if (promptGate.started === promptGate.expected) promptGate.resolveAllStarted();
			await promptGate.release;
		}
	}
	getLastAssistantText(): string { return "done"; }
	async abort(): Promise<void> {}
	dispose(): void {}
	setActiveToolsByName(): void {}
}

function defer(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => { resolve = r; });
	return { promise, resolve };
}

function installPromptGate(expected: number): void {
	const allStarted = defer();
	const release = defer();
	promptGate = { started: 0, expected, allStarted: allStarted.promise, resolveAllStarted: allStarted.resolve, release: release.promise, resolveRelease: release.resolve };
}

async function waitForPrompts(deps: any): Promise<void> {
	await Promise.race([
		promptGate!.allStarted,
		new Promise<void>((_, reject) => setTimeout(() => reject(new Error(`timed out waiting for prompts; started=${promptGate?.started ?? 0}; controls=${deps.state.foregroundControls.size}; entries=${readAllEntries().length}`)), 1000)),
	]);
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
		SessionManager: { open: (file: string) => {
			openedSessionFiles.push(file);
			return { getSessionId: () => `session-${file}` } as never;
		} },
		createAgentSession: async () => ({ session: new FakeAgentSession() as never, extensionsResult: { extensions: [], diagnostics: [] } }) as never,
	});
}

function makeDeps(cwd: string) {
	return {
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
	} as never;
}

function makeCtx(cwd: string) {
	return {
		cwd,
		hasUI: false,
		ui: {},
		sessionManager: { getSessionId: () => "session-sync-foreground-parallel", getSessionFile: () => null },
		modelRegistry: { getAvailable: () => [{ provider: "mock", id: "test-model" }] },
		model: { provider: "mock" },
	};
}

function execute(deps: any, cwd: string) {
	return createSubagentExecutor(deps).execute(
		"id",
		{ run: [{ agent: "A", task: "alpha" }, { agent: "B", task: "bravo" }] } as never,
		new AbortController().signal,
		undefined,
		makeCtx(cwd) as never,
	);
}

afterEach(() => {
	restoreRuntime?.();
	restoreRuntime = undefined;
	promptGate = undefined;
	openedSessionFiles = [];
	setRegistryPathForTests(null);
	if (previousHome === undefined) delete process.env.HOME;
	else process.env.HOME = previousHome;
	previousHome = undefined;
	for (const root of tmpRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("sync foreground parallel executor", () => {
	it("foreground parallel cleans up foregroundControls after completion", async () => {
		const root = setupTempHome("sync-foreground-parallel-cleanup-");
		installFakeRuntime();
		installPromptGate(2);
		const deps = makeDeps(root) as any;

		const running = execute(deps, root);
		await waitForPrompts(deps);

		assert.equal(deps.state.foregroundControls.size, 1);
		const registeredId = deps.state.lastForegroundControlId;
		assert.equal(typeof registeredId, "string");
		assert.ok(deps.state.foregroundControls.has(registeredId));

		promptGate!.resolveRelease();
		await running;

		assert.equal(deps.state.foregroundControls.size, 0);
		assert.equal(deps.state.lastForegroundControlId, null);
	});

	it("foreground parallel child runs use prepared layer0 session paths", async () => {
		const root = setupTempHome("sync-foreground-parallel-layer0-");
		installFakeRuntime();
		installPromptGate(2);
		const deps = makeDeps(root) as any;

		const running = execute(deps, root) as Promise<{ details?: { runId?: string } }>;
		await waitForPrompts(deps);
		const entries = readAllEntries();
		const group = entries.find((entry) => entry.mode === "parallel");
		assert.ok(group, "expected foreground parallel group entry");
		const children = entries.filter((entry) => entry.parentRunId === group.runId);
		assert.equal(children.length, 2);
		assert.deepEqual(
			deps.childRegistry.snapshot().map((entry: { runId: string }) => entry.runId).sort(),
			children.map((entry) => entry.runId).sort(),
		);
		assert.deepEqual(openedSessionFiles.sort(), children.map((entry) => path.join(entry.runRecordDir, "run-0", "session.jsonl")).sort());

		promptGate!.resolveRelease();
		const result = await running;
		assert.equal(result.details?.runId, group.runId);
	});
});
