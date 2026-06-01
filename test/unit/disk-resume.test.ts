import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { createSubagentExecutor } from "../../subagent-executor.ts";
import { ChildAgentRegistry, __setChildAgentExecutorDepsForTest } from "../../in-process-executor.ts";
import { appendRunEntry, readAllEntries, setRegistryPathForTests } from "../../runs-registry.ts";
import { setCurrentPi } from "../../current-pi.ts";
import { createTempDir, makeAgent, removeTempDir } from "../support/helpers.ts";
import type { SubagentState } from "../../types.ts";

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
	return { baseCwd: cwd, currentSessionId: null, asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null, cleanupTimers: new Map(), lastUiContext: null, poller: null };
}

class FakeSession {
	prompts: string[] = [];
	messages: unknown[] = [];
	resolvePrompt: (() => void) | undefined;
	promptPromise: Promise<void> | undefined;
	subscribe() { return () => {}; }
	setActiveToolsByName() {}
	getLastAssistantText() { return "resumed output"; }
	dispose() {}
	abort() { this.resolvePrompt?.(); }
	prompt(message: string) {
		this.prompts.push(message);
		this.messages.push({ role: "toolResult", toolName: "submit_result", details: { status: "ok", summary: "resumed", result: "resumed output", artifacts: [] } });
		this.promptPromise ??= new Promise<void>((resolve) => { this.resolvePrompt = resolve; });
		return this.promptPromise;
	}
}

function setup(opts: { pending?: boolean } = {}) {
	tempDir = createTempDir("pi-subagent-disk-resume-");
	setRegistryPathForTests(path.join(tempDir, "runs-index.jsonl"));
	const events: Array<{ channel: string; data: unknown }> = [];
	const pi = { events: { emit: (channel: string, data: unknown) => events.push({ channel, data }) }, getSessionName: () => undefined, setSessionName: () => {}, getAllTools: () => [] };
	setCurrentPi(pi as never);
	const session = new FakeSession();
	if (!opts.pending) session.promptPromise = Promise.resolve();
	let opened = "";
	let createdSessionId = "";
	restoreDeps = __setChildAgentExecutorDepsForTest({
		SessionManager: { open: (file: string) => { opened = file; return { getSessionId: () => "same-session-id" }; } } as never,
		DefaultResourceLoader: class { async reload() {} } as never,
		getAgentDir: () => tempDir!,
		createAgentSession: (async (options: { sessionManager: { getSessionId: () => string } }) => { createdSessionId = options.sessionManager.getSessionId(); return { session } as never; }) as never,
	});
	const state = makeState(tempDir);
	const childRegistry = new ChildAgentRegistry();
	const executor = createSubagentExecutor({
		pi, state, config: { parallel: { concurrency: 1 } }, asyncByDefault: false, tempArtifactsDir: tempDir, childRegistry, expandTilde: (v: string) => v,
		discoverAgents: () => ({ agents: [makeAgent("fixer", { model: "mock/test-model" })] }),
	} as never);
	const execute = (params: Record<string, unknown>) => executor.execute("id", params as never, new AbortController().signal, undefined, {
		cwd: tempDir!, hasUI: false, ui: {}, sessionManager: { getSessionId: () => "parent-session", getSessionFile: () => null }, modelRegistry: { getAvailable: () => [{ provider: "mock", id: "test-model" }] }, model: { provider: "mock" },
	} as never) as Promise<{ isError?: boolean; content: Array<{ text?: string }> }>;
	return { execute, session, events, childRegistry, get opened() { return opened; }, get createdSessionId() { return createdSessionId; }, state };
}

function writeCompleteRun(root: string, runId = "resume-run") {
	const runRecordDir = path.join(root, runId);
	const sessionFile = path.join(runRecordDir, "run-0", "session.jsonl");
	fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
	fs.writeFileSync(sessionFile, "{\"sessionId\":\"same-session-id\"}\n", "utf8");
	appendRunEntry({ runId, runRecordDir, mode: "single", source: "sync", agentName: "fixer", rootRunId: runId, cwd: root, startedAt: 1234 });
	fs.writeFileSync(path.join(runRecordDir, "status.json"), JSON.stringify({ runId, mode: "single", state: "complete", startedAt: 1234, endedAt: 1300, cwd: root, steps: [{ agent: "fixer", status: "complete" }] }), "utf8");
	return { runRecordDir, sessionFile };
}

describe("disk resume", () => {
	it("reopen from disk appends a follow-up to the existing session file", async () => {
		const h = setup();
		const run = writeCompleteRun(tempDir!);
		const result = await h.execute({ action: "resume", id: "resume-run", message: "continue", async: false });
		assert.equal(result.isError, undefined, result.content[0]?.text);
		assert.equal(h.opened, run.sessionFile);
		assert.equal(h.session.prompts.length, 1);
		// Resume carries the clean continuation message; the finish contract is no longer appended to the
		// prompt (it lives on the always-present submit_result tool description + the original system prompt).
		assert.equal(h.session.prompts[0], "continue");
	});

	it("same thread identity keeps one runId and one registry row", async () => {
		const h = setup();
		writeCompleteRun(tempDir!);
		await h.execute({ action: "resume", id: "resume-run", message: "continue", async: false });
		assert.deepEqual(readAllEntries().map((entry) => entry.runId), ["resume-run"]);
		assert.equal(h.createdSessionId, "same-session-id");
	});

	it("live handle path does not require disk status", async () => {
		const h = setup();
		const liveSession = { messages: [] as string[], postUserMessage(message: string) { this.messages.push(message); } };
		h.state.asyncJobs.set("live-run", { asyncId: "live-run", asyncDir: "/missing", status: "complete", mode: "single", updatedAt: Date.now() });
		h.childRegistry.register({ runId: "live-run", stepIndex: 0, session: liveSession, completed: new Promise(() => {}), abort: async () => {} } as never);

		const result = await h.execute({ action: "resume", id: "live-run", message: "live follow-up" });

		assert.equal(result.isError, undefined, result.content[0]?.text);
		assert.deepEqual(liveSession.messages, ["live follow-up"]);
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
