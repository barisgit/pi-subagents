import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { createSubagentExecutor } from "../../src/dispatch/subagent-executor.ts";
import { ChildAgentRegistry, __setChildAgentExecutorDepsForTest } from "../../src/dispatch/in-process-executor.ts";
import { readAllEntries, setRegistryPathForTests } from "../../src/state/runs-registry.ts";
import { readWorkflowJournal } from "../../src/workflow/workflow-group-state.ts";
import { createWorkflowTool } from "../../src/workflow/workflow.ts";
import { makeAgent } from "../support/helpers.ts";

const roots: string[] = [];
let restoreRuntime: (() => void) | undefined;
let previousHome: string | undefined;
let promptImpl: ((task: string) => Promise<void>) | undefined;
let abortImpl: (() => void) | undefined;
const loadedCwds: string[] = [];

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

class FakeResourceLoader {
	constructor(options: { cwd: string }) {
		loadedCwds.push(options.cwd);
	}
	async reload(): Promise<void> {}
}
class FakeSession {
	async bindExtensions(): Promise<void> {}
	messages: unknown[] = [];
	lastAssistantText = "";
	private listeners: Array<(event: unknown) => void> = [];
	subscribe(listener: (event: unknown) => void): () => void {
		this.listeners.push(listener);
		return () => {
			this.listeners = this.listeners.filter((entry) => entry !== listener);
		};
	}
	async prompt(task: string): Promise<void> {
		if (promptImpl) await promptImpl(task);
		for (const listener of this.listeners)
			listener({ type: "message_update", assistantMessageEvent: { type: "thinking_delta" } });
		this.lastAssistantText = `<output>${task}</output>`;
	}
	getLastAssistantText(): string {
		return this.lastAssistantText;
	}
	async abort(): Promise<void> {
		abortImpl?.();
	}
	dispose(): void {}
	setActiveToolsByName(): void {}
}

function setup(prefix: string, config: Record<string, unknown> = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	roots.push(root);
	previousHome = process.env.HOME;
	process.env.HOME = root;
	setRegistryPathForTests(path.join(root, ".pi", "agent", "pi-subagents", "runs-index.jsonl"));
	restoreRuntime = __setChildAgentExecutorDepsForTest({
		DefaultResourceLoader: FakeResourceLoader as never,
		getAgentDir: () => "/tmp/pi-agent",
		SessionManager: { open: (file: string) => ({ getSessionId: () => `session-${file}` }) as never },
		createAgentSession: async () =>
			({ session: new FakeSession() as never, extensionsResult: { extensions: [], diagnostics: [] } }) as never,
	});
	const executor = createSubagentExecutor({
		pi: {
			events: { emit: () => {} },
			getSessionName: () => undefined,
			setSessionName: () => {},
			getAllTools: () => [],
		},
		state: {
			baseCwd: root,
			currentSessionId: null,
			asyncJobs: new Map(),
			foregroundControls: new Map(),
			lastForegroundControlId: null,
			cleanupTimers: new Map(),
			lastUiContext: null,
			poller: null,
		},
		config,
		asyncByDefault: false,
		tempArtifactsDir: root,
		childRegistry: new ChildAgentRegistry(),
		expandTilde: (value: string) => value,
		discoverAgents: () => ({
			agents: [makeAgent("A", { model: "mock/test-model" }), makeAgent("B", { model: "mock/test-model" })],
		}),
	} as never);
	const ctx = {
		cwd: root,
		hasUI: false,
		ui: {},
		sessionManager: { getSessionId: () => "workflow-parent", getSessionFile: () => null },
		modelRegistry: { getAvailable: () => [{ provider: "mock", id: "test-model" }] },
		model: { provider: "mock" },
	};
	return { root, executor, ctx };
}

afterEach(() => {
	promptImpl = undefined;
	abortImpl = undefined;
	loadedCwds.length = 0;
	restoreRuntime?.();
	restoreRuntime = undefined;
	setRegistryPathForTests(null);
	if (previousHome === undefined) delete process.env.HOME;
	else process.env.HOME = previousHome;
	previousHome = undefined;
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const prompted: string[] = [];

function workflowTool(executor: ReturnType<typeof setup>["executor"]) {
	return createWorkflowTool({
		openWorkflowGroup: (workflowContext) => executor.openWorkflowGroup(workflowContext),
	});
}

function workflowIds(): string[] {
	return readAllEntries()
		.filter((entry) => entry.kind === "workflow")
		.map((entry) => entry.runId);
}

function runRecordDir(runId: string): string {
	return readAllEntries().find((entry) => entry.runId === runId)!.runRecordDir;
}

const SCRIPT = `
const first = await agent('A', 'first');
const second = await agent('B', 'second');
return first + '+' + second;
`;

describe("workflow resume", () => {
	afterEach(() => {
		prompted.length = 0;
	});

	it("replays completed calls and continues the interrupted child in place", async () => {
		const { executor, ctx } = setup("workflow-resume-continue-");
		const tool = workflowTool(executor);
		const blocked = deferred();
		const release = deferred();
		promptImpl = async (task) => {
			prompted.push(task);
			if (task.includes("second")) {
				blocked.resolve();
				await release.promise;
			}
		};
		abortImpl = release.resolve;
		const controller = new AbortController();
		const execution = tool.execute("wf", { script: SCRIPT }, controller.signal, undefined, ctx as never);
		await blocked.promise;
		controller.abort(new Error("stop workflow"));
		const interrupted = await execution;
		assert.equal(interrupted.isError, true);

		const [workflowId] = workflowIds();
		const journal = readWorkflowJournal(runRecordDir(workflowId!));
		assert.equal(journal.results.size, 1, "only the finished call is journaled as a result");
		assert.equal(journal.runIds.size, 2, "both started calls record their run id");
		const [unfinishedKey, unfinishedRunId] = [...journal.runIds].find(([key]) => !journal.results.has(key))!;

		// The fake session never writes transcripts; give the interrupted child history.
		const status = JSON.parse(fs.readFileSync(path.join(runRecordDir(unfinishedRunId), "status.json"), "utf8"));
		const sessionFile: string = status.steps?.[0]?.sessionFile ?? status.sessionFile;
		const history = '{"type":"session","id":"old-session"}\n{"type":"message","id":"m1"}\n';
		fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
		fs.writeFileSync(sessionFile, history);
		const childrenBefore = readAllEntries().filter((entry) => entry.parentRunId === workflowId).length;

		prompted.length = 0;
		promptImpl = async (task) => {
			prompted.push(task);
		};
		const resumed = await tool.execute(
			"wf-resume",
			{ resume: workflowId! },
			new AbortController().signal,
			undefined,
			ctx as never,
		);

		assert.equal(resumed.isError, undefined);
		assert.deepEqual(workflowIds(), [workflowId], "resume keeps the same workflow id");
		assert.equal(prompted.length, 1, "the completed call is not dispatched again");
		assert.match(prompted[0]!, /session was interrupted/);
		assert.doesNotMatch(prompted[0]!, /second/, "the original task is not re-sent");
		assert.equal(
			readAllEntries().filter((entry) => entry.parentRunId === workflowId).length,
			childrenBefore,
			"the unfinished child continues under its own run id",
		);
		const after = readWorkflowJournal(runRecordDir(workflowId!));
		assert.equal(after.runIds.get(unfinishedKey), unfinishedRunId);
		assert.ok(after.results.has(unfinishedKey), "the continued call is journaled once it finishes");
		const resumedStatus = JSON.parse(
			fs.readFileSync(path.join(runRecordDir(unfinishedRunId), "status.json"), "utf8"),
		);
		assert.equal(resumedStatus.state, "complete");
		assert.equal(resumedStatus.resumeCount, 1);
		assert.equal(fs.readFileSync(sessionFile, "utf8"), history, "the session file is reused, not copied");
	});

	it("replays every call of a finished workflow, repeatedly", async () => {
		const { executor, ctx } = setup("workflow-resume-replay-");
		const tool = workflowTool(executor);
		promptImpl = async (task) => {
			prompted.push(task);
		};
		const signal = new AbortController().signal;
		const original = await tool.execute("wf", { script: SCRIPT }, signal, undefined, ctx as never);
		const text = (result: typeof original) => (result.content[0] as { text: string }).text;
		assert.equal(prompted.length, 2);

		prompted.length = 0;
		const [workflowId] = workflowIds();
		const resumed = await tool.execute("wf-2", { resume: workflowId! }, signal, undefined, ctx as never);
		const again = await tool.execute("wf-3", { resume: workflowId! }, signal, undefined, ctx as never);

		assert.equal(prompted.length, 0);
		assert.deepEqual(workflowIds(), [workflowId]);
		assert.equal(text(resumed), text(original));
		assert.equal(text(again), text(original));
	});

	it("dispatches only the call whose task changed in a corrected script", async () => {
		const { executor, ctx } = setup("workflow-resume-edit-");
		const tool = workflowTool(executor);
		promptImpl = async (task) => {
			prompted.push(task);
		};
		const signal = new AbortController().signal;
		await tool.execute("wf", { script: SCRIPT }, signal, undefined, ctx as never);
		prompted.length = 0;
		const [firstRun] = workflowIds();

		await tool.execute(
			"wf-2",
			{ resume: firstRun!, script: SCRIPT.replace("'second'", "'second, fixed'") },
			signal,
			undefined,
			ctx as never,
		);

		assert.equal(prompted.length, 1);
		assert.match(prompted[0]!, /second, fixed/);
	});

	it("resumes a workflow whose script failed once the script is corrected", async () => {
		const { executor, ctx } = setup("workflow-resume-script-error-");
		const tool = workflowTool(executor);
		promptImpl = async (task) => {
			prompted.push(task);
		};
		const signal = new AbortController().signal;
		const broken = SCRIPT.replace("return first", "throw new Error('typo'); return first");
		const failed = await tool.execute("wf", { script: broken }, signal, undefined, ctx as never);
		assert.equal(failed.isError, true);
		const [workflowId] = workflowIds();
		assert.match((failed.content[0] as { text: string }).text, new RegExp(`resume: \\\\?"${workflowId}`));

		prompted.length = 0;
		const fixed = await tool.execute(
			"wf-2",
			{ resume: workflowId!, script: SCRIPT },
			signal,
			undefined,
			ctx as never,
		);

		assert.equal(fixed.isError, undefined);
		assert.equal(prompted.length, 0, "both calls replay from the journal");
		assert.equal((fixed.content[0] as { text: string }).text.includes("first+second"), true);
		const failure = readAllEntries().find(
			(entry) => entry.parentRunId === workflowId && entry.agentName === "workflow",
		)!;
		const failureStatus = JSON.parse(fs.readFileSync(path.join(failure.runRecordDir, "status.json"), "utf8"));
		assert.equal(failureStatus.state, "complete", "the earlier script failure no longer fails the workflow");
	});

	it("rejects resuming a workflow owned by another root session", async () => {
		const { executor, ctx } = setup("workflow-resume-owner-");
		const tool = workflowTool(executor);
		const signal = new AbortController().signal;
		await tool.execute("wf", { script: SCRIPT }, signal, undefined, ctx as never);
		const [workflowId] = workflowIds();
		const otherCtx = { ...ctx, sessionManager: { getSessionId: () => "other-parent", getSessionFile: () => null } };

		const result = await tool.execute("wf-2", { resume: workflowId! }, signal, undefined, otherCtx as never);

		assert.equal(result.isError, true);
		assert.match((result.content[0] as { text: string }).text, /owning root session/);
	});

	it("rejects an unknown workflow id without opening a workflow", async () => {
		const { executor, ctx } = setup("workflow-resume-unknown-");
		const result = await workflowTool(executor).execute(
			"wf",
			{ resume: "missing" },
			new AbortController().signal,
			undefined,
			ctx as never,
		);

		assert.equal(result.isError, true);
		assert.match((result.content[0] as { text: string }).text, /Unknown workflow id 'missing'/);
		assert.deepEqual(workflowIds(), []);
	});
});

describe("async workflow across an extension reload", () => {
	it("finishes without touching the stale ctx after reload", async () => {
		const { executor, ctx } = setup("workflow-reload-stale-ctx-");
		let stale = false;
		const guard = <T>(value: T): T => {
			if (stale) throw new Error("This extension ctx is stale after session replacement or reload.");
			return value;
		};
		// Mirrors Pi's ctx: own getters that throw once the activation is replaced.
		const liveCtx = {
			get cwd() {
				return guard(ctx.cwd);
			},
			get hasUI() {
				return guard(ctx.hasUI);
			},
			get ui() {
				return guard(ctx.ui);
			},
			get sessionManager() {
				return guard(ctx.sessionManager);
			},
			get modelRegistry() {
				return guard(ctx.modelRegistry);
			},
			get model() {
				return guard(ctx.model);
			},
		};
		const blocked = deferred();
		const release = deferred();
		promptImpl = async (task) => {
			if (task.includes("first")) {
				blocked.resolve();
				await release.promise;
			}
		};
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			const started = await workflowTool(executor).execute(
				"wf",
				{ script: SCRIPT, async: true },
				new AbortController().signal,
				undefined,
				liveCtx as never,
			);
			assert.equal(started.isError, undefined);
			await blocked.promise;
			stale = true;
			release.resolve();

			const [workflowId] = workflowIds();
			const groupFile = path.join(runRecordDir(workflowId!), "workflow-group.json");
			const readState = () =>
				fs.existsSync(groupFile) ? JSON.parse(fs.readFileSync(groupFile, "utf8")).state : undefined;
			for (let attempt = 0; attempt < 200 && readState() === "running"; attempt++) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}

			assert.equal(readState(), "complete", "the second child starts and the workflow completes");
			assert.deepEqual(unhandled, []);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});
});
