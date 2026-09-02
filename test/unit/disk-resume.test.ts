import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { createSubagentExecutor } from "../../src/dispatch/subagent-executor.ts";
import { ChildAgentRegistry, __setChildAgentExecutorDepsForTest } from "../../src/dispatch/in-process-executor.ts";
import { appendRunEntry, readAllEntries, setRegistryPathForTests } from "../../src/state/runs-registry.ts";
import { setCurrentPi } from "../../src/shared/current-pi.ts";
import { createTempDir, makeAgent, removeTempDir } from "../support/helpers.ts";
import type { SubagentState } from "../../src/protocol/types.ts";

let tempDir: string | undefined;
let restoreDeps: (() => void) | undefined;

afterEach(() => {
	restoreDeps?.();
	restoreDeps = undefined;
	setRegistryPathForTests(null);
	if (tempDir) removeTempDir(tempDir);
	tempDir = undefined;
});

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

class FakeSession {
	async bindExtensions(): Promise<void> {}
	prompts: string[] = [];
	messages: unknown[] = [];
	resolvePrompt: (() => void) | undefined;
	promptPromise: Promise<void> | undefined;
	subscribe() {
		return () => {};
	}
	setActiveToolsByName() {}
	getLastAssistantText() {
		return "<output>resumed output</output>";
	}
	dispose() {}
	abort() {
		this.resolvePrompt?.();
	}
	prompt(message: string) {
		this.prompts.push(message);
		this.promptPromise ??= new Promise<void>((resolve) => {
			this.resolvePrompt = resolve;
		});
		return this.promptPromise;
	}
}

function setup(opts: { pending?: boolean } = {}) {
	tempDir = createTempDir("pi-subagent-disk-resume-");
	setRegistryPathForTests(path.join(tempDir, "runs-index.jsonl"));
	const events: Array<{ channel: string; data: unknown }> = [];
	const pi = {
		events: { emit: (channel: string, data: unknown) => events.push({ channel, data }) },
		getSessionName: () => undefined,
		setSessionName: () => {},
		getAllTools: () => [],
	};
	setCurrentPi(pi as never);
	const session = new FakeSession();
	if (!opts.pending) session.promptPromise = Promise.resolve();
	let opened = "";
	let createdSessionId = "";
	restoreDeps = __setChildAgentExecutorDepsForTest({
		SessionManager: {
			open: (file: string) => {
				opened = file;
				return { getSessionId: () => readSessionId(file), getSessionFile: () => file };
			},
		} as never,
		DefaultResourceLoader: class {
			async reload() {}
		} as never,
		getAgentDir: () => tempDir!,
		createAgentSession: (async (options: { sessionManager: { getSessionId: () => string } }) => {
			createdSessionId = options.sessionManager.getSessionId();
			return { session } as never;
		}) as never,
	});
	const state = makeState(tempDir);
	const childRegistry = new ChildAgentRegistry();
	const executor = createSubagentExecutor({
		pi,
		state,
		config: {},
		asyncByDefault: false,
		tempArtifactsDir: tempDir,
		childRegistry,
		expandTilde: (v: string) => v,
		discoverAgents: () => ({ agents: [makeAgent("fixer", { model: "mock/test-model" })] }),
	} as never);
	const execute = (params: Record<string, unknown>, callerSessionId: string | null = "parent-session") =>
		executor.execute("id", params as never, new AbortController().signal, undefined, {
			cwd: tempDir!,
			hasUI: false,
			ui: {},
			sessionManager: { getSessionId: () => callerSessionId ?? undefined, getSessionFile: () => null },
			modelRegistry: { getAvailable: () => [{ provider: "mock", id: "test-model" }] },
			model: { provider: "mock" },
		} as never) as Promise<{ isError?: boolean; content: Array<{ text?: string }> }>;
	return {
		execute,
		session,
		events,
		childRegistry,
		get opened() {
			return opened;
		},
		get createdSessionId() {
			return createdSessionId;
		},
		state,
	};
}

function readSessionId(sessionFile: string): string {
	const firstLine = fs.readFileSync(sessionFile, "utf8").split("\n", 1)[0];
	const header: unknown = JSON.parse(firstLine ?? "");
	if (typeof header !== "object" || header === null || !("id" in header) || typeof header.id !== "string") {
		throw new Error("Invalid fake session header.");
	}
	return header.id;
}

function writeCompleteRun(
	root: string,
	runId = "resume-run",
	lineage: { rootSessionId?: string; parentSessionId?: string } = { rootSessionId: "parent-session" },
) {
	const runRecordDir = path.join(root, runId);
	const sessionFile = path.join(runRecordDir, "run-0", "session.jsonl");
	const sessionId = `session-${path.basename(root)}-${runId}`;
	fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
	fs.writeFileSync(
		sessionFile,
		`${JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: root })}\n`,
		"utf8",
	);
	appendRunEntry({
		runId,
		runRecordDir,
		mode: "single",
		source: "sync",
		agentName: "fixer",
		rootRunId: runId,
		...(lineage.rootSessionId ? { rootSessionId: lineage.rootSessionId } : {}),
		...(lineage.parentSessionId ? { parentSessionId: lineage.parentSessionId } : {}),
		cwd: root,
		startedAt: 1234,
	});
	fs.writeFileSync(
		path.join(runRecordDir, "status.json"),
		JSON.stringify({
			runId,
			mode: "single",
			state: "complete",
			startedAt: 1234,
			endedAt: 1300,
			cwd: root,
			steps: [{ agent: "fixer", status: "complete" }],
		}),
		"utf8",
	);
	return { runRecordDir, sessionFile, sessionId };
}

describe("disk resume", () => {
	it("requires matching root-session ownership for every disk resume", async () => {
		const h = setup();
		writeCompleteRun(tempDir!, "root-mismatch", { rootSessionId: "other-session" });
		writeCompleteRun(tempDir!, "parent-mismatch", { parentSessionId: "other-session" });
		writeCompleteRun(tempDir!, "same-session", { rootSessionId: "parent-session" });
		writeCompleteRun(tempDir!, "legacy-run", {});
		writeCompleteRun(tempDir!, "missing-caller", { rootSessionId: "parent-session" });
		writeCompleteRun(tempDir!, "state-fallback", { rootSessionId: "parent-session" });

		const rootMismatch = await h.execute(
			{ action: "resume", id: "root-mismatch", message: "continue", async: false },
			"parent-session",
		);
		assert.equal(rootMismatch.isError, true);
		assert.match(rootMismatch.content[0]?.text ?? "", /root session other-session/);

		const parentMismatch = await h.execute(
			{ action: "resume", id: "parent-mismatch", message: "continue", async: false },
			"parent-session",
		);
		assert.equal(parentMismatch.isError, true);
		assert.match(parentMismatch.content[0]?.text ?? "", /root session other-session/);

		const sameSession = await h.execute(
			{ action: "resume", id: "same-session", message: "continue", async: false },
			"parent-session",
		);
		assert.equal(sameSession.isError, undefined, sameSession.content[0]?.text);

		const legacy = await h.execute(
			{ action: "resume", id: "legacy-run", message: "continue", async: false },
			"parent-session",
		);
		assert.equal(legacy.isError, true);
		assert.match(legacy.content[0]?.text ?? "", /no root-session ownership metadata/);

		const missingCaller = await h.execute(
			{ action: "resume", id: "missing-caller", message: "continue", async: false },
			null,
		);
		assert.equal(missingCaller.isError, true);
		assert.match(missingCaller.content[0]?.text ?? "", /current root session is unavailable/);

		h.state.currentSessionId = "parent-session";
		const stateFallback = await h.execute(
			{ action: "resume", id: "state-fallback", message: "continue", async: false },
			null,
		);
		assert.equal(stateFallback.isError, undefined, stateFallback.content[0]?.text);
	});

	it("reopen from disk appends a follow-up to the existing session file", async () => {
		const h = setup();
		const run = writeCompleteRun(tempDir!);
		const result = await h.execute({ action: "resume", id: "resume-run", message: "continue", async: false });
		assert.equal(result.isError, undefined, result.content[0]?.text);
		assert.equal(h.opened, run.sessionFile);
		assert.equal(h.session.prompts.length, 1);
		// Resume carries the clean continuation message; the finish contract is no longer appended to the
		// prompt (it lives on the appended <output> contract + the original system prompt).
		assert.equal(h.session.prompts[0], "continue");
	});

	it("same thread identity keeps one runId and one registry row", async () => {
		const h = setup();
		const run = writeCompleteRun(tempDir!);
		await h.execute({ action: "resume", id: "resume-run", message: "continue", async: false });
		assert.deepEqual(
			readAllEntries().map((entry) => entry.runId),
			["resume-run"],
		);
		assert.equal(h.createdSessionId, run.sessionId);
	});

	it("live handle path does not require disk status", async () => {
		const h = setup();
		const liveSession = {
			messages: [] as string[],
			deliveryOptions: [] as Array<{ deliverAs?: "steer" | "followUp" } | undefined>,
			async prompt(
				message: string,
				options?: {
					streamingBehavior?: "steer" | "followUp";
					preflightResult?: (success: boolean) => void;
				},
			) {
				this.messages.push(message);
				this.deliveryOptions.push({ deliverAs: options?.streamingBehavior });
				options?.preflightResult?.(true);
			},
			async sendUserMessage(message: string, options?: { deliverAs?: "steer" | "followUp" }) {
				this.messages.push(message);
				this.deliveryOptions.push(options);
			},
		};
		h.state.asyncJobs.set("live-run", {
			asyncId: "live-run",
			asyncDir: "/missing",
			status: "complete",
			mode: "single",
			updatedAt: Date.now(),
		});
		h.childRegistry.register({
			runId: "live-run",
			stepIndex: 0,
			session: liveSession,
			completed: new Promise(() => {}),
			abort: async () => {},
		} as never);

		const result = await h.execute({ action: "resume", id: "live-run", message: "live follow-up" });

		assert.equal(result.isError, undefined, result.content[0]?.text);
		assert.deepEqual(liveSession.messages, ["live follow-up"]);
		assert.deepEqual(liveSession.deliveryOptions, [{ deliverAs: "steer" }]);
	});

	it("concurrent resume rejects a second opener for the same run", async () => {
		const h = setup({ pending: true });
		writeCompleteRun(tempDir!);
		const first = await h.execute({ action: "resume", id: "resume-run", message: "one", async: true });
		const second = await h.execute({ action: "resume", id: "resume-run", message: "two", async: true });
		assert.equal(first.isError, undefined, first.content[0]?.text);
		assert.equal(second.isError, true);
		assert.match(second.content[0]?.text ?? "", /already in progress/);
		h.session.resolvePrompt?.();
	});

	it("concurrent resume guard collides across runId aliases (runId vs runId:0)", async () => {
		const h = setup({ pending: true });
		writeCompleteRun(tempDir!);
		const first = await h.execute({ action: "resume", id: "resume-run", message: "one", async: true });
		const second = await h.execute({ action: "resume", id: "resume-run:0", message: "two", async: true });
		assert.equal(first.isError, undefined, first.content[0]?.text);
		assert.equal(second.isError, true);
		assert.match(second.content[0]?.text ?? "", /already in progress/);
		h.session.resolvePrompt?.();
	});

	it("async handle returns immediately for disk continuation", async () => {
		const h = setup({ pending: true });
		writeCompleteRun(tempDir!);
		const result = await h.execute({ action: "resume", id: "resume-run", message: "continue", async: true });
		assert.equal(result.isError, undefined, result.content[0]?.text);
		assert.match(result.content[0]?.text ?? "", /Async resume/);
		h.session.resolvePrompt?.();
	});
});
