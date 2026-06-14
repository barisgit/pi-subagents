import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { ChildAgentRegistry, __setChildAgentExecutorDepsForTest } from "../../src/dispatch/in-process-executor.ts";
import { appendRunEntry, setRegistryPathForTests } from "../../src/state/runs-registry.ts";
import { createSubagentExecutor } from "../../src/dispatch/subagent-executor.ts";
import { buildLeftLine } from "../../src/surfaces/subagents-status.ts";
import { __setStatusWriterWriteJsonForTest } from "../../src/state/status-writer.ts";
import { setCurrentPi } from "../../src/shared/current-pi.ts";
import { summaryFromRegistryEntry } from "../../src/surfaces/subagents-status.ts";
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

function state(cwd: string): SubagentState {
	return { baseCwd: cwd, currentSessionId: null, asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null, cleanupTimers: new Map(), lastUiContext: null, poller: null };
}

class BlockingSession {
	resolvePrompt: (() => void) | undefined;
	messages: unknown[] = [];
	subscribe() { return () => {}; }
	setActiveToolsByName() {}
	getLastAssistantText() { return "done after block"; }
	dispose() {}
	async abort() { this.resolvePrompt?.(); }
	async prompt() {
		this.messages.push({ role: "toolResult", toolName: "submit_result", details: { status: "ok", summary: "done", result: "done after block", artifacts: [] } });
		await new Promise<void>((resolve) => { this.resolvePrompt = resolve; });
	}
}

function setup(session: BlockingSession) {
	tempDir = createTempDir("pi-subagent-resume-display-edge-");
	setRegistryPathForTests(path.join(tempDir, "runs-index.jsonl"));
	const events: Array<{ channel: string; data: any }> = [];
	const pi = { events: { emit: (channel: string, data: unknown) => events.push({ channel, data }) }, getSessionName: () => undefined, setSessionName: () => {}, getAllTools: () => [] };
	setCurrentPi(pi as never);
	restoreDeps = __setChildAgentExecutorDepsForTest({ SessionManager: { open: () => ({ getSessionId: () => "same-session" }) } as never, DefaultResourceLoader: class { async reload() {} } as never, getAgentDir: () => tempDir!, createAgentSession: async () => ({ session }) as never });
	const s = state(tempDir);
	const executor = createSubagentExecutor({ pi, state: s, config: { parallel: { concurrency: 1 } }, asyncByDefault: false, tempArtifactsDir: tempDir, childRegistry: new ChildAgentRegistry(), expandTilde: (v: string) => v, discoverAgents: () => ({ agents: [makeAgent("fixer", { model: "mock/test-model" })] }) } as never);
	const execute = (params: Record<string, unknown>) => executor.execute("id", params as never, new AbortController().signal, undefined, { cwd: tempDir!, hasUI: false, ui: {}, sessionManager: { getSessionId: () => "parent", getSessionFile: () => null }, modelRegistry: { getAvailable: () => [{ provider: "mock", id: "test-model" }] }, model: { provider: "mock" } } as never) as Promise<{ isError?: boolean; content: Array<{ text?: string }> }>;
	return { execute, events, state: s };
}

function seedRun(root: string, runId = "edge-run", startedAt = 1_000, extra: Record<string, unknown> = {}) {
	const runRecordDir = path.join(root, runId);
	fs.mkdirSync(path.join(runRecordDir, "run-0"), { recursive: true });
	fs.writeFileSync(path.join(runRecordDir, "run-0", "session.jsonl"), "{}\n", "utf8");
	const entry = { runId, runRecordDir, mode: "single" as const, source: "sync" as const, agentName: "fixer", rootRunId: runId, cwd: root, startedAt };
	appendRunEntry(entry);
	fs.writeFileSync(path.join(runRecordDir, "status.json"), JSON.stringify({ runId, mode: "single", state: "complete", startedAt, endedAt: startedAt + 1, cwd: root, steps: [{ agent: "fixer", status: "complete" }], ...extra }), "utf8");
	return { ...entry, startedAt };
}

const theme = { fg: (_name: string, text: string) => text, bold: (text: string) => text };

describe("resume display edge cases", () => {
	it("rejects a double resume in flight without a second resumeCount increment", async () => {
		const session = new BlockingSession();
		const h = setup(session);
		const run = seedRun(tempDir!);
		const writes: Array<Record<string, any>> = [];
		const restore = __setStatusWriterWriteJsonForTest((filePath, payload) => {
			if (filePath.includes(run.runId)) writes.push(JSON.parse(JSON.stringify(payload)));
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, JSON.stringify(payload), "utf8");
		});
		try {
			const first = h.execute({ action: "resume", id: run.runId, message: "first", async: false });
			await new Promise((resolve) => setImmediate(resolve));
			const second = await h.execute({ action: "resume", id: run.runId, message: "second", async: false });
			assert.equal(second.isError, true);
			assert.match(second.content[0]?.text ?? "", /Resume already in progress/);
			session.resolvePrompt?.();
			await first;
		} finally {
			restore();
		}
		const runningWrites = writes.filter((write) => write.state === "running" && write.resumeCount !== undefined);
		assert.equal(runningWrites.length, 1);
		assert.equal(runningWrites[0]!.resumeCount, 1);
		const status = JSON.parse(fs.readFileSync(path.join(run.runRecordDir, "status.json"), "utf8"));
		assert.equal(status.resumeCount, 1);
	});

	it("reconstructs resumed display from runs registry and status json after reload", () => {
		tempDir = createTempDir("pi-subagent-resume-display-reload-");
		setRegistryPathForTests(path.join(tempDir, "runs-index.jsonl"));
		const now = 1_000_000;
		const entry = seedRun(tempDir!, "reload-run", now - 143 * 60_000, { resumedAt: now - 12_000, resumeCount: 1, endedAt: now, lastUpdate: now });
		const summary = summaryFromRegistryEntry(entry);
		assert.equal(summary.resumedAt, now - 12_000);
		assert.equal(summary.resumeCount, 1);
		const line = buildLeftLine(theme as never, { ownership: "foreign", run: summary }, false, now, 240);
		assert.match(line, /12\.0s/);
		assert.match(line, /age 143m0s/);
		assert.match(line, /resumed 1×/);
	});
});
