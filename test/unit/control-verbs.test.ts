import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Compile } from "typebox/compile";
import { SubagentParams } from "../../src/protocol/schemas.ts";
import { createSubagentExecutor, validateSubagentToolInput } from "../../src/dispatch/subagent-executor.ts";
import { ChildAgentRegistry, type ChildAgentHandle } from "../../src/dispatch/in-process-executor.ts";
import { createTempDir, makeAgent, removeTempDir } from "../support/helpers.ts";
import type { SubagentState } from "../../src/protocol/types.ts";

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

function actionLiterals(): string[] {
	const action = SubagentParams.properties.action as { anyOf?: Array<{ const?: string }> };
	return (action.anyOf ?? [])
		.map((item) => item.const)
		.filter((value): value is string => typeof value === "string")
		.sort();
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

function registerHandle(registry: ChildAgentRegistry, runId: string): void {
	const handle: ChildAgentHandle = {
		runId,
		stepIndex: 0,
		session: new FakeSession() as never,
		completed: new Promise(() => {}) as never,
		abort: async () => {},
	};
	registry.register(handle);
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
		config: {},
		asyncByDefault: false,
		tempArtifactsDir: cwd,
		childRegistry,
		expandTilde: (value: string) => value,
		discoverAgents: () => ({ agents: ["main"].map((name) => makeAgent(name, { model: "mock/test-model" })) }),
	} as never);
	const execute = (params: Record<string, unknown>): Promise<ExecutorResult> =>
		executor.execute("id", params as never, new AbortController().signal, undefined, {
			cwd,
			hasUI: false,
			ui: {},
			sessionManager: { getSessionId: () => "session-control-verbs", getSessionFile: () => null },
			modelRegistry: { getAvailable: () => [{ provider: "mock", id: "test-model" }] },
			model: { provider: "mock" },
		} as never) as Promise<ExecutorResult>;
	return { execute, state, childRegistry };
}

describe("control verbs", () => {
	it("control-verbs action enum is exactly the slim control set", () => {
		const validator = Compile(SubagentParams);
		const expected = ["interrupt", "list", "resume", "status"];

		assert.deepEqual(actionLiterals(), expected);
		for (const action of expected) assert.equal(validator.Check({ action }), true, action);
	});

	it("unknown verb rejected with allowed-list hint", () => {
		const error = validateSubagentToolInput({ action: "frobnicate" });

		assert.equal(error?.isError, true);
		assert.match(text(error), /Unknown action: frobnicate/);
		assert.match(text(error), /list, status, interrupt, resume/);
	});

	it("each control verb is recognized by the dispatch handler", async () => {
		const tempDir = createTempDir("pi-subagent-control-verbs-");
		try {
			const harness = makeHarness(tempDir);
			registerHandle(harness.childRegistry, "run-1");
			harness.state.asyncJobs.set("run-1", {
				asyncId: "run-1",
				asyncDir: tempDir,
				status: "running",
				mode: "single",
				updatedAt: Date.now(),
			});

			const results = await Promise.all([
				harness.execute({ action: "list" }),
				harness.execute({ action: "status" }),
				harness.execute({ action: "interrupt", id: "missing" }),
				harness.execute({ action: "resume", id: "run-1", message: "continue" }),
			]);

			for (const result of results) assert.doesNotMatch(text(result), /Unknown action/);
		} finally {
			removeTempDir(tempDir);
		}
	});
});
