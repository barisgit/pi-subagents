import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { createSubagentExecutor } from "../../src/dispatch/subagent-executor.ts";
import { ChildAgentRegistry, __setChildAgentExecutorDepsForTest } from "../../src/dispatch/in-process-executor.ts";
import { setCurrentPi } from "../../src/shared/current-pi.ts";
import { setRegistryPathForTests } from "../../src/state/runs-registry.ts";
import {
	SUBAGENT_ASYNC_COMPLETE_EVENT,
	SUBAGENT_ASYNC_RUN_COMPLETE_EVENT,
	SUBAGENT_ASYNC_STARTED_EVENT,
} from "../../src/protocol/types.ts";
import { createWorkflowTool } from "../../src/workflow/workflow.ts";
import type { SubagentLineage } from "../../src/state/lineage.ts";
import { makeAgent } from "../support/helpers.ts";

const roots: string[] = [];
let restoreRuntime: (() => void) | undefined;
let previousHome: string | undefined;
const globalStore = globalThis as Record<string, unknown>;
const LINEAGE_STORE_KEY = "__piSubagentLineageBySession";

function setLineageForSession(sessionId: string, lineage: SubagentLineage): void {
	let store = globalStore[LINEAGE_STORE_KEY] as Map<string, SubagentLineage> | undefined;
	if (!store) {
		store = new Map();
		globalStore[LINEAGE_STORE_KEY] = store;
	}
	store.set(sessionId, lineage);
}

function clearLineage(sessionId: string): void {
	const store = globalStore[LINEAGE_STORE_KEY] as Map<string, SubagentLineage> | undefined;
	store?.delete(sessionId);
}

function resultCount(details: unknown): number | undefined {
	if (typeof details !== "object" || details === null || !("results" in details)) return undefined;
	return Array.isArray(details.results) ? details.results.length : undefined;
}

class FakeResourceLoader {
	async reload(): Promise<void> {}
}

function deferred<T = void>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForEvent(
	events: EventEmitter,
	channel: string,
	predicate: (payload: any) => boolean = () => true,
): Promise<any> {
	return new Promise((resolve) => {
		const handler = (payload: any) => {
			if (!predicate(payload)) return;
			events.off(channel, handler);
			resolve(payload);
		};
		events.on(channel, handler);
	});
}

function setup(
	prefix: string,
	options: { asyncByDefault?: boolean; blockPrompt?: boolean; promptDelayMs?: (task: string) => number } = {},
) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	roots.push(root);
	previousHome = process.env.HOME;
	process.env.HOME = root;
	setRegistryPathForTests(path.join(root, ".pi", "agent", "pi-subagents", "runs-index.jsonl"));
	const promptGate = deferred();
	const promptStarted = deferred();
	class FakeSession {
		messages: unknown[] = [];
		subscribe(): () => void {
			return () => {};
		}
		async prompt(task: string): Promise<void> {
			promptStarted.resolve();
			if (options.blockPrompt) await promptGate.promise;
			const delayMs = options.promptDelayMs?.(task) ?? 0;
			if (delayMs > 0) await sleep(delayMs);
			this.lastAssistantText = `<output>${task}</output>`;
		}
		lastAssistantText = "";
		getLastAssistantText(): string {
			return this.lastAssistantText;
		}
		async abort(): Promise<void> {}
		dispose(): void {}
		setActiveToolsByName(): void {}
	}
	restoreRuntime = __setChildAgentExecutorDepsForTest({
		DefaultResourceLoader: FakeResourceLoader as never,
		getAgentDir: () => "/tmp/pi-agent",
		SessionManager: { open: (file: string) => ({ getSessionId: () => `session-${file}` }) as never },
		createAgentSession: async () =>
			({ session: new FakeSession() as never, extensionsResult: { extensions: [], diagnostics: [] } }) as never,
	});
	const events = new EventEmitter();
	const pi = {
		events: {
			emit: (channel: string, data: unknown) => events.emit(channel, data),
			on: (channel: string, handler: (data: unknown) => void) => {
				events.on(channel, handler);
				return () => events.off(channel, handler);
			},
		},
		getSessionName: () => undefined,
		setSessionName: () => {},
		getAllTools: () => [],
	};
	setCurrentPi(pi as never);
	const executor = createSubagentExecutor({
		pi,
		state: {
			baseCwd: root,
			currentSessionId: null,
			asyncJobs: new Map(),
			foregroundControls: new Map(),
			lastForegroundControlId: null,
			cleanupTimers: new Map(),
			lastUiContext: null,
			poller: null,
		},
		config: {},
		asyncByDefault: options.asyncByDefault ?? false,
		tempArtifactsDir: root,
		childRegistry: new ChildAgentRegistry(),
		expandTilde: (value: string) => value,
		discoverAgents: () => ({
			agents: [
				makeAgent("A", { model: "mock/test-model" }),
				makeAgent("B", { model: "mock/test-model" }),
				makeAgent("SLOW", { model: "mock/test-model" }),
				makeAgent("FAST", { model: "mock/test-model" }),
			],
		}),
	} as never);
	const ctx = {
		cwd: root,
		hasUI: false,
		ui: {},
		sessionManager: { getSessionId: () => "workflow-parent", getSessionFile: () => null },
		modelRegistry: { getAvailable: () => [{ provider: "mock", id: "test-model" }] },
		model: { provider: "mock" },
	};
	const tool = createWorkflowTool({
		openWorkflowGroup: (workflowContext) => executor.openWorkflowGroup(workflowContext),
	});
	return { events, executor, tool, ctx, promptGate, promptStarted };
}

afterEach(() => {
	restoreRuntime?.();
	restoreRuntime = undefined;
	setRegistryPathForTests(null);
	if (previousHome === undefined) delete process.env.HOME;
	else process.env.HOME = previousHome;
	previousHome = undefined;
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("workflow async execution (VAL-ASYNC-WORKFLOW)", () => {
	it("runs all requested subagent async modes synchronously from child lineage", async () => {
		const sessionId = "workflow-parent";
		const { executor, ctx } = setup("nested-subagent-async-modes-", { asyncByDefault: true });
		setLineageForSession(sessionId, {
			role: "child",
			currentAgent: "A",
			parentAgent: "host-role",
			parentSessionId: "host-session",
			rootSessionId: "host-session",
			depth: 1,
			runId: "parent-run",
			canDelegate: true,
			allowedDelegateAgents: ["A"],
			maxSubagentDepth: 2,
		});

		try {
			for (const [name, asyncMode] of [
				["explicit true", true],
				["omitted default", undefined],
				["explicit false", false],
			] as const) {
				const result = await executor.execute(
					`nested-${name}`,
					{
						run: [{ agent: "A", task: name }],
						...(asyncMode === undefined ? {} : { async: asyncMode }),
					},
					new AbortController().signal,
					undefined,
					ctx as never,
				);

				assert.equal(result.isError, undefined, name);
				assert.equal(result.details?.results.length, 1, name);
				assert.equal("asyncId" in (result.details ?? {}), false, name);
			}
		} finally {
			clearLineage(sessionId);
		}
	});

	it("preserves host subagent async defaults and explicit overrides", async () => {
		const { executor, ctx } = setup("host-subagent-async-modes-", { asyncByDefault: true });

		for (const [name, asyncMode] of [
			["explicit true", true],
			["omitted default", undefined],
		] as const) {
			const result = await executor.execute(
				`host-${name}`,
				{
					run: [{ agent: "A", task: name }],
					...(asyncMode === undefined ? {} : { async: asyncMode }),
				},
				new AbortController().signal,
				undefined,
				ctx as never,
			);
			assert.equal(typeof result.details?.asyncId, "string", name);
			assert.equal(result.details?.results.length, 0, name);
		}

		const foreground = await executor.execute(
			"host-explicit-false",
			{ run: [{ agent: "A", task: "explicit false" }], async: false },
			new AbortController().signal,
			undefined,
			ctx as never,
		);
		assert.equal(foreground.details?.results.length, 1);
		assert.equal("asyncId" in (foreground.details ?? {}), false);
	});

	it("runs explicit and default async workflows synchronously from child lineage", async () => {
		const sessionId = "workflow-parent";
		const { tool, ctx } = setup("nested-workflow-async-modes-", { asyncByDefault: true });
		setLineageForSession(sessionId, {
			role: "child",
			currentAgent: "A",
			parentAgent: "host-role",
			parentSessionId: "host-session",
			rootSessionId: "host-session",
			depth: 1,
			runId: "parent-run",
			canDelegate: true,
			allowedDelegateAgents: ["A"],
			maxSubagentDepth: 2,
		});

		try {
			for (const [name, asyncMode] of [
				["explicit true", true],
				["omitted default", undefined],
			] as const) {
				const result = await tool.execute?.(
					`wf-${name}`,
					{
						script: `await agent('A', '${name}');`,
						...(asyncMode === undefined ? {} : { async: asyncMode }),
					},
					new AbortController().signal,
					undefined,
					ctx as never,
				);

				assert.equal(result?.isError, undefined, name);
				assert.equal(resultCount(result?.details), 1, name);
				assert.equal("asyncId" in ((result?.details as object | undefined) ?? {}), false, name);
			}
		} finally {
			clearLineage(sessionId);
		}
	});

	it("params.async:true returns a running stub before the script finishes", async () => {
		const { tool, ctx, promptGate, promptStarted } = setup("workflow-async-stub-", { blockPrompt: true });

		const result = await tool.execute?.(
			"wf",
			{ script: "await agent('A', 'slow');\nreturn 'done';", async: true },
			new AbortController().signal,
			undefined,
			ctx as never,
		);
		await promptStarted.promise;

		assert.equal(result?.isError, undefined);
		assert.equal(
			(result?.content[0] as { text?: string }).text?.startsWith("Workflow running...\nState: running"),
			true,
		);
		assert.deepEqual((result?.details as any).results, []);
		assert.equal((result?.details as any).asyncId, (result?.details as any).runId);
		assert.equal(typeof (result?.details as any).asyncDir, "string");
		promptGate.resolve();
	});

	it("params.async:false remains synchronous when asyncByDefault is true", async () => {
		const { tool, ctx } = setup("workflow-sync-override-", { asyncByDefault: true });

		const result = await tool.execute?.(
			"wf",
			{ script: "await agent('A', 'explicit sync');", async: false },
			new AbortController().signal,
			undefined,
			ctx as never,
		);

		assert.equal(resultCount(result?.details), 1);
		assert.equal("asyncId" in ((result?.details as object | undefined) ?? {}), false);
	});

	it("asyncByDefault:true backgrounds without params.async", async () => {
		const { tool, ctx, promptGate, promptStarted } = setup("workflow-async-default-", {
			asyncByDefault: true,
			blockPrompt: true,
		});

		const result = await tool.execute?.(
			"wf",
			{ script: "await agent('A', 'default async');" },
			new AbortController().signal,
			undefined,
			ctx as never,
		);
		await promptStarted.promise;

		assert.deepEqual((result?.details as any).results, []);
		assert.equal((result?.details as any).asyncId, (result?.details as any).runId);
		promptGate.resolve();
	});

	it("emits per-child async started and complete events under the workflow group", async () => {
		const { events, tool, ctx, promptGate } = setup("workflow-async-events-", { blockPrompt: true });
		// The group emits its own STARTED first (the widget's single workflow
		// row); the child STARTED carries parentRunId.
		const groupStartedPromise = waitForEvent(
			events,
			SUBAGENT_ASYNC_STARTED_EVENT,
			(payload) => payload.kind === "workflow",
		);
		const startedPromise = waitForEvent(
			events,
			SUBAGENT_ASYNC_STARTED_EVENT,
			(payload) => payload.kind !== "workflow",
		);
		const runCompletePromise = waitForEvent(events, SUBAGENT_ASYNC_RUN_COMPLETE_EVENT);

		const result = await tool.execute?.(
			"wf",
			{ script: "await agent('A', 'alpha');", async: true },
			new AbortController().signal,
			undefined,
			ctx as never,
		);
		const groupRunId = (result?.details as any).runId;
		const completePromise = waitForEvent(
			events,
			SUBAGENT_ASYNC_COMPLETE_EVENT,
			(payload) => payload.runId === groupRunId,
		);
		const groupStarted = await groupStartedPromise;
		assert.equal(groupStarted.id, groupRunId, "group STARTED must carry the group runId");
		assert.equal(groupStarted.agent, "workflow");
		assert.equal(groupStarted.parentRunId, undefined, "group row is a root row");
		const started = await startedPromise;
		promptGate.resolve();
		const runComplete = await runCompletePromise;
		const complete = await completePromise;

		assert.equal(started.parentRunId, groupRunId);
		assert.equal(started.id, started.runId);
		assert.equal(started.agent, "A");
		assert.equal(runComplete.parentRunId, groupRunId);
		assert.equal(runComplete.runId, started.runId);
		assert.equal(runComplete.notifyPolicy, "silent", "mutant: workflow children must not notify individually");
		assert.equal(complete.kind, "workflow", "mutant: group COMPLETE must self-identify as a workflow");
		assert.equal(complete.id, groupRunId, "mutant: group COMPLETE id must be the group runId, not a child runId");
		assert.notEqual(complete.id, started.runId, "mutant guard: child runId differs from group runId");
		assert.equal(complete.runId, groupRunId);
		assert.equal(complete.children[0].runId, started.runId);
		assert.equal(complete.total, 1);
		assert.equal(complete.completed, 1);
	});

	it("preserves dispatch order in async workflow complete event children", async () => {
		const { events, tool, ctx } = setup("workflow-async-child-order-", {
			promptDelayMs: (task) => (task === "a" ? 30 : 0),
		});
		const completePromise = waitForEvent(events, SUBAGENT_ASYNC_COMPLETE_EVENT);

		const result = await tool.execute?.(
			"wf",
			{ script: "await parallel([() => agent('SLOW', 'a'), () => agent('FAST', 'b')]);", async: true },
			new AbortController().signal,
			undefined,
			ctx as never,
		);
		const groupRunId = (result?.details as any).runId;
		const complete = await completePromise;
		assert.equal(complete.runId, groupRunId);

		assert.equal(complete.children.length, 2);
		assert.equal(
			complete.children[0].stepIndex,
			0,
			"mutant: first completed child must not be renumbered to dispatch index 0",
		);
		assert.equal(complete.children[0].agent, "SLOW");
		assert.equal(complete.children[1].stepIndex, 1);
		assert.equal(complete.children[1].agent, "FAST");
		assert.equal(complete.agent, "workflow");
		assert.equal(complete.agents, "SLOW,FAST");
	});

	it("sync path surfaces the raw script value via content text and a real Details snapshot", async () => {
		const { tool, ctx } = setup("workflow-sync-raw-");

		const result = await tool.execute?.(
			"wf",
			{ script: "return { value: 42 };" },
			new AbortController().signal,
			undefined,
			ctx as never,
		);

		// Value lives in content text; details is always a real Details (here the empty
		// snapshot for a script that dispatched no agents), never the arbitrary value.
		assert.equal((result?.content[0] as { text?: string }).text, '{\n  "value": 42\n}');
		assert.deepEqual(JSON.parse(JSON.stringify(result?.details)), {
			mode: "parallel",
			workflow: true,
			results: [],
			progress: [],
			agentGroups: [],
			totalSteps: 0,
		});
	});
});
