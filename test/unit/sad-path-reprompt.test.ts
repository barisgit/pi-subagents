import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { Type, type TSchema } from "typebox";
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
	async bindExtensions(): Promise<void> {}
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

class SchemaInvalidOutputSession {
	async bindExtensions(): Promise<void> {}
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
		this.lastAssistantText = 'The result is ready.\n<output>{"ok": "yes", "extra": true}</output>';
		this.messages.push({ role: "assistant", content: [{ type: "text", text: this.lastAssistantText }] });
	}
	getLastAssistantText(): string {
		return this.lastAssistantText;
	}
	async abort(): Promise<void> {}
	dispose(): void {}
	setActiveToolsByName(): void {}
}

// Streams a prose PREAMBLE via text_delta, then lands a compliant <output> block
// in the final assistant text. The executor's ChildAgentResult.outputText is what
// the status.json writer persists, so this pins the async/post-reload channel
// (which never passes through child-step-runner) to the block, not the preamble.
class PreambleThenSubmitSession {
	async bindExtensions(): Promise<void> {}
	messages: unknown[] = [];
	prompts: string[] = [];
	lastAssistantText = "";
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
		this.lastAssistantText =
			"PREAMBLE: let me compile the findings.\n<output>REAL RESULT: VERDICT APPROVED</output>";
		this.messages.push({ role: "assistant", content: [{ type: "text", text: this.lastAssistantText }] });
	}
	getLastAssistantText(): string {
		return this.lastAssistantText;
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
function makeStep(root: string, resultSchema?: TSchema): ChildAgentStep {
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
		activeToolNames: [],
		systemPrompt: "Fix things.",
		skillsResolved: [],
		sessionFile: path.join(root, "session.jsonl"),
		runRecordDir: root,
		maxSubagentDepth: 1,
		shareEnabled: false,
		resultSchema,
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
	it("bounds missing <output> reprompts and falls back to text without hard-failing", async () => {
		const session = new ProseOnlySession();
		install(session);

		const result = await runChildAgent(makeStep(tempDir()), makeContext());

		assert.equal(result.state, "complete");
		assert.equal(result.exitCode, 0);
		assert.equal(session.prompts.length, 3, "initial prompt + exactly 2 reprompts");
		assert.match(session.prompts[1] ?? "", /<output>/);
		assert.deepEqual(result.structuredResult, {
			result: "Final prose-only completion after bounded nudges.",
		});
		assert.equal(result.outputText, "Final prose-only completion after bounded nudges.");
	});

	it("surfaces the <output> block over a same-turn preamble (status.json channel)", async () => {
		const session = new PreambleThenSubmitSession();
		install(session);

		const result = await runChildAgent(makeStep(tempDir()), makeContext());

		assert.equal(result.state, "complete");
		// No reprompt: a compliant <output> block is already present.
		assert.equal(session.prompts.length, 1);
		assert.deepEqual(result.structuredResult, { result: "REAL RESULT: VERDICT APPROVED" });
		// The persisted/async-visible field must be the block, never the preamble.
		assert.equal(result.outputText, "REAL RESULT: VERDICT APPROVED");
	});

	it("reprompts schema-invalid <output> blocks and fails closed", async () => {
		const session = new SchemaInvalidOutputSession();
		install(session);
		const statuses: Array<{ state?: string; outputText?: string }> = [];
		const schema = Type.Object({ ok: Type.Boolean() }, { additionalProperties: false });

		const result = await runChildAgent(makeStep(tempDir(), schema), {
			...makeContext(),
			onStatusUpdate: (patch) => statuses.push(patch),
		});

		assert.equal(result.state, "failed");
		assert.notEqual(result.exitCode, 0);
		assert.equal(result.error?.reason, "schema_validation");
		assert.equal(session.prompts.length, 3, "initial prompt + exactly 2 schema reprompts");
		assert.match(session.prompts[1] ?? "", /did not match the required JSON shape/);
		assert.deepEqual(result.structuredResult, undefined);
		assert.equal(result.outputText, 'The result is ready.\n<output>{"ok": "yes", "extra": true}</output>');
		const finalStatus = statuses.at(-1);
		assert.equal(finalStatus?.state, "failed");
		assert.equal(finalStatus?.outputText, result.outputText);
	});
});
