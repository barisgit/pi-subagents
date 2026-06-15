import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { formatAsyncRunList, type AsyncRunSummary } from "../../src/state/async-status.ts";
import { inspectSubagentStatus } from "../../src/state/run-status.ts";
import { createSubagentExecutor } from "../../src/dispatch/subagent-executor.ts";
import { ChildAgentRegistry } from "../../src/dispatch/in-process-executor.ts";
import { makeAgent } from "../support/helpers.ts";
import type { Details, SubagentState } from "../../src/protocol/types.ts";

function state(cwd: string): SubagentState {
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

describe("mode-agnostic relabel", () => {
	it("uses a neutral default status-list heading", () => {
		const run: AsyncRunSummary = {
			id: "run-1",
			asyncDir: "/tmp/run-1",
			state: "running",
			mode: "single",
			startedAt: 1,
			steps: [{ index: 0, agent: "fixer", status: "running" }],
		};
		const text = formatAsyncRunList([run]);
		assert.match(text, /Subagent runs: 1/);
		assert.doesNotMatch(text, /Async runs/);
	});

	it("uses a neutral not-found status message", () => {
		const result = inspectSubagentStatus({ id: "definitely-missing-run" }) as AgentToolResult<Details> & {
			isError?: boolean;
		};
		assert.equal(result.isError, true);
		const text = "text" in result.content[0]! ? result.content[0]!.text : "";
		assert.match(text, /Run not found/);
		assert.doesNotMatch(text, /Async run not found/);
	});

	it("uses neutral interrupt handler messages", async () => {
		const cwd = process.cwd();
		const s = state(cwd);
		const pi = {
			events: { emit: () => {} },
			getSessionName: () => undefined,
			setSessionName: () => {},
			getAllTools: () => [],
		};
		const executor = createSubagentExecutor({
			pi,
			state: s,
			config: { parallel: { concurrency: 1 } },
			asyncByDefault: false,
			tempArtifactsDir: cwd,
			childRegistry: new ChildAgentRegistry(),
			expandTilde: (v: string) => v,
			discoverAgents: () => ({ agents: [makeAgent("fixer", { model: "mock/test-model" })] }),
		} as never);
		const result = (await executor.execute(
			"id",
			{ action: "interrupt", id: "all" } as never,
			new AbortController().signal,
			undefined,
			{
				cwd,
				hasUI: false,
				ui: {},
				sessionManager: { getSessionId: () => "parent-session", getSessionFile: () => null },
				modelRegistry: { getAvailable: () => [{ provider: "mock", id: "test-model" }] },
				model: { provider: "mock" },
			} as never,
		)) as { content: Array<{ text?: string }> };
		const text = result.content[0]?.text ?? "";
		assert.match(text, /No running runs to interrupt\./);
		assert.doesNotMatch(text, /async run/i);
	});
});
