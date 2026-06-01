import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { createSubagentExecutor } from "../../subagent-executor.ts";
import { ChildAgentRegistry, __setChildAgentExecutorDepsForTest } from "../../in-process-executor.ts";
import { appendRunEntry, setRegistryPathForTests } from "../../runs-registry.ts";
import { setCurrentPi } from "../../current-pi.ts";
import { createTempDir, makeAgent, removeTempDir } from "../support/helpers.ts";
import { SUBAGENT_ASYNC_STARTED_EVENT, type SubagentState } from "../../types.ts";

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
		this.prompts.push(message.replace(/\n\n---\n\*\*Structured finish:\*\*[\s\S]*$/, ""));
		this.messages.push({ role: "toolResult", toolName: "submit_result", details: { status: "ok", summary: "resumed", result: "resumed output", artifacts: [] } });
		this.promptPromise ??= new Promise<void>((resolve) => { this.resolvePrompt = resolve; });
		return this.promptPromise;
	}
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let i = 0; i < 50; i++) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	assert.equal(predicate(), true, "timed out waiting for condition");
}

function setup(opts: { pending?: boolean; asyncByDefault?: boolean } = {}) {
	tempDir = createTempDir("pi-subagent-sync-resume-foreground-");
	setRegistryPathForTests(path.join(tempDir, "runs-index.jsonl"));
	const state = makeState(tempDir);
	const events: Array<{ channel: string; data: any }> = [];
	const pi = { events: { emit: (channel: string, data: any) => {
		events.push({ channel, data });
		if (channel === SUBAGENT_ASYNC_STARTED_EVENT) {
			state.asyncJobs.set(data.runId, { asyncId: data.runId, asyncDir: data.asyncDir, status: "queued", mode: "single", updatedAt: Date.now() });
		}
	} }, getSessionName: () => undefined, setSessionName: () => {}, getAllTools: () => [] };
	setCurrentPi(pi as never);
	const session = new FakeSession();
	if (!opts.pending) session.promptPromise = Promise.resolve();
	let opened = "";
	restoreDeps = __setChildAgentExecutorDepsForTest({
		SessionManager: { open: (file: string) => { opened = file; return { getSessionId: () => "same-session-id" }; } } as never,
		DefaultResourceLoader: class { async reload() {} } as never,
		getAgentDir: () => tempDir!,
		createAgentSession: (async () => ({ session })) as never,
	});
	const childRegistry = new ChildAgentRegistry();
	const executor = createSubagentExecutor({
		pi, state, config: { parallel: { concurrency: 1 } }, asyncByDefault: opts.asyncByDefault ?? false, tempArtifactsDir: tempDir, childRegistry, expandTilde: (v: string) => v,
		discoverAgents: () => ({ agents: [makeAgent("fixer", { model: "mock/test-model" })] }),
	} as never);
	const execute = (params: Record<string, unknown>) => executor.execute("id", params as never, new AbortController().signal, undefined, {
		cwd: tempDir!, hasUI: false, ui: {}, sessionManager: { getSessionId: () => "parent-session", getSessionFile: () => null }, modelRegistry: { getAvailable: () => [{ provider: "mock", id: "test-model" }] }, model: { provider: "mock" },
	} as never) as Promise<{ isError?: boolean; content: Array<{ text?: string }> }>;
	return { execute, session, events, childRegistry, get opened() { return opened; }, state };
}

function writeCompleteRun(root: string, runId = "resume-run") {
	const runRecordDir = path.join(root, runId);
	const sessionFile = path.join(runRecordDir, "run-0", "session.jsonl");
	fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
	fs.writeFileSync(sessionFile, "{\"sessionId\":\"same-session-id\"}\n", "utf8");
	appendRunEntry({ runId, runRecordDir, mode: "single", source: "sync", agentName: "fixer", rootRunId: runId, cwd: root, startedAt: 1234 });
	fs.writeFileSync(path.join(runRecordDir, "status.json"), JSON.stringify({ runId, mode: "single", state: "complete", startedAt: 1234, endedAt: 1300, cwd: root, steps: [{ agent: "fixer", status: "complete", sessionFile }] }), "utf8");
	return { runRecordDir, sessionFile };
}

function writeCompleteChainRun(root: string, runId = "chain-run") {
	const runRecordDir = path.join(root, runId);
	const step0Session = path.join(runRecordDir, "run-0", "session.jsonl");
	const step1Session = path.join(runRecordDir, "run-1", "session.jsonl");
	fs.mkdirSync(path.dirname(step0Session), { recursive: true });
	fs.mkdirSync(path.dirname(step1Session), { recursive: true });
	fs.writeFileSync(step0Session, "{\"sessionId\":\"same-session-id\"}\n", "utf8");
	fs.writeFileSync(step1Session, "{\"sessionId\":\"same-session-id\"}\n", "utf8");
	appendRunEntry({ runId, runRecordDir, mode: "chain", source: "sync", agentNames: ["fixer", "fixer"], rootRunId: runId, cwd: root, startedAt: 1000 });
	fs.writeFileSync(path.join(runRecordDir, "status.json"), JSON.stringify({
		runId, mode: "chain", state: "complete", startedAt: 1000, endedAt: 6000, cwd: root,
		steps: [
			{ agent: "fixer", status: "complete", startedAt: 1000, endedAt: 5000, durationMs: 4000, sessionFile: step0Session },
			{ agent: "fixer", status: "complete", startedAt: 5000, endedAt: 6000, durationMs: 1000, sessionFile: step1Session },
		],
	}), "utf8");
	return { runRecordDir, step0Session, step1Session };
}

describe("sync resume foreground", () => {
	it("runs async:false resumes as foreground, blocks, opens disk, and cleans up", async () => {
		const h = setup({ pending: true });
		const run = writeCompleteRun(tempDir!);
		const pending = h.execute({ action: "resume", id: "resume-run", message: "continue", async: false });
		await waitFor(() => h.session.prompts.length === 1);

		assert.equal(h.state.foregroundControls.has("resume-run"), true);
		assert.equal(h.state.asyncJobs.size, 0);
		assert.equal(h.opened, run.sessionFile);
		assert.deepEqual(h.session.prompts, ["continue"]);
		assert.equal(h.events.some((event) => event.channel === SUBAGENT_ASYNC_STARTED_EVENT), false);

		h.session.resolvePrompt?.();
		const result = await pending;
		assert.equal(result.isError, undefined, result.content[0]?.text);
		assert.match(result.content[0]?.text ?? "", /Resume completed for run resume-run\./);
		assert.doesNotMatch(result.content[0]?.text ?? "", /Async resume/);
		assert.equal(h.state.foregroundControls.size, 0);
	});

	it("async:true resume still returns an async handle and registers async state", async () => {
		const h = setup({ pending: true });
		writeCompleteRun(tempDir!);
		const result = await h.execute({ action: "resume", id: "resume-run", message: "continue", async: true });
		assert.equal(result.isError, undefined, result.content[0]?.text);
		assert.match(result.content[0]?.text ?? "", /Async resume/);
		assert.equal(h.state.asyncJobs.has("resume-run"), true);
		h.session.resolvePrompt?.();
	});

	it("bare resume (async omitted) follows asyncByDefault=false as foreground", async () => {
		const h = setup({ pending: true, asyncByDefault: false });
		writeCompleteRun(tempDir!);
		const pending = h.execute({ action: "resume", id: "resume-run", message: "continue" });
		await waitFor(() => h.session.prompts.length === 1);
		// No async:false passed, yet it routes foreground because the host default is sync.
		assert.equal(h.state.foregroundControls.has("resume-run"), true);
		assert.equal(h.state.asyncJobs.size, 0);
		assert.equal(h.events.some((event) => event.channel === SUBAGENT_ASYNC_STARTED_EVENT), false);
		h.session.resolvePrompt?.();
		const result = await pending;
		assert.match(result.content[0]?.text ?? "", /Resume completed for run resume-run\./);
	});

	it("bare resume (async omitted) follows asyncByDefault=true as background", async () => {
		const h = setup({ pending: true, asyncByDefault: true });
		writeCompleteRun(tempDir!);
		const result = await h.execute({ action: "resume", id: "resume-run", message: "continue" });
		// No async:true passed, yet it routes background because the host default is async.
		assert.match(result.content[0]?.text ?? "", /Async resume/);
		assert.equal(h.state.asyncJobs.has("resume-run"), true);
		assert.equal(h.state.foregroundControls.size, 0);
		h.session.resolvePrompt?.();
	});

	it("foreground resume increments resumeCount and resumedAt while preserving startedAt", async () => {
		const h = setup();
		const run = writeCompleteRun(tempDir!);
		const before = Date.now();
		await h.execute({ action: "resume", id: "resume-run", message: "continue", async: false });
		const status = JSON.parse(fs.readFileSync(path.join(run.runRecordDir, "status.json"), "utf8"));
		assert.equal(status.startedAt, 1234);
		assert.equal(status.resumeCount, 1);
		assert.equal(typeof status.resumedAt, "number");
		assert.ok(status.resumedAt >= before);
	});

	it("foreground chain-step resume finalizes only the resumed step and preserves sibling step fields", async () => {
		const h = setup();
		const run = writeCompleteChainRun(tempDir!);
		await h.execute({ action: "resume", id: "chain-run:1", message: "continue", async: false });
		const status = JSON.parse(fs.readFileSync(path.join(run.runRecordDir, "status.json"), "utf8"));
		// The resumed step (1) is finalized.
		assert.equal(status.steps[1].status, "complete");
		// Sibling step 0 must keep its original terminal fields, not be clobbered to
		// the resume moment (the bug passed `{}` for siblings, rewriting endedAt=now /
		// durationMs, and flipping status to the run-level end state).
		assert.equal(status.steps[0].status, "complete");
		assert.equal(status.steps[0].endedAt, 5000);
		assert.equal(status.steps[0].durationMs, 4000);
	});

	it("foreground concurrent guard rejects same run and runId:0 alias while pending", async () => {
		const h = setup({ pending: true });
		writeCompleteRun(tempDir!);
		const first = h.execute({ action: "resume", id: "resume-run", message: "one", async: false });
		await waitFor(() => h.session.prompts.length === 1);

		const second = await h.execute({ action: "resume", id: "resume-run", message: "two", async: false });
		const alias = await h.execute({ action: "resume", id: "resume-run:0", message: "three", async: false });
		assert.equal(second.isError, true);
		assert.match(second.content[0]?.text ?? "", /already in progress/);
		assert.equal(alias.isError, true);
		assert.match(alias.content[0]?.text ?? "", /already in progress/);

		h.session.resolvePrompt?.();
		await first;
	});
});
