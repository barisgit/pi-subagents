import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { createSubagentExecutor } from "../../src/dispatch/subagent-executor.ts";
import { ChildAgentRegistry, __setChildAgentExecutorDepsForTest } from "../../src/dispatch/in-process-executor.ts";
import { readAllEntries } from "../../src/state/runs-registry.ts";
import { readStatus } from "../../src/shared/utils.ts";
import { createTempDir, makeAgent, removeTempDir } from "../support/helpers.ts";

type Listener = (event: Record<string, unknown>) => void;

interface ExecutorResult {
	isError?: boolean;
	content: Array<{ text?: string }>;
	details?: {
		mode?: string;
		runId?: string;
		children?: Array<{ runId: string; agent: string; stepIndex: number }>;
		results?: Array<{ agent?: string; task?: string; exitCode?: number; finalOutput?: string }>;
	};
}

class FakeResourceLoader {
	async reload(): Promise<void> {}
}

class FakeAgentSession {
	private listeners: Listener[] = [];
	readonly promptImpl: (task: string, session: FakeAgentSession) => Promise<void>;
	// A compliant final assistant text so the in-process executor sees a valid
	// <output> contract and does NOT inject reprompts, which would otherwise
	// re-run promptImpl twice per child and inflate counts.
	readonly messages: unknown[] = [];
	lastAssistantText = "<output>done</output>";
	private resolveAbort: (() => void) | undefined;

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
		return this.lastAssistantText;
	}

	waitForAbort(): Promise<void> {
		return new Promise((resolve) => {
			this.resolveAbort = resolve;
		});
	}

	async abort(): Promise<void> {
		this.resolveAbort?.();
	}

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

function installFakeRuntime(sessions: FakeAgentSession[], seenCwds?: string[]): () => void {
	return __setChildAgentExecutorDepsForTest({
		DefaultResourceLoader: FakeResourceLoader as never,
		getAgentDir: () => "/tmp/pi-agent",
		SessionManager: { open: (file: string) => ({ getSessionId: () => `session-${file}` }) as never },
		createAgentSession: async (options) => {
			if (options?.cwd) seenCwds?.push(options.cwd);
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

function makeCtx(cwd: string, sessionId: string | null = "session-123") {
	return {
		cwd,
		hasUI: false,
		ui: {},
		sessionManager: {
			getSessionId: () => sessionId ?? undefined,
			getSessionFile: () => null,
		},
		modelRegistry: { getAvailable: () => [{ provider: "mock", id: "test-model" }] },
		model: { provider: "mock" },
	};
}

function makeExecutor(cwd: string, state = makeState(cwd), seenDiscoveryCwds?: string[]) {
	return createSubagentExecutor({
		pi: {
			events: { emit: () => {} },
			getSessionName: () => undefined,
			setSessionName: () => {},
			getAllTools: () => [],
		},
		state,
		config: {},
		asyncByDefault: false,
		tempArtifactsDir: cwd,
		childRegistry: new ChildAgentRegistry(),
		expandTilde: (value: string) => value,
		discoverAgents: (discoveryCwd: string) => {
			seenDiscoveryCwds?.push(discoveryCwd);
			return {
				agents: ["explorer", "A", "B", "C"].map((name) => makeAgent(name, { model: "mock/test-model" })),
			};
		},
	} as never);
}

async function execute(
	cwd: string,
	params: Record<string, unknown>,
	seenDiscoveryCwds?: string[],
): Promise<ExecutorResult> {
	return makeExecutor(cwd, makeState(cwd), seenDiscoveryCwds).execute(
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

	it("resolves top-level and single-run cwd from the caller cwd", async () => {
		const seenCwds: string[] = [];
		restoreRuntime = installFakeRuntime(
			[
				new FakeAgentSession(async (_task, session) => {
					session.emit(assistantMessage("done"));
				}),
			],
			seenCwds,
		);

		const result = await execute(tempDir, {
			cwd: "workspace",
			run: [{ agent: "explorer", task: "x", cwd: "package" }],
		});

		assert.equal(result.isError, undefined, resultText(result));
		assert.deepEqual(seenCwds, [path.join(tempDir, "workspace", "package")]);
	});

	it("uses the top-level cwd for agent discovery regardless of run count", async () => {
		const seenDiscoveryCwds: string[] = [];
		restoreRuntime = installFakeRuntime(
			Array.from(
				{ length: 3 },
				() =>
					new FakeAgentSession(async (_task, session) => {
						session.emit(assistantMessage("done"));
					}),
			),
		);

		const topLevelCwd = path.join(tempDir, "workspace");
		const single = await execute(
			tempDir,
			{ cwd: "workspace", run: [{ agent: "explorer", task: "x", cwd: "package" }] },
			seenDiscoveryCwds,
		);
		const parallel = await execute(
			tempDir,
			{
				cwd: "workspace",
				run: [
					{ agent: "A", task: "one", cwd: "package" },
					{ agent: "B", task: "two", cwd: "package" },
				],
			},
			seenDiscoveryCwds,
		);

		assert.equal(single.isError, undefined, resultText(single));
		assert.equal(parallel.isError, undefined, resultText(parallel));
		assert.deepEqual(seenDiscoveryCwds, [topLevelCwd, topLevelCwd]);
	});

	it("stamps the synthesized session fallback on new run records", async () => {
		restoreRuntime = installFakeRuntime([
			new FakeAgentSession(async (_task, session) => {
				session.emit(assistantMessage("done"));
			}),
		]);
		const state = makeState(tempDir);
		const executor = makeExecutor(tempDir, state);
		const result = (await executor.execute(
			"fallback-session",
			{ run: [{ agent: "explorer", task: "persist ownership" }] } as never,
			new AbortController().signal,
			undefined,
			makeCtx(tempDir, null) as never,
		)) as ExecutorResult;

		const runId = result.details?.runId;
		assert.ok(runId);
		assert.ok(state.currentSessionId);
		assert.match(
			state.currentSessionId,
			/^session-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
		);
		const entry = readAllEntries().find((candidate) => candidate.runId === runId);
		assert.equal(entry?.rootSessionId, state.currentSessionId);
	});

	it("fresh foreground terminal status persists output, usage, and live tool counters", async () => {
		restoreRuntime = installFakeRuntime([
			new FakeAgentSession(async (_task, session) => {
				session.lastAssistantText = "<output>fresh terminal output</output>";
				session.emit({ type: "tool_execution_start", toolName: "read" });
				session.emit({ type: "tool_execution_end", toolName: "read" });
				session.emit({ type: "tool_execution_start", toolName: "bash" });
				session.emit({ type: "tool_execution_end", toolName: "bash", isError: true });
				session.emit(assistantMessage("<output>fresh terminal output</output>"));
			}),
		]);

		const result = await execute(tempDir, { run: [{ agent: "explorer", task: "persist" }] });
		const runId = result.details?.runId;
		assert.ok(runId);
		const entry = readAllEntries().find((candidate) => candidate.runId === runId);
		assert.ok(entry);
		const status = readStatus(entry.runRecordDir);
		assert.ok(status);
		assert.equal(status.state, "complete");
		assert.equal(status.outputText, "fresh terminal output");
		assert.equal(status.totalUsage?.input, 1);
		assert.equal(status.totalUsage?.output, 1);
		assert.equal(status.totalTokens?.total, 2);
		assert.equal(status.steps?.[0]?.live?.outputText, "fresh terminal output");
		assert.equal(status.steps?.[0]?.live?.toolCallCount, 2);
		assert.equal(status.steps?.[0]?.live?.toolResultCount, 2);
		assert.equal(status.steps?.[0]?.live?.toolErrorCount, 1);
	});

	it("foreground single interruption exposes its resumable run ID and resume action", async () => {
		let markStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		restoreRuntime = installFakeRuntime([
			new FakeAgentSession(async (_task, session) => {
				markStarted?.();
				await session.waitForAbort();
			}),
		]);
		const executor = makeExecutor(tempDir);
		const abortController = new AbortController();
		const resultPromise = executor.execute(
			"single-interrupt",
			{ run: [{ agent: "explorer", task: "wait" }] } as never,
			abortController.signal,
			undefined,
			makeCtx(tempDir) as never,
		) as Promise<ExecutorResult>;
		await started;
		abortController.abort("stop");

		const result = await resultPromise;
		const runId = result.details?.runId;
		assert.ok(runId);
		assert.match(resultText(result), new RegExp(runId));
		assert.match(resultText(result), /subagent\(\{ action: "resume", id:/);
		assert.match(resultText(result), /message:/);
		assert.doesNotMatch(resultText(result), /explorer/);
	});

	it("prefers the <output> block over the assistant preamble for finalOutput", async () => {
		// Regression: the child writes a prose preamble in the SAME turn as its final
		// <output> block. The parent-visible finalOutput must be the contract result
		// ("done"), never the preamble.
		restoreRuntime = installFakeRuntime([
			new FakeAgentSession(async (_task, session) => {
				session.lastAssistantText = "PREAMBLE: let me compile the findings\n<output>done</output>";
				session.emit(assistantMessage(session.lastAssistantText));
			}),
		]);

		const result = await execute(tempDir, { run: [{ agent: "explorer", task: "x" }] });

		assert.equal(result.isError, undefined, resultText(result));
		assert.equal(
			result.details?.results?.[0]?.finalOutput,
			"done",
			"finalOutput must be the <output> block, not the assistant preamble",
		);
	});

	it("foreground parallel interruption exposes every resumable child run instead of its container", async () => {
		let startedCount = 0;
		let markAllStarted: (() => void) | undefined;
		const allStarted = new Promise<void>((resolve) => {
			markAllStarted = resolve;
		});
		const waitForInterrupt = async (_task: string, session: FakeAgentSession) => {
			startedCount++;
			if (startedCount === 2) markAllStarted?.();
			await session.waitForAbort();
		};
		restoreRuntime = installFakeRuntime([
			new FakeAgentSession(waitForInterrupt),
			new FakeAgentSession(waitForInterrupt),
		]);
		const executor = makeExecutor(tempDir);
		const abortController = new AbortController();
		const resultPromise = executor.execute(
			"parallel-interrupt",
			{
				run: [
					{ agent: "A", task: "wait one" },
					{ agent: "B", task: "wait two" },
				],
			} as never,
			abortController.signal,
			undefined,
			makeCtx(tempDir) as never,
		) as Promise<ExecutorResult>;
		await allStarted;
		abortController.abort("stop");

		const result = await resultPromise;
		const containerRunId = result.details?.runId;
		const children = result.details?.children ?? [];
		assert.ok(containerRunId);
		assert.equal(children.length, 2);
		for (const child of children) {
			assert.notEqual(child.runId, containerRunId);
			assert.match(resultText(result), new RegExp(child.runId));
		}
		assert.doesNotMatch(resultText(result), /\(A\)|\(B\)/);
		assert.doesNotMatch(resultText(result), new RegExp(containerRunId));
		assert.equal(resultText(result).match(/subagent\(\{ action: "resume", id:/g)?.length, 2);
	});

	it("parallel-default dispatches run length concurrently by default", async () => {
		const starts: number[] = [];
		const seenCwds: string[] = [];
		restoreRuntime = installFakeRuntime(
			[0, 1, 2].map(
				() =>
					new FakeAgentSession(async (_task, session) => {
						starts.push(Date.now());
						await delay(80);
						session.emit(assistantMessage("parallel done"));
					}),
			),
			seenCwds,
		);

		const started = Date.now();
		const result = await execute(tempDir, {
			cwd: "workspace",
			run: [
				{ agent: "A", task: "one", cwd: "." },
				{ agent: "B", task: "two", cwd: "." },
				{ agent: "C", task: "three" },
			],
		});
		const elapsed = Date.now() - started;

		assert.equal(result.isError, undefined, resultText(result));
		assert.equal(result.details?.mode, "parallel");
		assert.equal(result.details?.results?.length, 3);
		assert.equal(starts.length, 3);
		assert.deepEqual(seenCwds, Array(3).fill(path.join(tempDir, "workspace")));
		assert.ok(Math.max(...starts) - Math.min(...starts) < 50, `expected concurrent starts: ${starts.join(",")}`);
		assert.ok(elapsed < 180, `expected default concurrency to use run.length, elapsed ${elapsed}ms`);
	});

	it("swarm-shared-message substitutes message per task", async () => {
		const seenTasks: string[] = [];
		restoreRuntime = installFakeRuntime(
			[0, 1, 2].map(
				() =>
					new FakeAgentSession(async (task, session) => {
						seenTasks.push(task);
						session.emit(assistantMessage("swarm done"));
					}),
			),
		);

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
