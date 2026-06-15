import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createSubagentExecutor } from "../../src/dispatch/subagent-executor.ts";
import { ChildAgentRegistry, __setChildAgentExecutorDepsForTest } from "../../src/dispatch/in-process-executor.ts";
import registerSubagentNotify from "../../src/surfaces/notify.ts";
import { setCurrentPi } from "../../src/shared/current-pi.ts";
import { SUBAGENT_ASYNC_COMPLETE_EVENT } from "../../src/protocol/types.ts";
import { createTempDir, makeAgent, removeTempDir } from "../support/helpers.ts";

type Listener = (event: Record<string, unknown>) => void;

interface ExecutorResult {
	isError?: boolean;
	content: Array<{ text?: string }>;
	details?: {
		mode?: string;
		runId?: string;
		asyncDir?: string;
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

function waitFor(predicate: () => boolean, message: string, timeoutMs = 1000): Promise<void> {
	const started = Date.now();
	return new Promise((resolve, reject) => {
		const tick = () => {
			if (predicate()) {
				resolve();
				return;
			}
			if (Date.now() - started > timeoutMs) {
				reject(new Error(message));
				return;
			}
			setTimeout(tick, 10);
		};
		tick();
	});
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

function createBus() {
	const inner = new EventEmitter();
	return {
		inner,
		bus: {
			on(channel: string, handler: (data: unknown) => void): () => void {
				inner.on(channel, handler);
				return () => inner.off(channel, handler);
			},
			emit(channel: string, data: unknown) {
				inner.emit(channel, data);
			},
		},
	};
}

function makeHarness(cwd: string) {
	const state = makeState(cwd);
	const childRegistry = new ChildAgentRegistry();
	const sent: Array<{ message: { customType?: string; content?: string; display?: boolean }; options: unknown }> = [];
	const completionEvents: Record<string, unknown>[] = [];
	const { bus, inner } = createBus();
	const pi = {
		events: bus,
		on: () => {},
		getSessionName: () => undefined,
		setSessionName: () => {},
		getAllTools: () => [],
		sendMessage(message: { customType?: string; content?: string; display?: boolean }, options: unknown) {
			sent.push({ message, options });
		},
	};
	inner.on(SUBAGENT_ASYNC_COMPLETE_EVENT, (event) => completionEvents.push(event as Record<string, unknown>));
	setCurrentPi(pi as never);
	registerSubagentNotify(pi as never);
	const executor = createSubagentExecutor({
		pi,
		state,
		config: { parallel: { concurrency: 1 } },
		asyncByDefault: false,
		tempArtifactsDir: cwd,
		childRegistry,
		expandTilde: (value: string) => value,
		discoverAgents: () => ({
			agents: ["A", "B", "C"].map((name) => makeAgent(name, { model: "mock/test-model" })),
		}),
	} as never);
	const execute = (params: Record<string, unknown>): Promise<ExecutorResult> =>
		executor.execute(
			"id",
			params as never,
			new AbortController().signal,
			undefined,
			makeCtx(cwd) as never,
		) as Promise<ExecutorResult>;
	return { execute, state, sent, completionEvents };
}

function resultText(result: ExecutorResult): string {
	return result.content[0]?.text ?? "";
}

function childRows(event: Record<string, unknown>): Array<Record<string, unknown>> {
	return event.children as Array<Record<string, unknown>>;
}

describe("batch notifications", () => {
	let tempDir: string;
	let restoreRuntime: (() => void) | undefined;

	beforeEach(() => {
		tempDir = createTempDir("pi-subagent-batch-notifications-");
	});

	afterEach(() => {
		restoreRuntime?.();
		restoreRuntime = undefined;
		removeTempDir(tempDir);
	});

	it("per-run-default emits one completion notification per child", async () => {
		restoreRuntime = installFakeRuntime(
			["one", "two", "three"].map(
				(output) =>
					new FakeAgentSession(async (_task, session) => {
						session.emit(assistantMessage(output));
					}),
			),
		);
		const harness = makeHarness(tempDir);

		const result = await harness.execute({
			async: true,
			run: [
				{ agent: "A", task: "one" },
				{ agent: "B", task: "two" },
				{ agent: "C", task: "three" },
			],
		});

		assert.equal(result.isError, undefined, resultText(result));
		await waitFor(() => harness.sent.length === 3, "expected three per-child notifications");
		assert.equal(harness.completionEvents.length, 1);
		assert.equal(harness.sent.length, 3);
		assert.deepEqual(
			harness.sent.map((entry) => entry.message.customType),
			["subagent-notify", "subagent-notify", "subagent-notify"],
		);
		assert.ok(harness.sent.every((entry) => entry.message.content?.startsWith("Background task completed:")));
		assert.ok(harness.sent[0]!.message.content?.includes("(1/3)"));
		assert.ok(harness.sent[1]!.message.content?.includes("(2/3)"));
		assert.ok(harness.sent[2]!.message.content?.includes("(3/3)"));
	});

	it("rollup-when-batch-true emits one rollup with all child runIds and states", async () => {
		restoreRuntime = installFakeRuntime(
			["one", "two", "three"].map(
				(output) =>
					new FakeAgentSession(async (_task, session) => {
						session.emit(assistantMessage(output));
					}),
			),
		);
		const harness = makeHarness(tempDir);

		const result = await harness.execute({
			async: true,
			batch: true,
			run: [
				{ agent: "A", task: "one" },
				{ agent: "B", task: "two" },
				{ agent: "C", task: "three" },
			],
		});

		assert.equal(result.isError, undefined, resultText(result));
		await waitFor(() => harness.sent.length === 1, "expected one batch rollup notification");
		const event = harness.completionEvents[0]!;
		const rows = childRows(event);
		assert.equal(event.batch, true);
		assert.equal(event.total, 3);
		assert.equal(event.completed, 3);
		assert.equal(rows.length, 3);
		assert.deepEqual(
			rows.map((row) => row.state),
			["complete", "complete", "complete"],
		);
		const content = harness.sent[0]!.message.content ?? "";
		for (const row of rows) {
			assert.ok(content.includes(String(row.agent)), `content should include ${String(row.agent)}`);
			assert.ok(content.includes(String(row.state)), `content should include ${String(row.state)}`);
		}
	});

	it("interrupt-mid-flight-rollup emits mixed complete and interrupted states", async () => {
		restoreRuntime = installFakeRuntime([
			new FakeAgentSession(async (_task, session) => {
				await delay(20);
				session.emit(assistantMessage("one"));
			}),
			new FakeAgentSession(async (_task, session) => {
				await delay(500);
				session.emit(assistantMessage("two"));
			}),
			new FakeAgentSession(async (_task, session) => {
				await delay(500);
				session.emit(assistantMessage("three"));
			}),
		]);
		const harness = makeHarness(tempDir);

		const result = await harness.execute({
			async: true,
			batch: true,
			run: [
				{ agent: "A", task: "one" },
				{ agent: "B", task: "two" },
				{ agent: "C", task: "three" },
			],
		});
		assert.equal(result.isError, undefined, resultText(result));
		const runId = result.details?.runId;
		assert.ok(runId);
		harness.state.asyncJobs.set(runId, {
			asyncId: runId,
			asyncDir: result.details?.asyncDir ?? tempDir,
			status: "running",
			updatedAt: Date.now(),
		});

		await delay(80);
		const interrupt = await harness.execute({ action: "interrupt", id: runId });
		assert.equal(interrupt.isError, undefined, resultText(interrupt));
		await waitFor(() => harness.sent.length === 1, "expected one interrupted batch rollup notification");
		const event = harness.completionEvents[0]!;
		const states = childRows(event).map((row) => row.state);
		assert.equal(states.length, 3);
		assert.ok(states.includes("complete"), `expected a completed child, got ${states.join(",")}`);
		assert.ok(states.includes("interrupted"), `expected an interrupted child, got ${states.join(",")}`);
		const content = harness.sent[0]!.message.content ?? "";
		assert.ok(content.includes("complete"));
		assert.ok(content.includes("interrupted"));
	});

	it("single-child-batch-degenerate emits one rollup with one entry", async () => {
		restoreRuntime = installFakeRuntime([
			new FakeAgentSession(async (_task, session) => {
				session.emit(assistantMessage("one"));
			}),
		]);
		const harness = makeHarness(tempDir);

		const result = await harness.execute({
			async: true,
			batch: true,
			run: [{ agent: "A", task: "one" }],
		});

		assert.equal(result.isError, undefined, resultText(result));
		await waitFor(() => harness.sent.length === 1, "expected one single-child batch notification");
		const event = harness.completionEvents[0]!;
		const rows = childRows(event);
		assert.equal(event.batch, true);
		assert.equal(event.total, 1);
		assert.equal(event.completed, 1);
		assert.equal(rows.length, 1);
		assert.equal(rows[0]!.state, "complete");
		assert.ok((harness.sent[0]!.message.content ?? "").includes(String(rows[0]!.agent)));
	});
});
