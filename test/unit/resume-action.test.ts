import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createSubagentExecutor, validateSubagentToolInput } from "../../subagent-executor.ts";
import { ChildAgentRegistry, type ChildAgentHandle } from "../../in-process-executor.ts";
import { createTempDir, makeAgent, removeTempDir } from "../support/helpers.ts";
import type { SubagentState } from "../../types.ts";

interface ExecutorResult {
	isError?: boolean;
	content: Array<{ type?: string; text?: string }>;
}

class FakeSession {
	readonly messages: string[] = [];

	postUserMessage(message: string): void {
		this.messages.push(message);
	}
}

function text(result: ExecutorResult | null): string {
	return result?.content[0]?.text ?? "";
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

function registerHandle(registry: ChildAgentRegistry, runId: string, stepIndex: number, session = new FakeSession()): FakeSession {
	const handle: ChildAgentHandle = {
		runId,
		stepIndex,
		session: session as never,
		completed: new Promise(() => {}) as never,
		abort: async () => {},
	};
	registry.register(handle);
	return session;
}

function makeHarness(cwd: string) {
	const state = makeState(cwd);
	const childRegistry = new ChildAgentRegistry();
	const executor = createSubagentExecutor({
		pi: {
			events: { emit: () => {} },
			getSessionName: () => undefined,
			setSessionName: () => {},
			getAllTools: () => [],
		},
		state,
		config: { parallel: { concurrency: 1 } },
		asyncByDefault: false,
		tempArtifactsDir: cwd,
		childRegistry,
		expandTilde: (value: string) => value,
		discoverAgents: () => ({ agents: ["main", "explorer"].map((name) => makeAgent(name, { model: "mock/test-model" })) }),
	} as never);
	const execute = (params: Record<string, unknown>): Promise<ExecutorResult> => executor.execute(
		"id",
		params as never,
		new AbortController().signal,
		undefined,
		{
			cwd,
			hasUI: false,
			ui: {},
			sessionManager: { getSessionId: () => "session-resume-action", getSessionFile: () => null },
			modelRegistry: { getAvailable: () => [{ provider: "mock", id: "test-model" }] },
			model: { provider: "mock" },
		} as never,
	) as Promise<ExecutorResult>;
	return { execute, state, childRegistry };
}

function markAsync(state: SubagentState, runId: string, status: "queued" | "running" | "complete" | "failed" | "paused" | "lost", mode: "single" | "parallel" | "chain" = "single"): void {
	state.asyncJobs.set(runId, {
		asyncId: runId,
		asyncDir: "/tmp/pi-subagent-resume-action",
		status,
		mode,
		updatedAt: Date.now(),
	});
}

describe("resume action", () => {
	it("resume-action posts message to a live run", async () => {
		const tempDir = createTempDir("pi-subagent-resume-action-");
		try {
			const harness = makeHarness(tempDir);
			const session = registerHandle(harness.childRegistry, "run-1", 0);
			markAsync(harness.state, "run-1", "running");

			const result = await harness.execute({ action: "resume", id: "run-1", message: "continue" });

			assert.equal(result.isError, undefined, text(result));
			assert.deepEqual(session.messages, ["continue"]);
		} finally {
			removeTempDir(tempDir);
		}
	});

	it("missing-id-rejected", () => {
		const error = validateSubagentToolInput({ action: "resume", message: "hi" });

		assert.equal(error?.isError, true);
		assert.match(text(error), /resume requires `id` \(runId\)/);
	});

	it("missing-message-rejected", () => {
		const error = validateSubagentToolInput({ action: "resume", id: "some-uuid" });

		assert.equal(error?.isError, true);
		assert.match(text(error), /resume requires `message` to send to the child/);
	});

	it("terminated-tracker-live-handle-still-posts", async () => {
		const tempDir = createTempDir("pi-subagent-resume-action-");
		try {
			const harness = makeHarness(tempDir);
			const session = registerHandle(harness.childRegistry, "run-done", 0);
			markAsync(harness.state, "run-done", "complete");

			const result = await harness.execute({ action: "resume", id: "run-done", message: "again" });

			assert.equal(result.isError, undefined, text(result));
			assert.deepEqual(session.messages, ["again"]);
		} finally {
			removeTempDir(tempDir);
		}
	});

	it("agent-switch-attempt-rejected", () => {
		const taskError = validateSubagentToolInput({ action: "resume", id: "x", message: "hi", run: [{ agent: "explorer", task: "y" }] });
		const agentError = validateSubagentToolInput({ action: "resume", id: "x", message: "hi", agent: "explorer" });

		assert.equal(taskError?.isError, true);
		assert.match(text(taskError), /resume is per-run; do not supply `run`/);
		assert.equal(agentError?.isError, true);
		assert.match(text(agentError), /do not supply `agent`/);
	});

	it("batch-id-rejected", async () => {
		const tempDir = createTempDir("pi-subagent-resume-action-");
		try {
			const harness = makeHarness(tempDir);
			registerHandle(harness.childRegistry, "batch-1", 0);
			registerHandle(harness.childRegistry, "batch-1", 1);
			markAsync(harness.state, "batch-1", "running", "parallel");

			const result = await harness.execute({ action: "resume", id: "batch-1", message: "continue" });

			assert.equal(result.isError, true);
			assert.match(text(result), /`id` must be a runId, not batchId/);
		} finally {
			removeTempDir(tempDir);
		}
	});
});
