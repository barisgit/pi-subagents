import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { createSubagentExecutor } from "../../src/dispatch/subagent-executor.ts";
import { ChildAgentRegistry, __setChildAgentExecutorDepsForTest } from "../../src/dispatch/in-process-executor.ts";
import { __setSyncRunStatusUpdateObserverForTest, ensureSyncRunDir, writeSyncRunStatusEnd, writeSyncRunStatusStart, writeSyncRunStatusUpdate } from "../../src/state/sync-run-persistence.ts";
import { SUBAGENT_CONTROL_EVENT, SUBAGENT_NEEDS_ATTENTION_EVENT } from "../../src/protocol/types.ts";

const restoreFns: Array<() => void> = [];
let testsRun = 0;

afterEach(() => {
	testsRun++;
	while (restoreFns.length > 0) restoreFns.pop()?.();
});

after(() => {
	process.stdout.write(`# tests ${testsRun}\n`);
});

type Listener = (event: Record<string, unknown>) => void;

class FakeResourceLoader {
	async reload(): Promise<void> {}
}

class FakeAgentSession {
	private listeners: Listener[] = [];
	readonly promptImpl: (session: FakeAgentSession) => Promise<void>;
	abortCount = 0;

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

	async prompt(): Promise<void> {
		await this.promptImpl(this);
	}

	async abort(): Promise<void> {
		this.abortCount++;
	}

	dispose(): void {}

	setActiveToolsByName(): void {}
}

function installFakeRuntime(sessions: FakeAgentSession[]): void {
	restoreFns.push(__setChildAgentExecutorDepsForTest({
		DefaultResourceLoader: FakeResourceLoader as never,
		getAgentDir: () => "/tmp/pi-agent",
		SessionManager: { open: (file: string) => ({ file }) as never },
		createAgentSession: async () => {
			const session = sessions.shift();
			if (!session) throw new Error("No fake session queued");
			return { session: session as never, extensionsResult: { extensions: [], diagnostics: [] } } as never;
		},
	}));
}

function makeExecutor(cwd: string, emit: (event: string, payload: unknown) => void = () => {}) {
	return createSubagentExecutor({
		pi: {
			events: { emit },
			getAllTools: () => [],
			getSessionName: () => undefined,
			setSessionName: () => {},
		} as never,
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
		config: {},
		asyncByDefault: false,
		tempArtifactsDir: cwd,
		childRegistry: new ChildAgentRegistry(),
		expandTilde: (value: string) => value,
		discoverAgents: () => ({
			agents: [{
				name: "phase-tester",
				description: "Phase tester",
				systemPrompt: "",
				systemPromptMode: "replace",
				inheritProjectContext: false,
				inheritSkills: false,
				model: "test/model-a",
			}],
		}),
	} as never);
}

function makeCtx(cwd: string) {
	return {
		cwd,
		hasUI: false,
		ui: {},
		sessionManager: {
			getSessionId: () => "session-phase-test",
			getSessionFile: () => null,
		},
		modelRegistry: { getAvailable: () => [{ provider: "test", id: "model-a" }] },
	};
}

function uniqueRunId(prefix: string): string {
	return `${prefix}-${process.pid}-${Math.random().toString(16).slice(2)}`;
}

function readStatus(runId: string) {
	return JSON.parse(fs.readFileSync(path.join(ensureSyncRunDir(runId), "status.json"), "utf-8"));
}

describe("sync run persistence", () => {
	it("writes start, update, and terminal status", () => {
		const runId = `sync-persist-${process.pid}-${Date.now()}`;
		const dir = ensureSyncRunDir(runId);
		try {
			writeSyncRunStatusStart(runId, {
				mode: "single",
				startedAt: 100,
				cwd: "/repo",
				label: "demo",
				parentRunId: "parent-a",
				steps: [{ agent: "fixer", label: "step" }],
			});
			let status = readStatus(runId);
			assert.equal(status.state, "running");
			assert.equal(status.parentRunId, "parent-a");
			assert.equal(status.steps[0].status, "pending");

			writeSyncRunStatusUpdate(runId, { currentTool: "bash", steps: [{ status: "running", currentTool: "bash" }] }, { flush: true });
			status = readStatus(runId);
			assert.equal(status.currentTool, "bash");
			assert.equal(status.steps[0].status, "running");

			writeSyncRunStatusEnd(runId, { state: "complete", steps: [{ tokens: { input: 1, output: 2, total: 3 } }] });
			status = readStatus(runId);
			assert.equal(status.state, "complete");
			assert.equal(status.steps[0].status, "complete");
			assert.equal(status.steps[0].tokens.total, 3);
			assert.ok(fs.existsSync(path.join(dir, "status.json")));
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("clears the live phase chip on terminal end", () => {
		// A nested sync child that ended mid-`finishing` (submit_result streaming) must not
		// keep advertising the phase after it completes, or the dashboard row reads
		// `finishing 19.9s` on a done run. writeSyncRunStatusEnd now mirrors StatusWriter.finalize
		// and resets phase to 'idle'.
		const runId = `sync-persist-phaseclear-${process.pid}-${Date.now()}`;
		const dir = ensureSyncRunDir(runId);
		try {
			writeSyncRunStatusStart(runId, { mode: "single", steps: [{ agent: "worker" }] });
			writeSyncRunStatusUpdate(runId, { phase: "finishing", phaseStartedAt: 1000 }, { flush: true });
			assert.equal(readStatus(runId).phase, "finishing");
			writeSyncRunStatusEnd(runId, { state: "complete" });
			assert.equal(readStatus(runId).phase, "idle");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("persists live step tokens during the run (pre-finalize)", () => {
		// The nested-child line / dashboard read step.tokens from the on-disk status.json.
		// forwardSingleUpdate now threads the live token aggregate into writeSyncRunStatusUpdate
		// so a still-running sync child shows real tokens, not ~0.
		const runId = `sync-persist-livetok-${process.pid}-${Date.now()}`;
		const dir = ensureSyncRunDir(runId);
		try {
			writeSyncRunStatusStart(runId, { mode: "single", steps: [{ agent: "explorer" }] });
			writeSyncRunStatusUpdate(runId, {
				steps: [{ status: "running", tokens: { input: 500, output: 243, total: 743 } }],
			}, { flush: true });
			const status = readStatus(runId);
			assert.equal(status.state, "running");
			assert.equal(status.steps[0].tokens.total, 743);
			// totalTokens stays absent on a live step patch; the reader sums steps.
			assert.equal(status.totalTokens, undefined);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("defaults end state to complete", () => {
		const runId = `sync-persist-default-${process.pid}-${Date.now()}`;
		const dir = ensureSyncRunDir(runId);
		try {
			writeSyncRunStatusStart(runId, { mode: "single", steps: [{ agent: "worker" }] });
			writeSyncRunStatusEnd(runId, {});
			assert.equal(readStatus(runId).state, "complete");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("also mirrors status.json to runRecordDir when provided", () => {
		const runId = `sync-persist-mirror-${process.pid}-${Date.now()}`;
		const dir = ensureSyncRunDir(runId);
		const runRecordDir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-run-record-"));
		try {
			writeSyncRunStatusStart(runId, { mode: "single", steps: [{ agent: "worker" }] }, runRecordDir);
			writeSyncRunStatusUpdate(runId, { currentTool: "read" }, { flush: true }, runRecordDir);
			writeSyncRunStatusEnd(runId, { state: "complete" }, runRecordDir);
			const mirrored = JSON.parse(fs.readFileSync(path.join(runRecordDir, "status.json"), "utf-8"));
			assert.equal(mirrored.state, "complete");
			assert.equal(mirrored.currentTool, undefined);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
			fs.rmSync(runRecordDir, { recursive: true, force: true });
		}
	});
});

describe("phase", () => {
	it("sync-write-includes-phase", (t) => {
		t.mock.timers.enable({ apis: ["Date"] });
		const runId = uniqueRunId("sync-phase-write");
		const dir = ensureSyncRunDir(runId);
		try {
			writeSyncRunStatusStart(runId, { mode: "single", startedAt: Date.now(), steps: [{ agent: "worker" }] });
			t.mock.timers.tick(10);
			const before = Date.now();
			writeSyncRunStatusUpdate(runId, { phase: "thinking", phaseStartedAt: 5000 }, { flush: true });

			const status = readStatus(runId);
			assert.equal(status.phase, "thinking");
			assert.equal(status.phaseStartedAt, 5000);
			assert.ok(status.runnerHeartbeatAt >= before);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("runner-heartbeat-honors-patch", () => {
		const runId = uniqueRunId("sync-phase-heartbeat");
		const dir = ensureSyncRunDir(runId);
		try {
			writeSyncRunStatusStart(runId, { mode: "single", steps: [{ agent: "worker" }] });
			writeSyncRunStatusUpdate(runId, { runnerHeartbeatAt: 12345 }, { flush: true });

			assert.equal(readStatus(runId).runnerHeartbeatAt, 12345);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("min-update-interval-floor", (t) => {
		t.mock.timers.enable({ apis: ["Date"] });
		const runId = uniqueRunId("sync-phase-floor");
		const dir = ensureSyncRunDir(runId);
		try {
			writeSyncRunStatusStart(runId, { mode: "single", startedAt: Date.now(), steps: [{ agent: "worker" }] });
			t.mock.timers.tick(1000);
			writeSyncRunStatusUpdate(runId, { phase: "thinking", phaseStartedAt: 1000 });
			const first = readStatus(runId);

			t.mock.timers.tick(100);
			writeSyncRunStatusUpdate(runId, { phase: "streaming_text", phaseStartedAt: 1100, currentTool: "read" });

			assert.deepEqual(readStatus(runId), first);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("sync-needs-attention-auto-interrupts-without-control-notice", async (t) => {
		t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 0 });
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-attention-interrupt-"));
		const emitted: string[] = [];
		let markPromptStarted!: () => void;
		const promptStarted = new Promise<void>((resolve) => {
			markPromptStarted = resolve;
		});
		const session = new FakeAgentSession(async () => {
			markPromptStarted();
			return new Promise<void>(() => {});
		});
		installFakeRuntime([session]);
		try {
			const run = makeExecutor(tempDir, (event) => emitted.push(event)).executeInternal(
				"id",
				{ agent: "phase-tester", task: "stall", sessionDir: tempDir, control: { needsAttentionAfterMs: 10 }, includeProgress: true },
				new AbortController().signal,
				undefined,
				makeCtx(tempDir) as never,
			);

			await promptStarted;
			t.mock.timers.tick(5_000);

			const result = await run;
			const child = result.details.results[0];
			assert.equal(result.isError, undefined);
			assert.equal(child?.interrupted, true);
			assert.match(child?.error ?? "", /needs_attention auto-interrupt/);
			assert.equal(session.abortCount, 1);
			assert.equal(emitted.includes(SUBAGENT_CONTROL_EVENT), false);
			assert.equal(emitted.includes(SUBAGENT_NEEDS_ATTENTION_EVENT), false);
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("caller-forwards-phase", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-phase-caller-"));
		const calls: Array<{ runId: string; patch: Record<string, unknown> }> = [];
		restoreFns.push(__setSyncRunStatusUpdateObserverForTest((runId, patch) => {
			calls.push({ runId, patch: patch as Record<string, unknown> });
		}));
		const session = new FakeAgentSession(async (self) => {
			self.emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta" } });
			self.emit({ type: "text_delta", delta: "done" });
		});
		installFakeRuntime([session]);
		try {
			const result = await makeExecutor(tempDir).executeInternal(
				"id",
				{ agent: "phase-tester", task: "think", sessionDir: tempDir },
				new AbortController().signal,
				undefined,
				makeCtx(tempDir) as never,
			);

			assert.equal(result.isError, undefined);
			assert.ok(calls.some((call) => call.patch.phase === "thinking" && typeof call.patch.phaseStartedAt === "number"));
			for (const call of calls) fs.rmSync(ensureSyncRunDir(call.runId), { recursive: true, force: true });
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("preservation-across-partial", () => {
		const runId = uniqueRunId("sync-phase-preserve");
		const dir = ensureSyncRunDir(runId);
		try {
			writeSyncRunStatusStart(runId, { mode: "single", steps: [{ agent: "worker" }] });
			writeSyncRunStatusUpdate(runId, { phase: "thinking", phaseStartedAt: 9000 }, { flush: true });
			writeSyncRunStatusUpdate(runId, { currentTool: "read" }, { flush: true });

			const status = readStatus(runId);
			assert.equal(status.phase, "thinking");
			assert.equal(status.phaseStartedAt, 9000);
			assert.equal(status.currentTool, "read");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
