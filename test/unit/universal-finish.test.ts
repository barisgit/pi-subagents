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

const cleanup: string[] = [];
const restoreFns: Array<() => void> = [];

afterEach(() => {
	while (restoreFns.length > 0) restoreFns.pop()?.();
});

after(() => {
	for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });
});

let lastLoaderOptions: { appendSystemPromptOverride?: (base: string[]) => string[] } | undefined;
class FakeResourceLoader {
	constructor(options: { appendSystemPromptOverride?: (base: string[]) => string[] }) {
		lastLoaderOptions = options;
	}
	async reload(): Promise<void> {}
}

// A child that finishes by ending its final assistant message with a trailing
// <output> block (the contract) AFTER a prose preamble in the SAME turn. There is
// no finish tool: the runtime must take the block, not the preamble.
class FakeAgentSession {
	async bindExtensions(): Promise<void> {}
	prompts: string[] = [];
	listeners: Array<(event: Record<string, unknown>) => void> = [];

	subscribe(listener: (event: Record<string, unknown>) => void): () => void {
		this.listeners.push(listener);
		return () => {};
	}

	async prompt(text: string): Promise<void> {
		this.prompts.push(text);
	}

	getLastAssistantText(): string {
		return "PREAMBLE: here is my reasoning\n<output>structured payload</output>";
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

function makeStep(root: string): ChildAgentStep {
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
		activeToolNames: undefined,
		systemPrompt: "Fix things.",
		systemPromptAppend: "END WITH <output>...</output>",
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
			createAgentSession: (async () => {
				return { session: session as never, extensionsResult: { extensions: [], diagnostics: [] } } as never;
			}) as never,
		}),
	);
}

describe("universal finish", () => {
	it("sends the task unpolluted and uses the <output> block, not the same-turn preamble", async () => {
		const root = tempDir();
		const session = new FakeAgentSession();
		install(session);

		const result = await runChildAgent(makeStep(root), makeContext());

		// The contract rides the additive append channel on the resource loader, not the task or a tool.
		const appended = lastLoaderOptions?.appendSystemPromptOverride?.(["base"]) ?? [];
		assert.ok(
			appended.some((line) => line.includes("<output>")),
			"output contract delivered through appendSystemPromptOverride",
		);
		// The finish contract never pollutes the task string.
		assert.equal(session.prompts[0], "Do it");
		assert.doesNotMatch(session.prompts[0] ?? "", /<output>/);
		assert.equal(result.outputText, "structured payload");
		assert.deepEqual(result.structuredResult, { result: "structured payload" });
	});
});
