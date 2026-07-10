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
import { claimPendingChildLineage, getLineageForSession, setHostLineage } from "../../src/state/lineage.ts";
import { isInsideChildSession } from "../../src/shared/child-session-context.ts";

const cleanup: string[] = [];
const restoreFns: Array<() => void> = [];

function clearLineage(...sessionIds: string[]): void {
	const globals = globalThis as Record<string, unknown>;
	const lineageStore = globals["__piSubagentLineageBySession"] as Map<string, unknown> | undefined;
	const boundSessionFiles = globals["__piSubagentLineageBoundSessionFiles"] as Map<string, unknown> | undefined;
	for (const sessionId of sessionIds) {
		lineageStore?.delete(sessionId);
		boundSessionFiles?.delete(sessionId);
	}
}

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

function installFakeRuntime(
	sessions: FakeAgentSession[],
	createHook?: () => void,
	childSessionId?: string | ((sessionFile: string) => string | undefined),
	createErrors: Error[] = [],
	ResourceLoader: typeof FakeResourceLoader = FakeResourceLoader,
): void {
	const restore = __setChildAgentExecutorDepsForTest({
		DefaultResourceLoader: ResourceLoader as never,
		getAgentDir: () => "/tmp/pi-agent",
		SessionManager: {
			open: (file: string) =>
				({
					file,
					getSessionId: () => (typeof childSessionId === "function" ? childSessionId(file) : childSessionId),
				}) as never,
		},
		createAgentSession: async () => {
			createHook?.();
			const createError = createErrors.shift();
			if (createError) throw createError;
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
			self.lastAssistantText = "<output>hello world</output>";
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

	it("keeps overlapping session construction in independent child contexts", async () => {
		let releaseFirst!: () => void;
		let markFirstStarted!: () => void;
		const firstReleased = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const firstStarted = new Promise<void>((resolve) => {
			markFirstStarted = resolve;
		});
		let reloadCount = 0;
		class InterleavedResourceLoader extends FakeResourceLoader {
			override async reload(): Promise<void> {
				assert.equal(isInsideChildSession(), true);
				reloadCount++;
				if (reloadCount === 1) {
					markFirstStarted();
					await firstReleased;
				}
				await super.reload();
			}
		}
		const makeSession = () =>
			new FakeAgentSession(async (self) => {
				self.lastAssistantText = "<output>done</output>";
			});
		const firstStep = makeStep({ runId: "run-child-context-first" });
		const secondStep = makeStep({ runId: "run-child-context-second" });
		installFakeRuntime(
			[makeSession(), makeSession()],
			() => assert.equal(isInsideChildSession(), true),
			(sessionFile) => sessionFile,
			[],
			InterleavedResourceLoader,
		);
		let firstRun: ReturnType<typeof runChildAgent> | undefined;

		try {
			firstRun = runChildAgent(firstStep, makeContext());
			await firstStarted;
			assert.equal(isInsideChildSession(), false);
			const secondResult = await runChildAgent(secondStep, makeContext());
			assert.equal(secondResult.state, "complete");
			assert.equal(isInsideChildSession(), false);
			releaseFirst();
			const firstResult = await firstRun;
			assert.equal(firstResult.state, "complete");
			assert.equal(isInsideChildSession(), false);
		} finally {
			releaseFirst();
			await firstRun?.catch(() => {});
			clearLineage(firstStep.sessionFile, secondStep.sessionFile);
		}
	});

	it("increments tool counters on tool_execution_start and tool_execution_end", async () => {
		const session = new FakeAgentSession(async (self) => {
			self.emit({ type: "tool_execution_start", toolName: "read" });
			self.emit({ type: "tool_execution_end", toolName: "read" });
			self.emit({ type: "tool_execution_start", toolName: "bash" });
			self.emit({ type: "tool_execution_end", toolName: "bash", isError: true });
			self.lastAssistantText = "<output>done</output>";
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

	it("normalizes parent lineage identity before falling back to the step parent identity", async () => {
		const parentSessionId = "session-parent-blank-identity";
		const childSessionId = "session-child-parent-fallback";
		const session = new FakeAgentSession(async (self) => {
			self.lastAssistantText = "<output>done</output>";
		});
		setHostLineage(parentSessionId, "   ");
		installFakeRuntime([session], undefined, childSessionId);

		try {
			await runChildAgent(makeStep({ parentSessionId, parentAgentName: "  fallback-agent  " }), makeContext());

			assert.equal(getLineageForSession(childSessionId)?.parentAgent, "fallback-agent");
		} finally {
			claimPendingChildLineage(childSessionId, { runId: null, agentName: null });
			clearLineage(parentSessionId, childSessionId);
		}
	});

	it("preserves parent lineage when a fork child uses a distinct session id", async () => {
		const parentSessionId = "session-fork-parent";
		const childSessionId = "session-fork-child";
		const forkSource = path.join(tempDir("pi-in-process-fork-source-"), "branched.jsonl");
		fs.writeFileSync(forkSource, '{"type":"session","id":"session-fork-child"}\n');
		const step = makeStep({
			parentSessionId,
			forkReuse: { sessionFile: forkSource, agentName: "fixer" },
		});
		const parentLineage = setHostLineage(parentSessionId, "parent-agent");
		const session = new FakeAgentSession(async (self) => {
			self.lastAssistantText = "<output>done</output>";
		});
		installFakeRuntime([session], undefined, childSessionId);

		try {
			const result = await runChildAgent(step, makeContext());

			assert.equal(result.state, "complete");
			assert.notEqual(childSessionId, parentSessionId);
			assert.equal(getLineageForSession(parentSessionId), parentLineage);
			assert.equal(getLineageForSession(childSessionId)?.parentSessionId, parentSessionId);
		} finally {
			claimPendingChildLineage(childSessionId, { runId: null, agentName: null });
			clearLineage(parentSessionId, childSessionId);
		}
	});

	it("fails a colliding fork child without replacing parent lineage", async () => {
		const parentSessionId = "session-fork-collision-parent";
		const forkSource = path.join(tempDir("pi-in-process-fork-collision-"), "branched.jsonl");
		fs.writeFileSync(forkSource, '{"type":"session","id":"session-fork-collision-parent"}\n');
		const step = makeStep({
			parentSessionId,
			forkReuse: { sessionFile: forkSource, agentName: "fixer" },
		});
		const parentLineage = setHostLineage(parentSessionId, "parent-agent");
		let createCalls = 0;
		installFakeRuntime([], () => createCalls++, parentSessionId);

		try {
			const result = await runChildAgent(step, makeContext());

			assert.equal(result.state, "failed");
			assert.equal(result.error?.message, "Cannot replace an existing session lineage binding.");
			assert.equal(createCalls, 0);
			assert.equal(getLineageForSession(parentSessionId), parentLineage);
		} finally {
			clearLineage(parentSessionId);
		}
	});

	it("cleans failed lineage after model fallback is exhausted when session id is unavailable", async () => {
		const firstFailedSessionId = "session-failed-setup-first";
		const terminalFailedSessionId = "session-failed-setup-terminal";
		const cleanupSessionId = "session-failed-setup-cleanup";
		const attemptSessionIds = [firstFailedSessionId, terminalFailedSessionId];
		const step = makeStep({
			runId: "run-failed-setup",
			modelCandidates: [{ provider: "test", id: "model-b" } as never],
		});
		let createCalls = 0;
		let firstClaim: ReturnType<typeof claimPendingChildLineage> = null;
		let terminalClaim: ReturnType<typeof claimPendingChildLineage> = null;
		installFakeRuntime(
			[],
			() => {
				if (createCalls === 1) assert.equal(getLineageForSession(firstFailedSessionId), null);
				const claimed = claimPendingChildLineage(attemptSessionIds[createCalls]!, {
					runId: null,
					agentName: null,
					sessionFile: step.sessionFile,
				});
				assert.equal(claimed?.runId, step.runId);
				if (createCalls === 0) firstClaim = claimed;
				else terminalClaim = claimed;
				createCalls++;
			},
			undefined,
			[new Error("authentication failed for model-a"), new Error("authentication failed for model-b")],
		);

		try {
			const result = await runChildAgent(step, makeContext());

			assert.equal(result.state, "failed");
			assert.equal(createCalls, 2);
			assert.equal(firstClaim, terminalClaim);
			assert.equal(getLineageForSession(firstFailedSessionId), null);
			assert.equal(getLineageForSession(terminalFailedSessionId), null);
			assert.equal(
				claimPendingChildLineage(cleanupSessionId, {
					runId: null,
					agentName: null,
					sessionFile: step.sessionFile,
				}),
				null,
			);
		} finally {
			claimPendingChildLineage(cleanupSessionId, {
				runId: step.runId,
				agentName: null,
				sessionFile: step.sessionFile,
			});
			clearLineage(firstFailedSessionId, terminalFailedSessionId, cleanupSessionId);
		}
	});

	it("cleans an auth-failed attempt binding before fallback succeeds when session id is unavailable", async () => {
		const failedSessionId = "session-auth-fallback-failed-attempt";
		const successfulSessionId = "session-auth-fallback-successful-attempt";
		const cleanupSessionId = "session-auth-fallback-attempt-cleanup";
		const attemptSessionIds = [failedSessionId, successfulSessionId];
		const step = makeStep({
			runId: "run-auth-fallback-attempt-cleanup",
			modelCandidates: [{ provider: "test", id: "model-b" } as never],
		});
		const session = new FakeAgentSession(async (self) => {
			self.lastAssistantText = "<output>done</output>";
		});
		let createCalls = 0;
		let firstClaim: ReturnType<typeof claimPendingChildLineage> = null;
		let successfulClaim: ReturnType<typeof claimPendingChildLineage> = null;
		installFakeRuntime(
			[session],
			() => {
				if (createCalls === 1) assert.equal(getLineageForSession(failedSessionId), null);
				const claimed = claimPendingChildLineage(attemptSessionIds[createCalls]!, {
					runId: null,
					agentName: null,
					sessionFile: step.sessionFile,
				});
				assert.equal(claimed?.runId, step.runId);
				if (createCalls === 0) firstClaim = claimed;
				else successfulClaim = claimed;
				createCalls++;
			},
			undefined,
			[new Error("authentication failed for model-a")],
		);

		try {
			const result = await runChildAgent(step, makeContext());

			assert.equal(result.state, "complete");
			assert.equal(createCalls, 2);
			assert.equal(firstClaim, successfulClaim);
			assert.equal(getLineageForSession(failedSessionId), null);
			assert.equal(getLineageForSession(successfulSessionId), successfulClaim);
			assert.equal(getLineageForSession(successfulSessionId)?.runId, step.runId);
			assert.equal(
				claimPendingChildLineage(successfulSessionId, {
					runId: null,
					agentName: null,
					sessionFile: step.sessionFile,
				}),
				successfulClaim,
			);
			assert.equal(
				claimPendingChildLineage(cleanupSessionId, {
					runId: null,
					agentName: null,
					sessionFile: step.sessionFile,
				}),
				null,
			);
		} finally {
			clearLineage(failedSessionId, successfulSessionId, cleanupSessionId);
		}
	});

	it("preserves pending lineage through auth fallback until successful activation can claim it", async () => {
		const activationSessionId = "session-auth-fallback-success";
		const cleanupSessionId = "session-auth-fallback-success-cleanup";
		const step = makeStep({
			runId: "run-auth-fallback-success",
			modelCandidates: [{ provider: "test", id: "model-b" } as never],
		});
		const session = new FakeAgentSession(async (self) => {
			self.lastAssistantText = "<output>done</output>";
		});
		let createCalls = 0;
		installFakeRuntime([session], () => createCalls++, undefined, [new Error("authentication failed for model-a")]);

		try {
			const result = await runChildAgent(step, makeContext());
			const claimed = claimPendingChildLineage(activationSessionId, {
				runId: null,
				agentName: null,
				sessionFile: step.sessionFile,
			});

			assert.equal(result.state, "complete");
			assert.equal(createCalls, 2);
			assert.equal(claimed?.runId, step.runId);
			assert.equal(
				claimPendingChildLineage(cleanupSessionId, {
					runId: null,
					agentName: null,
					sessionFile: step.sessionFile,
				}),
				null,
			);
		} finally {
			clearLineage(activationSessionId, cleanupSessionId);
		}
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

	it("returns a handle without awaiting", async () => {
		let release!: () => void;
		const promptReleased = new Promise<void>((resolve) => {
			release = resolve;
		});
		const session = new FakeAgentSession(async (self) => {
			await promptReleased;
			self.emit({ type: "text_delta", delta: "done" });
			self.lastAssistantText = "<output>done</output>";
		});
		let createCalls = 0;
		installFakeRuntime([session], () => createCalls++);
		const handle = dispatchAsyncChild(makeStep({ runId: "async-run" }), makeContext());
		assert.equal(handle.runId, "async-run");
		assert.equal(createCalls, 0);
		assert.equal(session.promptCalls, 0);

		release();
		const result = await handle.completed;
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
