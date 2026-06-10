import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { createSubagentExecutor } from "../../src/dispatch/subagent-executor.ts";
import { ChildAgentRegistry, __setChildAgentExecutorDepsForTest } from "../../src/dispatch/in-process-executor.ts";
import { setRegistryPathForTests } from "../../src/state/runs-registry.ts";
import { runWorkflowScript, WorkflowAgentError } from "../../src/workflow/workflow.ts";
import { makeAgent } from "../support/helpers.ts";

describe("workflow agent global (VAL-AGENT-GLOBAL)", () => {
	it("resolves to the submit_result envelope returned by an injected dispatch", async () => {
		const envelope = { status: "ok" as const, summary: "done", result: { answer: 7 }, artifacts: ["artifact.txt"] };
		const value = await runWorkflowScript({
			dispatch: async (role, task) => {
				assert.equal(role, "explorer");
				assert.equal(task, "inventory");
				return envelope;
			},
			script: "return await agent('explorer', 'inventory');",
		});

		assert.deepEqual(value, envelope);
	});

	it("surfaces dispatch failure and does not return a masking fallback status:ok envelope", async () => {
		const maskingEnvelope = { status: "ok" as const, summary: "fallback text", result: "fallback text", artifacts: [] };
		await assert.rejects(
			runWorkflowScript({
				dispatch: async () => ({ envelope: maskingEnvelope, exitCode: 1, error: "child failed" }),
				script: "return await agent('explorer', 'task');",
			}),
			(error: unknown) => {
				assert.ok(error instanceof WorkflowAgentError);
				assert.equal(error.envelope, maskingEnvelope);
				assert.match(error.message, /child failed/);
				return true;
			},
		);
	});

	it("surfaces interrupted dispatches even when the child fallback envelope says ok", async () => {
		await assert.rejects(
			runWorkflowScript({
				dispatch: async () => ({ envelope: { status: "ok", summary: "fallback", result: "fallback" }, interrupted: true }),
				script: "return await agent('explorer', 'task');",
			}),
			/was interrupted/,
		);
	});
});

describe("workflow agent Layer-0 child prep (VAL-CHILD-PREP)", () => {
	it("dispatches through openWorkflowGroup with resolved model/tools and rejects failed children", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-agent-prep-"));
		const previousHome = process.env.HOME;
		process.env.HOME = root;
		setRegistryPathForTests(path.join(root, ".pi", "agent", "pi-subagents", "runs-index.jsonl"));
		const created: Array<{ model?: { provider: string; id: string }; tools?: string[]; customTools?: Array<{ name: string }> }> = [];
		class FakeResourceLoader { async reload(): Promise<void> {} }
		class FakeSession {
			messages: unknown[] = [];
			subscribe(): () => void { return () => {}; }
			async prompt(task: string): Promise<void> {
				if (task === "fail") throw new Error("child boom");
				this.messages.push({ role: "toolResult", toolName: "submit_result", isError: false, details: { status: "ok", summary: task, result: task, artifacts: [] } });
			}
			getLastAssistantText(): string { return "done"; }
			async abort(): Promise<void> {}
			dispose(): void {}
			setActiveToolsByName(): void {}
		}
		const restore = __setChildAgentExecutorDepsForTest({
			DefaultResourceLoader: FakeResourceLoader as never,
			getAgentDir: () => "/tmp/pi-agent",
			SessionManager: { open: () => ({ getSessionId: () => "child-session" }) as never },
			createAgentSession: (async (options: { model?: { provider: string; id: string }; tools?: string[]; customTools?: Array<{ name: string }> }) => {
				created.push(options);
				return { session: new FakeSession() as never, extensionsResult: { extensions: [], diagnostics: [] } } as never;
			}) as never,
		});
		try {
			const executor = createSubagentExecutor({
				pi: { events: { emit: () => {} }, getSessionName: () => undefined, setSessionName: () => {}, getAllTools: () => [] },
				state: { baseCwd: root, currentSessionId: null, asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null, cleanupTimers: new Map(), lastUiContext: null, poller: null },
				config: { parallel: { concurrency: 1 }, control: { enabled: true, needsAttentionAfterMs: 1234 } },
				asyncByDefault: false,
				tempArtifactsDir: root,
				childRegistry: new ChildAgentRegistry(),
				expandTilde: (value: string) => value,
				discoverAgents: () => ({ agents: [makeAgent("fixer", { model: "mock/test-model", tools: ["read"], skills: ["tdd"] })] }),
			} as never);
			const ctx = { cwd: root, hasUI: false, ui: {}, sessionManager: { getSessionId: () => "parent", getSessionFile: () => null }, modelRegistry: { getAvailable: () => [{ provider: "mock", id: "test-model" }] }, model: { provider: "mock" } };
			const group = executor.openWorkflowGroup({ toolCallId: "wf", signal: new AbortController().signal, ctx: ctx as never });
			const ok = await group.dispatchChild({ role: "fixer", task: "ok", index: 0 });
			assert.deepEqual(ok.structuredResult, { status: "ok", summary: "ok", result: "ok", artifacts: [] });
			assert.equal(created[0]?.model?.id, "test-model");
			assert.deepEqual(created[0]?.tools, ["read", "submit_result"]);
			assert.equal(created[0]?.customTools?.some((tool) => tool.name === "submit_result"), true);

			const failed = await group.dispatchChild({ role: "fixer", task: "fail", index: 1 });
			assert.notEqual(failed.exitCode, 0);
			await assert.rejects(
				runWorkflowScript({ dispatch: async () => ({ envelope: failed.structuredResult, exitCode: failed.exitCode, error: failed.error }), script: "return await agent('fixer', 'fail');" }),
				(error: unknown) => error instanceof WorkflowAgentError && /child boom/.test(error.message),
			);
		} finally {
			restore();
			setRegistryPathForTests(null);
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
