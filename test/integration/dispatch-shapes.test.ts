import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createSubagentExecutor } from "../../src/dispatch/subagent-executor.ts";
import { ChildAgentRegistry, __setChildAgentExecutorDepsForTest } from "../../src/dispatch/in-process-executor.ts";
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
			agents: ["explorer", "A", "B", "C"].map((name) => makeAgent(name, { model: "mock/test-model" })),
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

describe("dispatch shapes", () => {
	let tempDir: string;
	let restoreRuntime: (() => void) | undefined;

	beforeEach(() => {
		tempDir = createTempDir("pi-subagent-dispatch-shapes-");
	});

	afterEach(() => {
		restoreRuntime?.();
		restoreRuntime = undefined;
		removeTempDir(tempDir);
	});

	it("length-1-single dispatches one child agent", async () => {
		const seenTasks: string[] = [];
		restoreRuntime = installFakeRuntime([
			new FakeAgentSession(async (task, session) => {
				seenTasks.push(task);
				session.emit(assistantMessage("single done"));
			}),
		]);

		const result = await execute(tempDir, { run: [{ agent: "explorer", task: "x" }] });

		assert.equal(result.isError, undefined, resultText(result));
		assert.equal(result.details?.mode, "single");
		assert.equal(result.details?.results?.length, 1);
		assert.equal(result.details?.results?.[0]?.agent, "explorer");
		assert.deepEqual(seenTasks, ["x"]);
	});

	it("parallel-default dispatches run length concurrently by default", async () => {
		const starts: number[] = [];
		restoreRuntime = installFakeRuntime([0, 1, 2].map(() => new FakeAgentSession(async (_task, session) => {
			starts.push(Date.now());
			await delay(80);
			session.emit(assistantMessage("parallel done"));
		})));

		const started = Date.now();
		const result = await execute(tempDir, {
			run: [
				{ agent: "A", task: "one" },
				{ agent: "B", task: "two" },
				{ agent: "C", task: "three" },
			],
		});
		const elapsed = Date.now() - started;

		assert.equal(result.isError, undefined, resultText(result));
		assert.equal(result.details?.mode, "parallel");
		assert.equal(result.details?.results?.length, 3);
		assert.equal(starts.length, 3);
		assert.ok(Math.max(...starts) - Math.min(...starts) < 50, `expected concurrent starts: ${starts.join(",")}`);
		assert.ok(elapsed < 180, `expected default concurrency to use run.length, elapsed ${elapsed}ms`);
	});


	it("swarm-shared-message substitutes message per task", async () => {
		const seenTasks: string[] = [];
		restoreRuntime = installFakeRuntime([0, 1, 2].map(() => new FakeAgentSession(async (task, session) => {
			seenTasks.push(task);
			session.emit(assistantMessage("swarm done"));
		})));

		const result = await execute(tempDir, {
			run: [
				{ agent: "A", task: "alpha" },
				{ agent: "B", task: "beta" },
				{ agent: "C", task: "gamma" },
			],
			message: "format: {in}",
		});

		assert.equal(result.isError, undefined, resultText(result));
		assert.equal(result.details?.mode, "parallel");
		assert.deepEqual(seenTasks.sort(), ["format: alpha", "format: beta", "format: gamma"].sort());
	});

	it("empty-run-rejected", async () => {
		const result = await execute(tempDir, { run: [] });

		assert.equal(result.isError, true);
		assert.match(resultText(result), /`run` must contain at least one task/);
	});

	it("top-level-task-rejected", async () => {
		const result = await execute(tempDir, { task: "x", agent: "y" });

		assert.equal(result.isError, true);
		assert.match(resultText(result), /Unknown top-level key '(task|agent)'/);
	});

	it("top-level-tasks-rejected", async () => {
		const result = await execute(tempDir, { tasks: [{ agent: "A", task: "x" }] });

		assert.equal(result.isError, true);
		assert.match(resultText(result), /Unknown top-level key 'tasks'/);
	});
});
