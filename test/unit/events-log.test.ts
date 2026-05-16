import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { readEventLog } from "../../events-log.ts";

function makeAsyncDir(): string {
	const dir = path.join(os.tmpdir(), `events-log-${randomUUID()}`);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

function writeEvents(dir: string, events: Array<Record<string, unknown>>): void {
	const lines = events.map((e) => JSON.stringify(e)).join("\n");
	fs.writeFileSync(path.join(dir, "events.jsonl"), `${lines}\n`);
}

describe("readEventLog", () => {
	it("returns [] when events.jsonl does not exist", () => {
		const dir = makeAsyncDir();
		assert.deepEqual(readEventLog(dir), []);
	});

	it("parses step-start, matched tool start/end with durationMs, step-end, and final-text", () => {
		const dir = makeAsyncDir();
		writeEvents(dir, [
			{ type: "subagent.step.started", ts: 1000, runId: "r1", stepIndex: 0, agent: "fixer" },
			{
				type: "tool_execution_start",
				observedAt: 1100,
				subagentRunId: "r1",
				subagentStepIndex: 0,
				subagentAgent: "fixer",
				toolCallId: "tc1",
				toolName: "Read",
				args: { path: "/tmp/foo.ts" },
			},
			{
				type: "tool_execution_end",
				observedAt: 1250,
				subagentRunId: "r1",
				subagentStepIndex: 0,
				toolCallId: "tc1",
				toolName: "Read",
				result: { ok: true },
			},
			{
				type: "message_end",
				subagentStepIndex: 0,
				subagentAgent: "fixer",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "All done." },
					],
				},
			},
			{
				type: "subagent.step.completed",
				ts: 1500,
				runId: "r1",
				stepIndex: 0,
				agent: "fixer",
				durationMs: 500,
				tokens: { total: 42 },
				status: "completed",
			},
			{ type: "subagent.run.completed", ts: 1501, runId: "r1", status: "complete", durationMs: 501 },
		]);

		const lines = readEventLog(dir);
		assert.equal(lines.length, 4);

		const [start, tool, end, finalText] = lines;
		assert.equal(start.kind, "step-start");
		assert.equal(tool.kind, "tool");
		assert.equal(end.kind, "step-end");
		assert.equal(finalText.kind, "final-text");

		if (start.kind === "step-start") {
			assert.equal(start.stepIndex, 0);
			assert.equal(start.agent, "fixer");
			assert.equal(start.ts, 1000);
		}
		if (tool.kind === "tool") {
			assert.equal(tool.toolName, "Read");
			assert.equal(tool.durationMs, 150);
			assert.equal(tool.argsPreview, '{"path":"/tmp/foo.ts"}');
		}
		if (end.kind === "step-end") {
			assert.equal(end.durationMs, 500);
			assert.equal(end.tokens, 42);
			assert.equal(end.status, "completed");
		}
		if (finalText.kind === "final-text") {
			assert.equal(finalText.text, "All done.");
			assert.equal(finalText.agent, "fixer");
		}
	});

	it("returns identical array reference on cache hit when mtime+size unchanged", () => {
		const dir = makeAsyncDir();
		writeEvents(dir, [
			{ type: "subagent.step.started", ts: 1, runId: "r1", stepIndex: 0, agent: "x" },
		]);
		const first = readEventLog(dir);
		const second = readEventLog(dir);
		assert.equal(first, second, "expected same array reference on cache hit");
	});

	it("invalidates cache when file is rewritten with different size", () => {
		const dir = makeAsyncDir();
		writeEvents(dir, [
			{ type: "subagent.step.started", ts: 1, runId: "r1", stepIndex: 0, agent: "x" },
		]);
		const first = readEventLog(dir);
		assert.equal(first.length, 1);

		// Wait briefly and rewrite with more content so size differs.
		const eventsPath = path.join(dir, "events.jsonl");
		const newer = [
			{ type: "subagent.step.started", ts: 1, runId: "r1", stepIndex: 0, agent: "x" },
			{ type: "subagent.step.started", ts: 2, runId: "r1", stepIndex: 1, agent: "y" },
		];
		fs.writeFileSync(eventsPath, `${newer.map((e) => JSON.stringify(e)).join("\n")}\n`);

		const second = readEventLog(dir);
		assert.notEqual(first, second, "expected new array reference after size change");
		assert.equal(second.length, 2);
	});
});
