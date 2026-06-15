import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { createSubagentExecutor, emitRunAnchor } from "../../src/dispatch/subagent-executor.ts";
import { ChildAgentRegistry, __setChildAgentExecutorDepsForTest } from "../../src/dispatch/in-process-executor.ts";
import { readAllEntries, setRegistryPathForTests } from "../../src/state/runs-registry.ts";
import { createWorkflowTool } from "../../src/workflow/workflow.ts";
import { makeAgent } from "../support/helpers.ts";

const tmpRoots: string[] = [];
let previousHome: string | undefined;
let restoreRuntime: (() => void) | undefined;

class FakeResourceLoader {
	async reload(): Promise<void> {}
}

// A child session that completes immediately with a submit_result envelope so
// async/workflow children reach a terminal state within the test.
class FakeAgentSession {
	private listeners: Array<(event: unknown) => void> = [];
	subscribe(listener: (event: unknown) => void): () => void {
		this.listeners.push(listener);
		return () => {
			this.listeners = this.listeners.filter((entry) => entry !== listener);
		};
	}
	async prompt(task: string): Promise<void> {
		this.messages.push({
			role: "toolResult",
			toolName: "submit_result",
			isError: false,
			details: { status: "ok", summary: task, result: task, artifacts: [] },
		});
	}
	messages: unknown[] = [];
	getLastAssistantText(): string {
		return "done";
	}
	async abort(): Promise<void> {}
	dispose(): void {}
	setActiveToolsByName(): void {}
}

interface AnchorEntry {
	runId: string;
	rootRunId: string;
	mode: string;
	source: string;
}

function setupTempHome(prefix: string): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tmpRoots.push(root);
	previousHome = process.env.HOME;
	process.env.HOME = root;
	setRegistryPathForTests(path.join(root, ".pi", "agent", "pi-subagents", "runs-index.jsonl"));
	restoreRuntime = __setChildAgentExecutorDepsForTest({
		DefaultResourceLoader: FakeResourceLoader as never,
		getAgentDir: () => "/tmp/pi-agent",
		SessionManager: { open: (file: string) => ({ getSessionId: () => `session-${file}` }) as never },
		createAgentSession: async () =>
			({
				session: new FakeAgentSession() as never,
				extensionsResult: { extensions: [], diagnostics: [] },
			}) as never,
	});
	return root;
}

function makeExecutorWithAnchors(cwd: string) {
	const anchors: AnchorEntry[] = [];
	const executor = createSubagentExecutor({
		pi: {
			events: { emit: () => {} },
			getSessionName: () => undefined,
			setSessionName: () => {},
			getAllTools: () => [],
			appendEntry: (customType: string, data: AnchorEntry) => {
				if (customType === "subagent_run") anchors.push(data);
			},
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
	return { executor, anchors };
}

function makeCtx(cwd: string) {
	return {
		cwd,
		hasUI: false,
		ui: {},
		sessionManager: { getSessionId: () => "anchor-session", getSessionFile: () => null },
		modelRegistry: { getAvailable: () => [{ provider: "mock", id: "test-model" }] },
		model: { provider: "mock" },
	};
}

// The contract: every anchor runId must equal a TOP-LEVEL registry entry
// (parentRunId undefined), and every top-level registry entry must be anchored.
// Anchor.runId === Anchor.rootRunId for a host dispatch.
function assertAnchorsMatchTopLevel(anchors: AnchorEntry[]): void {
	const entries = readAllEntries();
	const topLevel = entries.filter((entry) => entry.parentRunId === undefined);
	const topLevelIds = new Set(topLevel.map((entry) => entry.runId));
	const anchorIds = new Set(anchors.map((anchor) => anchor.runId));
	assert.deepEqual(
		[...anchorIds].sort(),
		[...topLevelIds].sort(),
		`anchored runIds must equal top-level registry runIds\nanchors=${JSON.stringify(anchors)}\ntopLevel=${JSON.stringify(topLevel.map((entry) => ({ runId: entry.runId, mode: entry.mode, parentRunId: entry.parentRunId })))}`,
	);
	for (const anchor of anchors)
		assert.equal(anchor.runId, anchor.rootRunId, "host anchor runId must equal rootRunId");
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

describe("branch anchor emission (VAL-ANCHOR-EMISSION)", () => {
	it("sync single dispatch anchors exactly the top-level run", async () => {
		const root = setupTempHome("anchor-sync-single-");
		const { executor, anchors } = makeExecutorWithAnchors(root);
		await executor.execute(
			"id",
			{ run: [{ agent: "A", task: "alpha" }] } as never,
			new AbortController().signal,
			undefined,
			makeCtx(root) as never,
		);
		assert.equal(anchors.length, 1);
		assert.equal(anchors[0]?.mode, "single");
		assert.equal(anchors[0]?.source, "sync");
		assertAnchorsMatchTopLevel(anchors);
	});

	it("sync parallel anchors the group container, not the inner children", async () => {
		const root = setupTempHome("anchor-sync-parallel-");
		const { executor, anchors } = makeExecutorWithAnchors(root);
		await executor.execute(
			"id",
			{
				run: [
					{ agent: "A", task: "alpha" },
					{ agent: "B", task: "bravo" },
				],
			} as never,
			new AbortController().signal,
			undefined,
			makeCtx(root) as never,
		);
		assert.equal(anchors.length, 1, "exactly one anchor (the container), never one per child");
		assert.equal(anchors[0]?.mode, "parallel");
		assertAnchorsMatchTopLevel(anchors);
	});

	it("async single dispatch anchors the top-level run", async () => {
		const root = setupTempHome("anchor-async-single-");
		const { executor, anchors } = makeExecutorWithAnchors(root);
		await executor.execute(
			"id",
			{ run: [{ agent: "A", task: "alpha" }], async: true } as never,
			new AbortController().signal,
			undefined,
			makeCtx(root) as never,
		);
		assert.equal(anchors.length, 1);
		assert.equal(anchors[0]?.source, "async");
		assertAnchorsMatchTopLevel(anchors);
	});

	it("async parallel anchors the openGroup container id (mutant A: data.runId would be a phantom)", async () => {
		const root = setupTempHome("anchor-async-parallel-");
		const { executor, anchors } = makeExecutorWithAnchors(root);
		await executor.execute(
			"id",
			{
				run: [
					{ agent: "A", task: "alpha" },
					{ agent: "B", task: "bravo" },
				],
				async: true,
			} as never,
			new AbortController().signal,
			undefined,
			makeCtx(root) as never,
		);
		assert.equal(anchors.length, 1, "exactly one anchor for the async-parallel container");
		assert.equal(anchors[0]?.mode, "parallel");
		assert.equal(anchors[0]?.source, "async");
		assertAnchorsMatchTopLevel(anchors);
	});

	it("emitRunAnchor skips NESTED dispatches and emits for TOP-LEVEL (mutant B: dropped guard)", () => {
		const calls: AnchorEntry[] = [];
		const pi = {
			appendEntry: (customType: string, data: AnchorEntry) => {
				if (customType === "subagent_run") calls.push(data);
			},
		} as never;
		// nested dispatch (parentRunId defined) must NOT anchor
		emitRunAnchor(pi, {
			runId: "child-1",
			rootRunId: "root-1",
			mode: "single",
			source: "sync",
			parentRunId: "parent-1",
		});
		assert.equal(calls.length, 0, "a nested dispatch must never emit an anchor");
		// top-level dispatch (parentRunId undefined) must anchor
		emitRunAnchor(pi, {
			runId: "top-1",
			rootRunId: "top-1",
			mode: "single",
			source: "sync",
			parentRunId: undefined,
		});
		assert.deepEqual(calls, [{ runId: "top-1", rootRunId: "top-1", mode: "single", source: "sync" }]);
	});

	it("workflow group dispatch anchors the workflow container (mutant C: missing emit)", async () => {
		const root = setupTempHome("anchor-workflow-");
		const { executor, anchors } = makeExecutorWithAnchors(root);
		const tool = createWorkflowTool({
			openWorkflowGroup: (workflowContext) => executor.openWorkflowGroup(workflowContext),
		});
		await tool.execute?.(
			"wf",
			{ script: "await parallel([() => agent('A', 'alpha'), () => agent('B', 'bravo')]);" },
			new AbortController().signal,
			undefined,
			makeCtx(root) as never,
		);
		assert.equal(anchors.length, 1, "the workflow container must be anchored");
		assert.equal(anchors[0]?.mode, "parallel");
		assertAnchorsMatchTopLevel(anchors);
	});
});
