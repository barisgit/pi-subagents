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

class FakeResourceLoader {
	async reload(): Promise<void> {}
}

class ProseOnlySession {
	messages: unknown[] = [];
	prompts: string[] = [];
	lastAssistantText = "";
	listeners: Array<(event: Record<string, unknown>) => void> = [];

	subscribe(listener: (event: Record<string, unknown>) => void): () => void {
		this.listeners.push(listener);
		return () => {};
	}
	async prompt(text: string): Promise<void> {
		this.prompts.push(text);
		this.lastAssistantText =
			[
				"First prose-only completion.",
				"Second prose-only completion after nudge.",
				"Final prose-only completion after bounded nudges.",
			][this.prompts.length - 1] ?? "unexpected";
		this.messages.push({ role: "assistant", content: [{ type: "text", text: this.lastAssistantText }] });
	}
	getLastAssistantText(): string {
		return this.lastAssistantText;
	}
	async abort(): Promise<void> {}
	dispose(): void {}
	setActiveToolsByName(): void {}
}

// Streams a prose PREAMBLE via text_delta, then lands a compliant submit_result
// toolResult -- the exact real-world shape (model narrates in the same turn as its
// final submit_result). The executor's ChildAgentResult.outputText is what the
// status.json writer persists, so this pins the async/post-reload channel (which
// never passes through child-step-runner) to the envelope, not the preamble.
class PreambleThenSubmitSession {
	messages: unknown[] = [];
	prompts: string[] = [];
	listeners: Array<(event: Record<string, unknown>) => void> = [];

	subscribe(listener: (event: Record<string, unknown>) => void): () => void {
		this.listeners.push(listener);
		return () => {};
	}
	emit(event: Record<string, unknown>): void {
		for (const listener of this.listeners) listener(event);
	}
	async prompt(text: string): Promise<void> {
		this.prompts.push(text);
		this.emit({ type: "text_delta", delta: "PREAMBLE: let me compile the findings." });
		this.messages.push({
			role: "assistant",
			content: [
				{ type: "text", text: "PREAMBLE: let me compile the findings." },
				{ type: "toolCall", name: "submit_result", arguments: { result: "REAL RESULT: VERDICT APPROVED" } },
			],
		});
		this.messages.push({
			role: "toolResult",
			toolName: "submit_result",
			isError: false,
			details: { result: "REAL RESULT: VERDICT APPROVED" },
		});
	}
	getLastAssistantText(): string {
		return "PREAMBLE: let me compile the findings.";
	}
	async abort(): Promise<void> {}
	dispose(): void {}
	setActiveToolsByName(): void {}
}

function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sad-path-"));
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
		activeToolNames: ["submit_result"],
		customTools: [],
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
function install(session: { subscribe: unknown }): void {
	restoreFns.push(
		__setChildAgentExecutorDepsForTest({
			DefaultResourceLoader: FakeResourceLoader as never,
			getAgentDir: () => "/tmp/pi-agent",
			SessionManager: { open: () => ({}) as never },
			createAgentSession: async () =>
				({ session: session as never, extensionsResult: { extensions: [], diagnostics: [] } }) as never,
		}),
	);
}

describe("sad-path reprompt", () => {
	it("bounds missing submit_result reprompts and falls back to text without hard-failing", async () => {
		const session = new ProseOnlySession();
		install(session);

		const result = await runChildAgent(makeStep(tempDir()), makeContext());

		assert.equal(result.state, "complete");
		assert.equal(result.exitCode, 0);
		assert.equal(session.prompts.length, 3, "initial prompt + exactly 2 reprompts");
		assert.match(session.prompts[1] ?? "", /You did not call submit_result/);
		assert.deepEqual(result.structuredResult, {
			result: "Final prose-only completion after bounded nudges.",
		});
		assert.equal(result.outputText, "Final prose-only completion after bounded nudges.");
	});

	it("surfaces the submit_result envelope over a same-turn preamble (status.json channel)", async () => {
		const session = new PreambleThenSubmitSession();
		install(session);

		const result = await runChildAgent(makeStep(tempDir()), makeContext());

		assert.equal(result.state, "complete");
		// No reprompt: a compliant submit_result is already present.
		assert.equal(session.prompts.length, 1);
		assert.deepEqual(result.structuredResult, { result: "REAL RESULT: VERDICT APPROVED" });
		// The persisted/async-visible field must be the envelope, never the preamble.
		assert.equal(result.outputText, "REAL RESULT: VERDICT APPROVED");
	});
});
