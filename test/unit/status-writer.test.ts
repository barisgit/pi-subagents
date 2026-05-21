import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { StatusWriter, __setStatusWriterWriteJsonForTest } from "../../status-writer.ts";
import type { ChildAgentResult } from "../../in-process-executor.ts";

const cleanup: string[] = [];
const restoreFns: Array<() => void> = [];

afterEach(() => {
	while (restoreFns.length > 0) restoreFns.pop()?.();
});

after(() => {
	for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	cleanup.push(dir);
	return dir;
}

function readStatus(dir: string): Record<string, unknown> {
	return JSON.parse(fs.readFileSync(path.join(dir, "status.json"), "utf-8")) as Record<string, unknown>;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function countStatusWrites(): { get count(): number } {
	let count = 0;
	const restore = __setStatusWriterWriteJsonForTest((filePath, payload) => {
		count++;
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf-8");
	});
	restoreFns.push(restore);
	return { get count() { return count; } };
}

function result(overrides: Partial<ChildAgentResult> = {}): ChildAgentResult {
	return {
		runId: "run-1",
		stepIndex: 0,
		state: "complete",
		exitCode: 0,
		outputText: "final text",
		toolCallCount: 1,
		toolResultCount: 1,
		toolErrorCount: 0,
		durationMs: 15,
		startedAt: 100,
		endedAt: 115,
		sessionFile: "/tmp/session.jsonl",
		...overrides,
	};
}

describe("StatusWriter", () => {
	it("coalesces three fast enqueue calls into one debounced disk write", async () => {
		const dir = tempDir("pi-status-writer-debounce-");
		const writes = countStatusWrites();
		const writer = new StatusWriter({ runRecordDir: dir, runId: "run-1", debounceMs: 30 });
		writer.initialize({ mode: "single", state: "queued", steps: [{ agent: "fixer", status: "queued" }] });
		const initialWrites = writes.count;

		writer.enqueue({ runId: "run-1", stepIndex: 0, state: "running" });
		writer.enqueue({ runId: "run-1", stepIndex: 0, liveText: "a" });
		writer.enqueue({ runId: "run-1", stepIndex: 0, liveText: "abc", toolCallDelta: 1 });
		assert.equal(writes.count, initialWrites);

		await delay(80);
		assert.equal(writes.count, initialWrites + 1);
		const status = readStatus(dir);
		assert.equal(status.state, "running");
		assert.equal(((status.steps as Array<{ live?: { outputText?: string; toolCallCount?: number } }>)[0]!.live?.outputText), "abc");
		assert.equal(((status.steps as Array<{ live?: { outputText?: string; toolCallCount?: number } }>)[0]!.live?.toolCallCount), 1);
	});

	it("finalize flushes synchronously and clears a pending debounce timer", async () => {
		const dir = tempDir("pi-status-writer-finalize-");
		const writes = countStatusWrites();
		const writer = new StatusWriter({ runRecordDir: dir, runId: "run-1", debounceMs: 100 });
		writer.initialize({ mode: "single", state: "queued", steps: [{ agent: "fixer", status: "queued" }] });
		const initialWrites = writes.count;

		writer.enqueue({ runId: "run-1", stepIndex: 0, state: "running", liveText: "partial" });
		await writer.finalize(result());
		assert.equal(writes.count, initialWrites + 1);

		await delay(140);
		assert.equal(writes.count, initialWrites + 1);
		const status = readStatus(dir);
		assert.equal(status.state, "complete");
		assert.equal(status.endedAt, 115);
		assert.equal(status.outputText, "final text");
		const step = (status.steps as Array<Record<string, unknown>>)[0]!;
		assert.equal(step.status, "complete");
		assert.equal(step.durationMs, 15);
	});

	it("records running state transitions and current tool activity", async () => {
		const dir = tempDir("pi-status-writer-state-");
		const writer = new StatusWriter({ runRecordDir: dir, runId: "run-1", debounceMs: 10 });
		writer.initialize({ mode: "chain", state: "queued", steps: [{ agent: "fixer", status: "queued" }] });

		writer.enqueue({
			runId: "run-1",
			stepIndex: 0,
			state: "running",
			activity: { state: "tool_running", toolName: "read", updatedAt: 200 },
			toolCallDelta: 1,
		});
		await delay(30);
		const status = readStatus(dir);

		assert.equal(status.mode, "chain");
		assert.equal(status.state, "running");
		assert.equal(status.currentTool, "read");
		assert.equal(status.currentToolStartedAt, 200);
		const step = (status.steps as Array<Record<string, unknown>>)[0]!;
		assert.equal(step.status, "running");
		assert.equal(step.currentTool, "read");
	});

	it("writes interrupted as a terminal state", async () => {
		const dir = tempDir("pi-status-writer-interrupted-");
		const writer = new StatusWriter({ runRecordDir: dir, runId: "run-1", debounceMs: 50 });
		writer.initialize({ mode: "single", state: "running", steps: [{ agent: "fixer", status: "running" }] });

		await writer.finalize(result({
			state: "interrupted",
			exitCode: 1,
			outputText: "partial",
			error: { message: "Child agent interrupted: session-reload", reason: "session-reload" },
		}));
		const status = readStatus(dir);

		assert.equal(status.state, "interrupted");
		assert.equal(status.outputText, "partial");
		assert.equal(status.error, "Child agent interrupted: session-reload");
		assert.equal((status.steps as Array<Record<string, unknown>>)[0]!.status, "interrupted");
	});
});
