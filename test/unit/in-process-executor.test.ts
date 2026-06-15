import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, describe, it } from "node:test";
import {
	ChildAgentRegistry,
	__setChildAgentExecutorDepsForTest,
	dispatchAsyncChild,
	runChildAgent,
	type ChildAgentContext,
	type ChildAgentHandle,
	type ChildAgentStep,
} from "../../src/dispatch/in-process-executor.ts";

const cleanup: string[] = [];
const restoreFns: Array<() => void> = [];

afterEach(() => {
	while (restoreFns.length > 0) restoreFns.pop()?.();
});

after(() => {
	for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });
});

type Listener = (event: Record<string, unknown>) => void;

class FakeResourceLoader {
	reloadCount = 0;
	readonly opts: Record<string, unknown>;

	constructor(opts: Record<string, unknown>) {
		this.opts = opts;
	}

	async reload(): Promise<void> {
		this.reloadCount++;
	}
}

class FakeAgentSession {
	listeners: Listener[] = [];
	activeToolNames: string[] = [];
	abortCalls = 0;
	disposeCalls = 0;
	promptCalls = 0;
	messages: unknown[] = [];
	lastAssistantText = "";
	readonly promptImpl: (session: FakeAgentSession) => Promise<void>;

	constructor(promptImpl: (session: FakeAgentSession) => Promise<void>) {
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

	async prompt(_text: string, _options: Record<string, unknown>): Promise<void> {
		this.promptCalls++;
		await this.promptImpl(this);
	}

	async abort(): Promise<void> {
		this.abortCalls++;
	}

	dispose(): void {
		this.disposeCalls++;
	}

	setActiveToolsByName(names: string[]): void {
		this.activeToolNames = names;
	}

	getLastAssistantText(): string {
		return this.lastAssistantText;
	}
}

function tempDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	cleanup.push(dir);
	return dir;
}

function makeStep(overrides: Partial<ChildAgentStep> = {}): ChildAgentStep {
	const root = tempDir("pi-in-process-step-");
	return {
		runId: overrides.runId ?? "run-1",
		stepIndex: overrides.stepIndex ?? 0,
		agentName: "fixer",
		agentConfig: {
			name: "fixer",
			description: "Fix things",
			systemPromptMode: "replace",
			inheritProjectContext: false,
			inheritSkills: false,
			systemPrompt: "You fix things.",
			source: "builtin",
			filePath: "fixer.md",
		},
		task: "Do it",
		cwd: root,
		model: { provider: "test", id: "model-a" } as never,
		modelCandidates: [],
		activeToolNames: ["read", "bash"],
		customTools: [],
		systemPrompt: "You fix things.",
		skillsResolved: [],
		sessionFile: path.join(root, "run-1", "run-0", "session.jsonl"),
		runRecordDir: path.join(root, "run-1", "run-0"),
		maxSubagentDepth: 2,
		shareEnabled: false,
		...overrides,
	};
}

function makeContext(overrides: Partial<ChildAgentContext> = {}): ChildAgentContext {
	return {
		extensionCtx: { modelRegistry: { name: "registry" } } as never,
		abortSignal: new AbortController().signal,
		registry: new ChildAgentRegistry(),
		pi: {} as never,
		...overrides,
	};
}

function installFakeRuntime(sessions: FakeAgentSession[], createHook?: () => void): void {
	const restore = __setChildAgentExecutorDepsForTest({
		DefaultResourceLoader: FakeResourceLoader as never,
		getAgentDir: () => "/tmp/pi-agent",
		SessionManager: {
			open: (file: string) => ({ file }) as never,
		},
		createAgentSession: async () => {
			createHook?.();
			const session = sessions.shift();
			if (!session) throw new Error("No fake session queued");
			return { session: session as never, extensionsResult: { extensions: [], diagnostics: [] } } as never;
		},
	});
	restoreFns.push(restore);
}

describe("runChildAgent", () => {
	it("awaits prompt and returns complete output assembled from text_delta events", async () => {
		const session = new FakeAgentSession(async (self) => {
			self.emit({ type: "text_delta", delta: "hello " });
			self.emit({ type: "text_delta", delta: "world" });
			self.emit({ type: "agent_end" });
		});
		installFakeRuntime([session]);
		const events: unknown[] = [];

		const result = await runChildAgent(
			makeStep(),
			makeContext({
				onEvent: (_stepIndex, event) => events.push(event),
			}),
		);

		assert.equal(result.state, "complete");
		assert.equal(result.exitCode, 0);
		assert.equal(result.outputText, "hello world");
		assert.equal(session.promptCalls, 1);
		assert.equal(session.disposeCalls, 1);
		assert.deepEqual(session.activeToolNames, ["read", "bash"]);
		assert.equal(events.length, 3);
	});

	it("increments tool counters on tool_execution_start and tool_execution_end", async () => {
		const session = new FakeAgentSession(async (self) => {
			self.emit({ type: "tool_execution_start", toolName: "read" });
			self.emit({ type: "tool_execution_end", toolName: "read" });
			self.emit({ type: "tool_execution_start", toolName: "bash" });
			self.emit({ type: "tool_execution_end", toolName: "bash", isError: true });
		});
		installFakeRuntime([session]);
		const patches: unknown[] = [];

		const result = await runChildAgent(
			makeStep(),
			makeContext({
				onStatusUpdate: (patch) => patches.push(patch),
			}),
		);

		assert.equal(result.toolCallCount, 2);
		assert.equal(result.toolResultCount, 2);
		assert.equal(result.toolErrorCount, 1);
		assert.equal(patches.filter((patch) => (patch as { toolCallDelta?: number }).toolCallDelta === 1).length, 2);
		assert.equal(
			patches.filter((patch) => (patch as { toolResultDelta?: number }).toolResultDelta === 1).length,
			2,
		);
		assert.equal(patches.filter((patch) => (patch as { toolErrorDelta?: number }).toolErrorDelta === 1).length, 1);
	});

	it("aborts the session and returns interrupted when abortSignal fires", async () => {
		const session = new FakeAgentSession(async () => await new Promise<void>(() => {}));
		installFakeRuntime([session]);
		const controller = new AbortController();
		const promise = runChildAgent(makeStep(), makeContext({ abortSignal: controller.signal }));

		await new Promise((resolve) => setImmediate(resolve));
		controller.abort("stop-now");
		const result = await promise;

		assert.equal(session.abortCalls, 1);
		assert.equal(session.disposeCalls, 1);
		assert.equal(result.state, "interrupted");
		assert.equal(result.error?.reason, "stop-now");
	});
});

describe("dispatchAsyncChild", () => {
	it("survives an unrelated parent-turn abort when only the registry/local signals can cancel it", async () => {
		// Models the runAsyncPath wiring after decoupling: asyncCtx.abortSignal is a
		// detached controller never tied to the parent turn's signal. The parent turn
		// can ESC freely; the async child keeps running until the registry per-run
		// controller (or its local controller) fires.
		let release!: () => void;
		const promptReleased = new Promise<void>((resolve) => {
			release = resolve;
		});
		const session = new FakeAgentSession(async (self) => {
			await promptReleased;
			self.emit({ type: "text_delta", delta: "ok" });
		});
		installFakeRuntime([session]);

		const parentTurnAbort = new AbortController();
		const asyncDetachedAbort = new AbortController();
		const registry = new ChildAgentRegistry();

		const handle = dispatchAsyncChild(
			makeStep({ runId: "async-survives-esc" }),
			makeContext({ abortSignal: asyncDetachedAbort.signal, registry }),
		);

		await new Promise((resolve) => setImmediate(resolve));
		// Simulate parent turn ESC: aborting an UNRELATED controller must not reach the child.
		parentTurnAbort.abort("parent ESC");
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(session.abortCalls, 0, "unrelated parent-turn abort must not reach async child");

		// Per-run registry controller is the supported kill switch via action:"interrupt".
		await registry.abortRun("async-survives-esc", "interrupt requested");
		release();
		const result = await handle.completed;
		assert.ok(session.abortCalls >= 1, "registry abort must reach the child session");
		assert.equal(result.state, "interrupted");
	});

	it("returns a handle without awaiting and fires onCompleted", async () => {
		let release!: () => void;
		const promptReleased = new Promise<void>((resolve) => {
			release = resolve;
		});
		const session = new FakeAgentSession(async (self) => {
			await promptReleased;
			self.emit({ type: "text_delta", delta: "done" });
		});
		let createCalls = 0;
		installFakeRuntime([session], () => createCalls++);
		const completed = new Promise((resolve) => {
			const handle = dispatchAsyncChild(
				makeStep({ runId: "async-run" }),
				makeContext({
					onCompleted: resolve,
				}),
			);
			assert.equal(handle.runId, "async-run");
			assert.equal(createCalls, 0);
			assert.equal(session.promptCalls, 0);
		});

		release();
		const result = (await completed) as { state: string; outputText: string };
		assert.equal(result.state, "complete");
		assert.equal(result.outputText, "done");
	});
});

describe("ChildAgentRegistry", () => {
	function fakeHandle(runId: string, stepIndex: number, aborts: string[]): ChildAgentHandle {
		return {
			runId,
			stepIndex,
			get session() {
				return {} as never;
			},
			completed: Promise.resolve({} as never),
			async abort(reason: string): Promise<void> {
				aborts.push(`${runId}:${reason}`);
			},
		};
	}

	it("registers, gets, lists, deletes, aborts one run, and aborts all runs", async () => {
		const registry = new ChildAgentRegistry();
		const aborts: string[] = [];
		const signalA = registry.signalForRun("a");
		const handleA = fakeHandle("a", 0, aborts);
		const handleB = fakeHandle("b", 1, aborts);

		registry.register(handleA);
		registry.register(handleB);
		assert.equal(registry.get("a"), handleA);
		assert.deepEqual(registry.snapshot(), [
			{ runId: "a", stepIndex: 0 },
			{ runId: "b", stepIndex: 1 },
		]);
		assert.deepEqual(
			registry.list().map((handle) => handle.runId),
			["a", "b"],
		);

		await registry.abortRun("a", "reload");
		assert.equal(signalA.aborted, true);
		assert.deepEqual(aborts, ["a:reload"]);

		registry.delete("a");
		assert.equal(registry.get("a"), undefined);
		assert.deepEqual(
			registry.list().map((handle) => handle.runId),
			["b"],
		);

		await registry.abortAll("shutdown");
		assert.deepEqual(aborts, ["a:reload", "b:shutdown"]);
	});

	it("tracks multiple concurrent steps for one run id", async () => {
		const registry = new ChildAgentRegistry();
		const aborts: string[] = [];
		const handleA = fakeHandle("shared", 0, aborts);
		const handleB = fakeHandle("shared", 1, aborts);

		registry.register(handleA);
		registry.register(handleB);
		assert.deepEqual(registry.snapshot(), [
			{ runId: "shared", stepIndex: 0 },
			{ runId: "shared", stepIndex: 1 },
		]);

		registry.delete("shared", 0);
		assert.deepEqual(registry.snapshot(), [{ runId: "shared", stepIndex: 1 }]);

		await registry.abortRun("shared", "stop");
		assert.deepEqual(aborts, ["shared:stop"]);
	});
});
