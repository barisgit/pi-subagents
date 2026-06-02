import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { describe, it } from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");

describe("workflow persistence structure", () => {
	it("stamps workflow group, phase, and parallel batch registry tags", () => {
		const script = `
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = ${JSON.stringify(repoRoot)};
const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-structure-"));
process.env.HOME = root;

const cacheBust = Date.now().toString();
const urlFor = (relative) => {
	const url = pathToFileURL(path.join(repoRoot, relative));
	url.search = "?workflow-structure=" + cacheBust;
	return url.href;
};

const moduleUrl = (relative) => pathToFileURL(path.join(repoRoot, relative)).href;
const { createSubagentExecutor } = await import(moduleUrl("subagent-executor.ts"));
const { ChildAgentRegistry, __setChildAgentExecutorDepsForTest } = await import(moduleUrl("in-process-executor.ts"));
const { readAllEntries, setRegistryPathForTests } = await import(moduleUrl("runs-registry.ts"));
const { createWorkflowTool } = await import(urlFor("workflow.ts"));
const { makeAgent } = await import(moduleUrl("test/support/helpers.ts"));

class FakeResourceLoader { async reload() {} }
class FakeSession {
	messages = [];
	subscribe() { return () => {}; }
	async prompt(task) {
		this.messages.push({ role: "toolResult", toolName: "submit_result", isError: false, details: { status: "ok", summary: task, result: task, artifacts: [] } });
	}
	getLastAssistantText() { return "done"; }
	async abort() {}
	dispose() {}
	setActiveToolsByName() {}
}

setRegistryPathForTests(path.join(root, ".pi", "agent", "pi-subagents", "runs-index.jsonl"));
const restoreRuntime = __setChildAgentExecutorDepsForTest({
	DefaultResourceLoader: FakeResourceLoader,
	getAgentDir: () => "/tmp/pi-agent",
	SessionManager: { open: (file) => ({ getSessionId: () => "session-" + file }) },
	createAgentSession: async () => ({ session: new FakeSession(), extensionsResult: { extensions: [], diagnostics: [] } }),
});

try {
	const executor = createSubagentExecutor({
		pi: { events: { emit: () => {} }, getSessionName: () => undefined, setSessionName: () => {}, getAllTools: () => [] },
		state: { baseCwd: root, currentSessionId: null, asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null, cleanupTimers: new Map(), lastUiContext: null, poller: null },
		config: { parallel: { concurrency: 2 } },
		asyncByDefault: false,
		tempArtifactsDir: root,
		childRegistry: new ChildAgentRegistry(),
		expandTilde: (value) => value,
		discoverAgents: () => ({ agents: [makeAgent("A", { model: "mock/test-model" }), makeAgent("B", { model: "mock/test-model" })] }),
	});
	const ctx = { cwd: root, hasUI: false, ui: {}, sessionManager: { getSessionId: () => "workflow-parent", getSessionFile: () => null }, modelRegistry: { getAvailable: () => [{ provider: "mock", id: "test-model" }], hasConfiguredAuth: () => true, getApiKeyAndHeaders: () => ({ apiKey: "test", headers: {} }) }, model: { provider: "mock" } };
	const tool = createWorkflowTool({ openWorkflowGroup: (workflowContext) => executor.openWorkflowGroup(workflowContext) });

	const result = await tool.execute("wf", { script: "await agent('A', 'lone');\\nphase('phase-one');\\nphase('phase-two');\\nawait parallel([() => agent('A', 'left'), () => agent('B', 'right')]);" }, new AbortController().signal, undefined, ctx);
	if (result?.isError) throw new Error(JSON.stringify(result));

	const entries = readAllEntries();
	const group = entries.find((entry) => entry.kind === "workflow");
	assert.ok(group, "workflow group entry is stamped with kind:'workflow'");
	assert.equal(group.mode, "parallel", "workflow group keeps mode:'parallel'");
	assert.equal(Object.hasOwn(group, "agentName"), false, "workflow group has no agentName");
	assert.equal(Object.hasOwn(group, "agentNames"), false, "workflow group has no agentNames");
	assert.equal(fs.existsSync(path.join(group.runRecordDir, "status.json")), false, "workflow group stays statusless");

	const children = entries.filter((entry) => entry.parentRunId === group.runId);
	assert.equal(children.length, 3);
	const lone = children.find((entry) => !entry.parallelGroupId);
	assert.ok(lone, "lone agent has no parallelGroupId");
	assert.equal(lone.phaseIndex, 0, "lone agent before phase() is tagged phaseIndex 0: " + JSON.stringify(children));
	assert.equal(Object.hasOwn(lone, "phaseTitle"), false, "lone agent before phase() has no phaseTitle");

	const parallelChildren = children.filter((entry) => entry.parallelGroupId);
	assert.equal(parallelChildren.length, 2);
	assert.equal(new Set(parallelChildren.map((entry) => entry.parallelGroupId)).size, 1, "parallel batch children share one parallelGroupId");
	for (const child of parallelChildren) {
		assert.equal(child.phaseIndex, 2, "parallel child records current phaseIndex");
		assert.equal(child.phaseTitle, "phase-two", "parallel child records current phaseTitle");
	}

	const groupsBeforeFail = new Set(readAllEntries().filter((entry) => entry.kind === "workflow").map((entry) => entry.runId));
	const failResult = await tool.execute("wf", { script: "phase('fail-phase');\\nawait agent('A', 'ok');\\nthrow new Error('boom');" }, new AbortController().signal, undefined, ctx);
	assert.equal(failResult?.isError, true);
	const failEntries = readAllEntries();
	const failGroup = failEntries.find((entry) => entry.kind === "workflow" && !groupsBeforeFail.has(entry.runId));
	assert.ok(failGroup, "raw-failure workflow opens a group");
	assert.equal(fs.existsSync(path.join(failGroup.runRecordDir, "status.json")), false, "raw-failure workflow group stays statusless");
	const failChildren = failEntries.filter((entry) => entry.parentRunId === failGroup.runId);
	const syntheticFail = failChildren.find((entry) => entry.agentName === "workflow");
	assert.ok(syntheticFail, "raw workflow error records a synthetic failed workflow child");
	assert.equal(syntheticFail.phaseIndex, 1, "synthetic failed child records current phaseIndex");
	assert.equal(syntheticFail.phaseTitle, "fail-phase", "synthetic failed child records current phaseTitle");

	const groupsBeforeAsyncFail = new Set(readAllEntries().filter((entry) => entry.kind === "workflow").map((entry) => entry.runId));
	await tool.execute("wf", { async: true, script: "phase('async-fail-phase');\\nawait agent('A', 'async-ok');\\nthrow new Error('async boom');" }, new AbortController().signal, undefined, ctx);
	let asyncEntries = readAllEntries();
	const asyncGroup = asyncEntries.find((entry) => entry.kind === "workflow" && !groupsBeforeAsyncFail.has(entry.runId));
	assert.ok(asyncGroup, "async raw-failure workflow opens a group");
	const deadline = Date.now() + 2000;
	let asyncSyntheticFail;
	while (Date.now() < deadline) {
		asyncEntries = readAllEntries();
		asyncSyntheticFail = asyncEntries.find((entry) => entry.parentRunId === asyncGroup.runId && entry.agentName === "workflow");
		if (asyncSyntheticFail) break;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	assert.ok(asyncSyntheticFail, "async raw workflow error records a synthetic failed workflow child");
	assert.equal(fs.existsSync(path.join(asyncGroup.runRecordDir, "status.json")), false, "async raw-failure workflow group stays statusless");
	assert.equal(asyncSyntheticFail.phaseIndex, 1, "async synthetic failed child records current phaseIndex");
	assert.equal(asyncSyntheticFail.phaseTitle, "async-fail-phase", "async synthetic failed child records current phaseTitle");
} finally {
	restoreRuntime?.();
	setRegistryPathForTests(null);
	fs.rmSync(root, { recursive: true, force: true });
}
`;

		const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
			cwd: repoRoot,
			encoding: "utf8",
			env: { ...process.env },
		});
		assert.equal(child.status, 0, child.stderr || child.stdout);
	});
});
