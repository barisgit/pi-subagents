import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { createSubagentExecutor } from "../../subagent-executor.ts";
import { ChildAgentRegistry, __setChildAgentExecutorDepsForTest } from "../../in-process-executor.ts";
import { readSummaryForEntry } from "../../async-status.ts";
import { appendRunEntry, readAllEntries, setRegistryPathForTests } from "../../runs-registry.ts";
import { summaryFromRegistryEntry } from "../../subagents-status.ts";
import { readWorkflowScript, writeWorkflowGroupState } from "../../workflow-group-state.ts";
import { createWorkflowTool } from "../../workflow.ts";
import { makeAgent } from "../support/helpers.ts";

const roots: string[] = [];
let restoreRuntime: (() => void) | undefined;
let previousHome: string | undefined;

class FakeResourceLoader { async reload(): Promise<void> {} }
class FakeSession {
	messages: unknown[] = [];
	private listeners: Array<(event: unknown) => void> = [];
	subscribe(listener: (event: unknown) => void): () => void {
		this.listeners.push(listener);
		return () => { this.listeners = this.listeners.filter((entry) => entry !== listener); };
	}
	async prompt(task: string): Promise<void> {
		for (const listener of this.listeners) listener({ type: "message_update", assistantMessageEvent: { type: "thinking_delta" } });
		this.messages.push({ role: "toolResult", toolName: "submit_result", isError: false, details: { status: "ok", summary: task, result: task, artifacts: [] } });
	}
	getLastAssistantText(): string { return "done"; }
	async abort(): Promise<void> {}
	dispose(): void {}
	setActiveToolsByName(): void {}
}

function setup(prefix: string) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	roots.push(root);
	previousHome = process.env.HOME;
	process.env.HOME = root;
	setRegistryPathForTests(path.join(root, ".pi", "agent", "pi-subagents", "runs-index.jsonl"));
	restoreRuntime = __setChildAgentExecutorDepsForTest({
		DefaultResourceLoader: FakeResourceLoader as never,
		getAgentDir: () => "/tmp/pi-agent",
		SessionManager: { open: (file: string) => ({ getSessionId: () => `session-${file}` }) as never },
		createAgentSession: async () => ({ session: new FakeSession() as never, extensionsResult: { extensions: [], diagnostics: [] } }) as never,
	});
	const executor = createSubagentExecutor({
		pi: { events: { emit: () => {} }, getSessionName: () => undefined, setSessionName: () => {}, getAllTools: () => [] },
		state: { baseCwd: root, currentSessionId: null, asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null, cleanupTimers: new Map(), lastUiContext: null, poller: null },
		config: { parallel: { concurrency: 2 } },
		asyncByDefault: false,
		tempArtifactsDir: root,
		childRegistry: new ChildAgentRegistry(),
		expandTilde: (value: string) => value,
		discoverAgents: () => ({ agents: [makeAgent("A", { model: "mock/test-model" }), makeAgent("B", { model: "mock/test-model" })] }),
	} as never);
	const ctx = { cwd: root, hasUI: false, ui: {}, sessionManager: { getSessionId: () => "workflow-parent", getSessionFile: () => null }, modelRegistry: { getAvailable: () => [{ provider: "mock", id: "test-model" }] }, model: { provider: "mock" } };
	return { root, executor, ctx };
}

afterEach(() => {
	restoreRuntime?.();
	restoreRuntime = undefined;
	setRegistryPathForTests(null);
	if (previousHome === undefined) delete process.env.HOME;
	else process.env.HOME = previousHome;
	previousHome = undefined;
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("workflow group Layer-0 wiring (VAL-GROUP-CHILDREN)", () => {
	it("keeps an empty async workflow group running via its statusless lifecycle marker", () => {
		const { root } = setup("workflow-group-marker-");
		const runRecordDir = path.join(root, "group-run");
		const entry = {
			runId: "workflow-group-empty",
			runRecordDir,
			mode: "parallel" as const,
			source: "async" as const,
			kind: "workflow" as const,
			cwd: root,
			startedAt: Date.now(),
		};
		appendRunEntry(entry);
		const entries = readAllEntries();

		writeWorkflowGroupState(runRecordDir, "running");
		assert.equal(readSummaryForEntry(entry, entries)?.state, "running", "mutant: async-status must not synthesize an empty running workflow group as complete");
		assert.equal(summaryFromRegistryEntry(entry, entries).state, "running", "mutant: subagents-status must not synthesize an empty running workflow group as complete");

		writeWorkflowGroupState(runRecordDir, "complete");
		assert.equal(readSummaryForEntry(entry, entries)?.state, "complete");
		assert.equal(summaryFromRegistryEntry(entry, entries).state, "complete");
		assert.equal(fs.existsSync(path.join(runRecordDir, "status.json")), false, "workflow group liveness marker must not write status.json");
	});

	it("does not let a stale running marker mask a failed workflow child", () => {
		const { root } = setup("workflow-group-failmask-");
		const groupDir = path.join(root, "group-run");
		const childDir = path.join(root, "child-run");
		fs.mkdirSync(childDir, { recursive: true });
		const group = {
			runId: "workflow-group-failmask",
			runRecordDir: groupDir,
			mode: "parallel" as const,
			source: "async" as const,
			kind: "workflow" as const,
			cwd: root,
			startedAt: Date.now(),
		};
		const child = {
			runId: "workflow-child-failed",
			runRecordDir: childDir,
			mode: "single" as const,
			source: "async" as const,
			agentName: "A",
			parentRunId: group.runId,
			cwd: root,
			startedAt: Date.now(),
		};
		appendRunEntry(group);
		appendRunEntry(child);
		// Leaf child persisted as failed via its own status.json.
		fs.writeFileSync(path.join(childDir, "status.json"), JSON.stringify({ runId: child.runId, mode: "single", state: "failed", startedAt: Date.now(), cwd: root, currentStep: 0, steps: [] }));
		const entries = readAllEntries();

		// Marker is still "running" (orchestrator alive) but a child has FAILED. The
		// running override must be gated on a computed "complete" and must not mask
		// the failure in either synthesizer.
		writeWorkflowGroupState(groupDir, "running");
		assert.equal(readSummaryForEntry(group, entries)?.state, "failed", "mutant: async-status running override must not mask a failed child");
		assert.equal(summaryFromRegistryEntry(group, entries).state, "failed", "mutant: subagents-status running override must not mask a failed child");
	});

	it("opens one statusless group and nests agent children under it", async () => {
		const { root, executor, ctx } = setup("workflow-group-");
		const tool = createWorkflowTool({ openWorkflowGroup: (workflowContext) => executor.openWorkflowGroup(workflowContext) });

		await tool.execute?.("wf", { script: "await parallel([() => agent('A', 'alpha'), () => agent('B', 'bravo')]);" }, new AbortController().signal, undefined, ctx as never);

		const entries = readAllEntries();
		const groups = entries.filter((entry) => entry.mode === "parallel" && !Object.hasOwn(entry, "agentName") && !Object.hasOwn(entry, "agentNames"));
		assert.equal(groups.length, 1);
		const group = groups[0]!;
		assert.equal(fs.existsSync(path.join(group.runRecordDir, "status.json")), false, "workflow group must stay statusless");
		assert.equal(
			readWorkflowScript(group.runRecordDir),
			"await parallel([() => agent('A', 'alpha'), () => agent('B', 'bravo')]);",
			"the producing script must be persisted on the group record",
		);
		const children = entries.filter((entry) => entry.parentRunId === group.runId);
		assert.equal(children.length, 2);
		assert.deepEqual(children.map((entry) => entry.agentName).sort(), ["A", "B"]);
		assert.equal(children.every((entry) => entry.mode === "single" && entry.source === "sync"), true);
		for (const child of children) {
			assert.equal(fs.existsSync(path.join(child.runRecordDir, "status.json")), true, "workflow children must persist their own status.json");
		}

		const summary = summaryFromRegistryEntry(group, entries);
		assert.equal(summary.mode, "parallel");
		assert.equal(summary.state, "complete");
		assert.equal(readSummaryForEntry(group, entries)?.state, "complete");
		fs.writeFileSync(path.join(group.runRecordDir, "status.json"), JSON.stringify({ runId: group.runId, mode: "parallel", state: "running", startedAt: Date.now(), cwd: root, currentStep: 0, steps: [] }));
		assert.equal(summaryFromRegistryEntry(group, entries).state, "running", "mutant: group status.json reclassifies the row instead of synthesizing from children");
	});

	it("records a raw workflow-level failure (after a successful child) as a failed child so the group synthesizes as failed", async () => {
		const { executor, ctx } = setup("workflow-group-rawfail-");
		const tool = createWorkflowTool({ openWorkflowGroup: (workflowContext) => executor.openWorkflowGroup(workflowContext) });

		// A real child A succeeds, then the script throws a raw (non-agent) error. The
		// only persisted failure evidence in a statusless group is child rows, so the
		// catch path must record a synthetic failed child or the dashboard shows the
		// group as complete despite isError.
		const result = await tool.execute?.("wf", { script: "await agent('A', 'ok');\nthrow new Error('boom');" }, new AbortController().signal, undefined, ctx as never);
		assert.equal(result?.isError, true);

		const entries = readAllEntries();
		const group = entries.find((entry) => entry.mode === "parallel" && !Object.hasOwn(entry, "agentName") && !Object.hasOwn(entry, "agentNames"))!;
		const children = entries.filter((entry) => entry.parentRunId === group.runId);
		assert.equal(children.length, 2, "successful child A plus a synthetic failed workflow child");
		assert.equal(summaryFromRegistryEntry(group, entries).state, "failed", "a raw workflow error must make the group synthesize as failed, not complete");
	});

	it("does not add a redundant synthetic child when a child already failed", async () => {
		const { executor, ctx } = setup("workflow-group-nodup-");
		const tool = createWorkflowTool({ openWorkflowGroup: (workflowContext) => executor.openWorkflowGroup(workflowContext) });

		// Unknown agent Z already produces a failed child; the WorkflowAgentError then
		// propagates to the catch. failWorkflow must NOT add a second failed row.
		const result = await tool.execute?.("wf", { script: "await agent('Z', 'nope');" }, new AbortController().signal, undefined, ctx as never);
		assert.equal(result?.isError, true);

		const entries = readAllEntries();
		const group = entries.find((entry) => entry.mode === "parallel" && !Object.hasOwn(entry, "agentName") && !Object.hasOwn(entry, "agentNames"))!;
		const children = entries.filter((entry) => entry.parentRunId === group.runId);
		assert.equal(children.length, 1, "the already-failed Z child is the only failure row; no redundant synthetic child");
		assert.equal(summaryFromRegistryEntry(group, entries).state, "failed");
	});

	it("records an unknown-agent failure as a failed child so the group does not synthesize as complete", async () => {
		const { executor, ctx } = setup("workflow-group-unknown-");
		const tool = createWorkflowTool({ openWorkflowGroup: (workflowContext) => executor.openWorkflowGroup(workflowContext) });

		// 'Z' is not a discovered agent; the workflow rejects, but the dashboard must
		// still see a failed child under the group (not an empty, complete-looking group).
		const result = await tool.execute?.("wf", { script: "await agent('Z', 'nope');\nreturn 'unreached';" }, new AbortController().signal, undefined, ctx as never);
		assert.equal(result?.isError, true);

		const entries = readAllEntries();
		const group = entries.find((entry) => entry.mode === "parallel" && !Object.hasOwn(entry, "agentName") && !Object.hasOwn(entry, "agentNames"))!;
		const children = entries.filter((entry) => entry.parentRunId === group.runId);
		assert.equal(children.length, 1, "unknown-agent dispatch must still leave a child row under the group");
		assert.equal(summaryFromRegistryEntry(group, entries).state, "failed", "group with a failed child must synthesize as failed, not complete");
	});
});
