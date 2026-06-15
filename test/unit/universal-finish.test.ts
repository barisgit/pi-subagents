import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, describe, it } from "node:test";
import {
	ChildAgentRegistry,
	__setChildAgentExecutorDepsForTest,
	runChildAgent,
	type ChildAgentContext,
	type ChildAgentStep,
} from "../../src/dispatch/in-process-executor.ts";
import { createSubmitResultTool } from "../../src/protocol/submit-result.ts";

const cleanup: string[] = [];
const restoreFns: Array<() => void> = [];

afterEach(() => {
	while (restoreFns.length > 0) restoreFns.pop()?.();
});

after(() => {
	for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });
});

class FakeResourceLoader {
	async reload(): Promise<void> {}
}

class FakeAgentSession {
	messages: unknown[] = [];
	prompts: string[] = [];
	listeners: Array<(event: Record<string, unknown>) => void> = [];

	subscribe(listener: (event: Record<string, unknown>) => void): () => void {
		this.listeners.push(listener);
		return () => {};
	}

	async prompt(text: string): Promise<void> {
		this.prompts.push(text);
		const envelope = { status: "ok", summary: "structured", result: "structured payload", artifacts: [] };
		this.messages.push({
			role: "assistant",
			content: [{ type: "toolCall", id: "submit", name: "submit_result", arguments: envelope }],
		});
		this.messages.push({ role: "toolResult", toolName: "submit_result", details: envelope });
	}

	getLastAssistantText(): string {
		return "";
	}
	async abort(): Promise<void> {}
	dispose(): void {}
	setActiveToolsByName(): void {}
}

function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-universal-finish-"));
	cleanup.push(dir);
	return dir;
}

function makeStep(root: string, session: FakeAgentSession): ChildAgentStep {
	return {
		runId: "run-1",
		stepIndex: 0,
		agentName: "fixer",
		agentConfig: { name: "fixer" } as never,
		task: "Do it",
		cwd: root,
		model: { provider: "mock", id: "model" } as never,
		modelCandidates: [],
		thinkingLevel: "off",
		activeToolNames: ["submit_result"],
		customTools: [createSubmitResultTool()],
		systemPrompt: "Fix things.",
		skillsResolved: [],
		sessionFile: path.join(root, "session.jsonl"),
		runRecordDir: root,
		maxSubagentDepth: 1,
		shareEnabled: false,
	};
}

function makeContext(): ChildAgentContext {
	return {
		extensionCtx: { modelRegistry: {} } as never,
		abortSignal: new AbortController().signal,
		registry: new ChildAgentRegistry(),
		pi: {} as never,
	};
}

function install(session: FakeAgentSession): void {
	restoreFns.push(
		__setChildAgentExecutorDepsForTest({
			DefaultResourceLoader: FakeResourceLoader as never,
			getAgentDir: () => "/tmp/pi-agent",
			SessionManager: { open: () => ({}) as never },
			createAgentSession: (async (options?: { customTools?: unknown[]; tools?: string[] }) => {
				assert.equal(
					options?.customTools?.some(
						(tool) =>
							(tool as { name?: string; execute?: unknown }).name === "submit_result" &&
							typeof (tool as { execute?: unknown }).execute === "function",
					),
					true,
				);
				assert.deepEqual(options?.tools, ["submit_result"]);
				return { session: session as never, extensionsResult: { extensions: [], diagnostics: [] } } as never;
			}) as never,
		}),
	);
}

describe("universal finish", () => {
	it("sends the task unpolluted and uses the compliant envelope as the child result", async () => {
		const root = tempDir();
		const session = new FakeAgentSession();
		install(session);

		const result = await runChildAgent(makeStep(root, session), makeContext());

		// The finish contract no longer pollutes the task string: it rides on the tool description + system prompt.
		assert.equal(session.prompts[0], "Do it");
		assert.doesNotMatch(session.prompts[0] ?? "", /Structured finish/);
		assert.equal(result.outputText, "structured payload");
		assert.deepEqual(result.structuredResult, {
			status: "ok",
			summary: "structured",
			result: "structured payload",
			artifacts: [],
		});
	});
});
