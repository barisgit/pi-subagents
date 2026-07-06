import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { EventEmitter } from "node:events";
import { createSubagentExecutor } from "../../src/dispatch/subagent-executor.ts";
import { ChildAgentRegistry, __setChildAgentExecutorDepsForTest } from "../../src/dispatch/in-process-executor.ts";
import { interruptRun, registerRunController, releaseRunController } from "../../src/dispatch/layer0-runs.ts";
import { setRegistryPathForTests } from "../../src/state/runs-registry.ts";
import { setCurrentPi } from "../../src/shared/current-pi.ts";
import { SUBAGENT_ASYNC_COMPLETE_EVENT } from "../../src/protocol/types.ts";
import { createTempDir, makeAgent, removeTempDir } from "../support/helpers.ts";
import * as path from "node:path";
import type { SubagentState } from "../../src/protocol/types.ts";

type Listener = (event: Record<string, unknown>) => void;

interface ExecutorResult {
	isError?: boolean;
	content: Array<{ text?: string }>;
	details?: { runId?: string; asyncDir?: string };
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

function waitFor(predicate: () => boolean, message: string, timeoutMs = 2000): Promise<void> {
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

function makeState(cwd: string): SubagentState {
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

function makeHarness(cwd: string) {
	const state = makeState(cwd);
	const childRegistry = new ChildAgentRegistry();
	const completionEvents: Record<string, unknown>[] = [];
	const inner = new EventEmitter();
	const pi = {
		events: {
			on(channel: string, handler: (data: unknown) => void): () => void {
				inner.on(channel, handler);
				return () => inner.off(channel, handler);
			},
			emit(channel: string, data: unknown) {
				inner.emit(channel, data);
			},
		},
		on: () => {},
		getSessionName: () => undefined,
		setSessionName: () => {},
		getAllTools: () => [],
		sendMessage() {},
	};
	inner.on(SUBAGENT_ASYNC_COMPLETE_EVENT, (event) => completionEvents.push(event as Record<string, unknown>));
	setCurrentPi(pi as never);
	const executor = createSubagentExecutor({
		pi,
		state,
		config: {},
		asyncByDefault: false,
		tempArtifactsDir: cwd,
		childRegistry,
		expandTilde: (value: string) => value,
		discoverAgents: () => ({ agents: ["A"].map((name) => makeAgent(name, { model: "mock/test-model" })) }),
	} as never);
	const execute = (params: Record<string, unknown>): Promise<ExecutorResult> =>
		executor.execute("id", params as never, new AbortController().signal, undefined, {
			cwd,
			hasUI: false,
			ui: {},
			sessionManager: { getSessionId: () => "session-123", getSessionFile: () => null },
			modelRegistry: { getAvailable: () => [{ provider: "mock", id: "test-model" }] },
			model: { provider: "mock" },
		} as never) as Promise<ExecutorResult>;
	return { execute, state, childRegistry, completionEvents };
}

describe("async-path shared controller registration", () => {
	let tempDir: string;
	let restoreRuntime: (() => void) | undefined;

	beforeEach(() => {
		tempDir = createTempDir("pi-subagent-async-controller-");
		setRegistryPathForTests(path.join(tempDir, "runs-index.jsonl"));
	});

	afterEach(() => {
		restoreRuntime?.();
		restoreRuntime = undefined;
		setRegistryPathForTests(null);
		removeTempDir(tempDir);
	});

	it("registers the detached controller in the shared layer0 map and releases it on finalize", async () => {
		// Run A hangs until aborted; run B completes normally. interruptRun (the
		// layer0 map lookup, i.e. the post-reload path) must abort A even though the
		// async dispatch never went through spawnRun. After B finalizes, its map
		// entry must be gone: a leaked (non-aborted) controller would still be
		// abortable, so an empty interrupt result proves the release.
		restoreRuntime = installFakeRuntime([
			new FakeAgentSession(async () => {
				await delay(5000);
			}),
			new FakeAgentSession(async (_task, session) => {
				session.emit(assistantMessage("done"));
			}),
		]);
		const harness = makeHarness(tempDir);

		const startedA = await harness.execute({ async: true, run: [{ agent: "A", task: "hang" }] });
		assert.equal(startedA.isError, undefined, startedA.content[0]?.text);
		const runIdA = startedA.details?.runId;
		assert.ok(runIdA);

		await delay(20);
		const interruptResult = interruptRun(runIdA, { cascade: true });
		assert.ok(
			interruptResult.interruptedRunIds.includes(runIdA),
			`layer0 interruptRun must find the async-path controller; got ${JSON.stringify(interruptResult.interruptedRunIds)}`,
		);
		await waitFor(() => harness.completionEvents.length >= 1, "expected async completion after interrupt");

		const startedB = await harness.execute({ async: true, run: [{ agent: "A", task: "finish" }] });
		assert.equal(startedB.isError, undefined, startedB.content[0]?.text);
		const runIdB = startedB.details?.runId;
		assert.ok(runIdB);
		await waitFor(() => harness.completionEvents.length >= 2, "expected async completion for run B");
		await delay(20);

		const afterFinalize = interruptRun(runIdB, { cascade: true });
		assert.deepEqual(
			afterFinalize.interruptedRunIds,
			[],
			"finalize must release the shared-map controller (a leaked one would still abort)",
		);
	});

	it("interruptAsyncRun succeeds when only the target is aborted via the layer0 fallback", async () => {
		// Post-reload shape: the per-activation childRegistry is empty (no handle,
		// no descendants), but the target's controller survives in the shared map.
		// Success must count the target itself, not just registry-resident
		// descendants.
		const harness = makeHarness(tempDir);
		const runId = "run-reload-target";
		harness.state.asyncJobs.set(runId, {
			asyncId: runId,
			asyncDir: tempDir,
			status: "running",
			updatedAt: 1,
		});
		const controller = new AbortController();
		registerRunController(runId, controller);
		try {
			const result = await harness.execute({ action: "interrupt", id: runId });
			assert.equal(result.isError, undefined, result.content[0]?.text);
			assert.match(result.content[0]?.text ?? "", /Interrupt requested for run run-reload-target\./);
			assert.equal(controller.signal.aborted, true, "layer0 fallback must abort the target controller");
			const tracked = harness.state.asyncJobs.get(runId);
			assert.ok(tracked && (tracked.updatedAt ?? 0) > 1, "tracked job entry must be updated for the target");
		} finally {
			releaseRunController(runId);
		}
	});
});
