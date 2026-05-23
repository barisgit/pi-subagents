import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createSubagentExecutor } from "../../subagent-executor.ts";
import { ChildAgentRegistry, __setChildAgentExecutorDepsForTest } from "../../in-process-executor.ts";
import { createTempDir, makeAgent, removeTempDir } from "../support/helpers.ts";

type Listener = (event: Record<string, unknown>) => void;

interface ExecutorResult {
	isError?: boolean;
	content: Array<{ text?: string }>;
	details?: {
		mode?: string;
		results?: Array<{ agent?: string; task?: string; exitCode?: number; finalOutput?: string }>;
	};
}

class FakeResourceLoader {
	async reload(): Promise<void> {}
}

class FakeAgentSession {
	private listeners: Listener[] = [];
	readonly promptImpl: (task: string, session: FakeAgentSession) => Promise<void>;

	constructor(promptImpl: (task: string, session: FakeAgentSession) => Promise<void>) {
		this.promptImpl = promptImpl;
	}

	subscribe(listener: Listener): () => void {
		this.listeners.push(listener);
		return () => {
			this.listeners = this.listeners.filter((candidate) => candidate !== listener);
		};
	}

	emit(event: Record<string, unknown>): void {
		for (const listener of this.listeners) listener(event);
	}

	async prompt(task: string): Promise<void> {
		await this.promptImpl(task, this);
	}

	getLastAssistantText(): string {
		return "";
	}

	async abort(): Promise<void> {}

	dispose(): void {}

	setActiveToolsByName(): void {}
}

function assistantMessage(text: string): Record<string, unknown> {
	return {
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			model: "mock/test-model",
			stopReason: "stop",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
		},
	};
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function installFakeRuntime(sessions: FakeAgentSession[]): () => void {
	return __setChildAgentExecutorDepsForTest({
		DefaultResourceLoader: FakeResourceLoader as never,
		getAgentDir: () => "/tmp/pi-agent",
		SessionManager: { open: (file: string) => ({ getSessionId: () => `session-${file}` }) as never },
		createAgentSession: async () => {
			const session = sessions.shift();
			if (!session) throw new Error("No fake session queued");
			return { session: session as never, extensionsResult: { extensions: [], diagnostics: [] } } as never;
		},
	});
}

function makeState(cwd: string) {
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

function makeCtx(cwd: string) {
	return {
		cwd,
		hasUI: false,
		ui: {},
		sessionManager: {
			getSessionId: () => "session-123",
			getSessionFile: () => null,
		},
		modelRegistry: { getAvailable: () => [{ provider: "mock", id: "test-model" }] },
		model: { provider: "mock" },
	};
}

function makeExecutor(cwd: string) {
	return createSubagentExecutor({
		pi: {
			events: { emit: () => {} },
			getSessionName: () => undefined,
			setSessionName: () => {},
			getAllTools: () => [],
		},
		state: makeState(cwd),
		config: { parallel: { concurrency: 1 } },
		asyncByDefault: false,
		tempArtifactsDir: cwd,
		childRegistry: new ChildAgentRegistry(),
		expandTilde: (value: string) => value,
		discoverAgents: () => ({
			agents: ["A", "B1", "B2", "C"].map((name) => makeAgent(name, { model: "mock/test-model" })),
		}),
	} as never);
}

async function execute(cwd: string, params: Record<string, unknown>): Promise<ExecutorResult> {
	return makeExecutor(cwd).execute(
		"id",
		params as never,
		new AbortController().signal,
		undefined,
		makeCtx(cwd) as never,
	) as Promise<ExecutorResult>;
}

function resultText(result: ExecutorResult): string {
	return result.content[0]?.text ?? "";
}

describe("chain nest", () => {
	let tempDir: string;
	let restoreRuntime: (() => void) | undefined;

	beforeEach(() => {
		tempDir = createTempDir("pi-subagent-chain-nest-");
	});

	afterEach(() => {
		restoreRuntime?.();
		restoreRuntime = undefined;
		removeTempDir(tempDir);
	});

	it("chain-nest previous-merged-from-parallel-step", async () => {
		const seenTasks: string[] = [];
		restoreRuntime = installFakeRuntime([
			new FakeAgentSession(async (task, session) => {
				seenTasks.push(task);
				session.emit(assistantMessage("a done"));
			}),
			new FakeAgentSession(async (task, session) => {
				seenTasks.push(task);
				await delay(20);
				session.emit(assistantMessage("foo"));
			}),
			new FakeAgentSession(async (task, session) => {
				seenTasks.push(task);
				session.emit(assistantMessage("bar"));
			}),
			new FakeAgentSession(async (task, session) => {
				seenTasks.push(task);
				session.emit(assistantMessage("c done"));
			}),
		]);

		const result = await execute(tempDir, {
			run: [
				{ agent: "A", task: "first" },
				[
					{ agent: "B1", task: "b1 sees {previous}" },
					{ agent: "B2", task: "b2 sees {previous}" },
				],
				{ agent: "C", task: "c sees {previous}" },
			],
			chain: true,
		});

		assert.equal(result.isError, undefined, resultText(result));
		assert.equal(result.details?.mode, "chain");
		assert.equal(result.details?.results?.length, 4);
		assert.deepEqual(seenTasks.slice(0, 3).sort(), ["b1 sees a done", "b2 sees a done", "first"].sort());
		const finalTask = seenTasks[3] ?? "";
		assert.match(finalTask, /=== Parallel Task 1 \(B1\) ===/);
		assert.match(finalTask, /=== Parallel Task 2 \(B2\) ===/);
		assert.match(finalTask, /foo/);
		assert.match(finalTask, /bar/);
	});

	it("nested-array-without-chain-rejected", async () => {
		const result = await execute(tempDir, {
			run: [
				{ agent: "A", task: "first" },
				[
					{ agent: "B1", task: "foo" },
					{ agent: "B2", task: "bar" },
				],
				{ agent: "C", task: "last" },
			],
		});

		assert.equal(result.isError, true);
		assert.match(resultText(result), /Nested Task\[\] only allowed inside `chain:true`/);
	});

	it("legacy-tasks-key-rejected", async () => {
		const result = await execute(tempDir, {
			run: [
				{ agent: "A", task: "first" },
				{ tasks: [{ agent: "B1", task: "legacy" }] },
			],
			chain: true,
		});

		assert.equal(result.isError, true);
		assert.match(resultText(result), /Unknown task key 'tasks' at run\[1\]/);
	});

	it("legacy-parallel-key-rejected", async () => {
		const result = await execute(tempDir, {
			run: [
				{ agent: "A", task: "first" },
				{ parallel: true, children: [{ agent: "B1", task: "legacy" }] },
			],
			chain: true,
		});

		assert.equal(result.isError, true);
		assert.match(resultText(result), /Unknown task key 'parallel' at run\[1\]/);
	});
});
