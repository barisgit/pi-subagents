import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Compile } from "typebox/compile";
import { SubagentParams } from "../../src/protocol/schemas.ts";
import { createSubagentExecutor, validateSubagentToolInput } from "../../src/dispatch/subagent-executor.ts";
import { ChildAgentRegistry, __setChildAgentExecutorDepsForTest } from "../../src/dispatch/in-process-executor.ts";
import { createTempDir, events, makeAgent, removeTempDir } from "../support/helpers.ts";

type Listener = (event: Record<string, unknown>) => void;

interface ExecutorResult {
	isError?: boolean;
	content: Array<{ type?: string; text?: string }>;
	details?: {
		mode?: string;
		results?: Array<{ agent?: string; task?: string; exitCode?: number }>;
	};
}

class FakeResourceLoader {
	async reload(): Promise<void> {}
}

class FakeAgentSession {
	async bindExtensions(): Promise<void> {}
	private listeners: Listener[] = [];
	messages: unknown[] = [];
	private readonly promptImpl: (task: string, session: FakeAgentSession) => Promise<void>;

	constructor(promptImpl: (task: string, session: FakeAgentSession) => Promise<void>) {
		this.promptImpl = promptImpl;
	}

	subscribe(listener: Listener): () => void {
		this.listeners.push(listener);
		return () => {
			this.listeners = this.listeners.filter((candidate) => candidate !== listener);
		};
	}

	emit(event: Record<string, unknown>): void {
		for (const listener of this.listeners) listener(event);
	}

	async prompt(task: string): Promise<void> {
		await this.promptImpl(task, this);
		this.lastAssistantText = `<output>${task}</output>`;
	}

	lastAssistantText = "";
	getLastAssistantText(): string {
		return this.lastAssistantText;
	}

	async abort(): Promise<void> {}

	dispose(): void {}

	setActiveToolsByName(): void {}
}

function installFakeRuntime(sessions: FakeAgentSession[]): () => void {
	return __setChildAgentExecutorDepsForTest({
		DefaultResourceLoader: FakeResourceLoader as never,
		getAgentDir: () => "/tmp/pi-agent",
		SessionManager: { open: (file: string) => ({ getSessionId: () => `session-${file}` }) as never },
		createAgentSession: async () => {
			const session = sessions.shift();
			if (!session) throw new Error("No fake session queued");
			return { session: session as never, extensionsResult: { extensions: [], diagnostics: [] } } as never;
		},
	});
}

function makeExecutor(cwd: string) {
	return createSubagentExecutor({
		pi: {
			events: { emit: () => {} },
			getSessionName: () => undefined,
			setSessionName: () => {},
			getAllTools: () => [],
		},
		state: {
			baseCwd: cwd,
			currentSessionId: null,
			asyncJobs: new Map(),
			foregroundControls: new Map(),
			lastForegroundControlId: null,
			cleanupTimers: new Map(),
			lastUiContext: null,
			poller: null,
		},
		config: {},
		asyncByDefault: false,
		tempArtifactsDir: cwd,
		childRegistry: new ChildAgentRegistry(),
		expandTilde: (value: string) => value,
		discoverAgents: () => ({
			agents: ["main", "A", "B"].map((name) => makeAgent(name, { model: "mock/test-model" })),
		}),
	} as never);
}

function makeCtx(cwd: string) {
	return {
		cwd,
		hasUI: false,
		ui: {},
		sessionManager: {
			getSessionId: () => "session-message-field",
			getSessionFile: () => null,
		},
		modelRegistry: { getAvailable: () => [{ provider: "mock", id: "test-model" }] },
		model: { provider: "mock" },
	};
}

async function execute(cwd: string, params: Record<string, unknown>): Promise<ExecutorResult> {
	return makeExecutor(cwd).execute(
		"id",
		params as never,
		new AbortController().signal,
		undefined,
		makeCtx(cwd) as never,
	) as Promise<ExecutorResult>;
}

function text(result: ExecutorResult | null): string {
	const first = result?.content[0];
	return first?.type === "text" || first?.text ? (first.text ?? "") : "";
}

describe("message field", () => {
	let tempDir: string;
	let restoreRuntime: (() => void) | undefined;

	beforeEach(() => {
		tempDir = createTempDir("pi-subagent-message-field-");
	});

	afterEach(() => {
		restoreRuntime?.();
		restoreRuntime = undefined;
		removeTempDir(tempDir);
	});

	it("message-field accepts message in the slim schema", () => {
		const validator = Compile(SubagentParams);

		assert.equal(validator.Check({ run: [{ agent: "main", task: "work" }], message: "context" }), true);
		assert.equal(validateSubagentToolInput({ run: [{ agent: "main", task: "work" }], message: "context" }), null);
	});

	it("task-substitution replaces {task} with each Task task", async () => {
		const seenTasks: string[] = [];
		restoreRuntime = installFakeRuntime([
			new FakeAgentSession(async (task, session) => {
				seenTasks.push(task);
				session.emit(events.assistantMessage("done") as Record<string, unknown>);
			}),
		]);

		const result = await execute(tempDir, {
			run: [{ agent: "A", task: "alpha" }],
			message: "Shared context for {task}",
		});

		assert.equal(result.isError, undefined, text(result));
		assert.deepEqual(seenTasks, ["Shared context for alpha"]);
	});

	it("in-substitution-equals-task resolves {in} like {task}", async () => {
		const seenTasks: string[] = [];
		restoreRuntime = installFakeRuntime(
			["a", "b"].map(
				() =>
					new FakeAgentSession(async (task, session) => {
						seenTasks.push(task);
						session.emit(events.assistantMessage("done") as Record<string, unknown>);
					}),
			),
		);

		const result = await execute(tempDir, {
			run: [
				{ agent: "A", task: "alpha" },
				{ agent: "B", task: "beta" },
			],
			message: "in={in}; task={task}",
		});

		assert.equal(result.isError, undefined, text(result));
		assert.deepEqual(seenTasks.sort(), ["in=alpha; task=alpha", "in=beta; task=beta"].sort());
	});

	it("prompt-rejected-with-hint says prompt renamed to message", () => {
		const error = validateSubagentToolInput({ run: [{ agent: "main", task: "work" }], prompt: "x" });

		assert.equal(error?.isError, true);
		assert.match(text(error), /`prompt` renamed to `message`/);
	});

	it("empty-message-accepted accepts an empty message", () => {
		const validator = Compile(SubagentParams);
		const input = { run: [{ agent: "main", task: "work" }], message: "" };

		assert.equal(validator.Check(input), true);
		assert.equal(validateSubagentToolInput(input), null);
	});

	it("resume-missing-message-rejected requires message on resume", () => {
		const error = validateSubagentToolInput({ action: "resume", id: "run-1" });

		assert.equal(error?.isError, true);
		assert.match(text(error), /requires `message`/);
	});
});
