import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { readRunTranscript } from "../../run-transcript.ts";
import type { AsyncStatus } from "../../types.ts";

function makeRunDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), `run-transcript-${randomUUID()}-`));
}

function writeStatus(dir: string, patch: Partial<AsyncStatus> = {}): void {
	const status: AsyncStatus = {
		runId: "run-a",
		mode: "single",
		state: "complete",
		startedAt: 1000,
		endedAt: 2200,
		lastUpdate: 2200,
		steps: [{ agent: "fixer", label: "check files", status: "complete", startedAt: 1000, endedAt: 2200, durationMs: 1200, tokens: { input: 1, output: 2, total: 3 } }],
		...patch,
	};
	fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify(status, null, 2));
}

function writeSession(dir: string, stepIndex: number, records: Array<Record<string, unknown>>): void {
	const runDir = path.join(dir, `run-${stepIndex}`);
	fs.mkdirSync(runDir, { recursive: true });
	const session = { type: "session", version: 3, id: "s1", timestamp: "2026-05-20T00:00:00.000Z", cwd: dir };
	fs.writeFileSync(path.join(runDir, "session.jsonl"), [session, ...records].map((record) => JSON.stringify(record)).join("\n") + "\n");
}

function assistant(timestamp: string, content: unknown[]): Record<string, unknown> {
	return { type: "message", timestamp, message: { role: "assistant", content } };
}

function user(timestamp: string, content: unknown[]): Record<string, unknown> {
	return { type: "message", timestamp, message: { role: "user", content } };
}

describe("readRunTranscript", () => {
	it("returns [] when no canonical session transcript exists", () => {
		const dir = makeRunDir();
		try {
			writeStatus(dir);
			assert.deepEqual(readRunTranscript(dir), []);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("normalizes session messages into right-pane transcript lines", () => {
		const dir = makeRunDir();
		try {
			writeStatus(dir);
			writeSession(dir, 0, [
				assistant("2026-05-20T00:00:01.100Z", [
					{ type: "thinking", thinking: "checking" },
					{ type: "tool_use", id: "tool-1", name: "read", input: { path: "/abs/a.ts" } },
				]),
				user("2026-05-20T00:00:01.350Z", [
					{ type: "tool_result", tool_use_id: "tool-1", content: "ok" },
				]),
				assistant("2026-05-20T00:00:02.000Z", [
					{ type: "text", text: "Done." },
				]),
			]);

			assert.deepEqual(readRunTranscript(dir), [
				{ kind: "step-start", stepIndex: 0, agent: "fixer", ts: 1000, label: "check files" },
				{ kind: "tool", stepIndex: 0, toolName: "read", argsPreview: '{"path":"/abs/a.ts"}', rawArgs: { path: "/abs/a.ts" }, durationMs: 250, ts: Date.parse("2026-05-20T00:00:01.100Z") },
				{ kind: "step-end", stepIndex: 0, agent: "fixer", ts: 2200, durationMs: 1200, tokens: 3, status: "complete" },
				{ kind: "final-text", stepIndex: 0, agent: "fixer", text: "Done." },
			]);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reads multiple run-N transcripts using N as stepIndex", () => {
		const dir = makeRunDir();
		try {
			writeStatus(dir, {
				mode: "parallel",
				steps: [
					{ agent: "fixer", status: "complete", startedAt: 1000, endedAt: 2000 },
					{ agent: "review", status: "failed", startedAt: 1100, endedAt: 2100 },
				],
			});
			writeSession(dir, 0, [assistant("2026-05-20T00:00:01.000Z", [{ type: "tool_use", id: "a", name: "read", input: { path: "a" } }])]);
			writeSession(dir, 1, [assistant("2026-05-20T00:00:01.100Z", [{ type: "tool_use", id: "b", name: "bash", input: { command: "npm test" } }])]);

			const lines = readRunTranscript(dir);
			assert.deepEqual(lines.filter((line) => line.kind === "tool").map((line) => [line.stepIndex, line.toolName]), [[0, "read"], [1, "bash"]]);
			assert.deepEqual(lines.filter((line) => line.kind === "step-start").map((line) => [line.stepIndex, line.agent]), [[0, "fixer"], [1, "review"]]);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("captures the first user-role text content as the step task (initial prompt)", () => {
		const dir = makeRunDir();
		try {
			writeStatus(dir);
			writeSession(dir, 0, [
				user("2026-05-20T00:00:00.500Z", [{ type: "text", text: "Read package.json and respond OK." }]),
				assistant("2026-05-20T00:00:01.000Z", [{ type: "text", text: "OK" }]),
			]);
			const lines = readRunTranscript(dir);
			const start = lines.find((line) => line.kind === "step-start");
			assert.ok(start && start.kind === "step-start");
			assert.equal(start.task, "Read package.json and respond OK.");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("only captures the FIRST user prompt, not later follow-ups", () => {
		const dir = makeRunDir();
		try {
			writeStatus(dir);
			writeSession(dir, 0, [
				user("2026-05-20T00:00:00.500Z", [{ type: "text", text: "first prompt" }]),
				assistant("2026-05-20T00:00:01.000Z", [{ type: "text", text: "ack" }]),
				user("2026-05-20T00:00:01.500Z", [{ type: "text", text: "follow up" }]),
			]);
			const start = readRunTranscript(dir).find((line) => line.kind === "step-start");
			assert.ok(start && start.kind === "step-start");
			assert.equal(start.task, "first prompt");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("returns the cached array while transcript and status stats are unchanged", () => {
		const dir = makeRunDir();
		try {
			writeStatus(dir);
			writeSession(dir, 0, [assistant("2026-05-20T00:00:01.000Z", [{ type: "tool_use", id: "a", name: "read", input: { path: "a" } }])]);
			const first = readRunTranscript(dir);
			const second = readRunTranscript(dir);
			assert.equal(first, second);
			writeSession(dir, 0, [assistant("2026-05-20T00:00:01.000Z", [{ type: "tool_use", id: "a", name: "read", input: { path: "a" } }, { type: "tool_use", id: "b", name: "bash", input: { command: "echo hi" } }])]);
			const third = readRunTranscript(dir);
			assert.notEqual(first, third);
			assert.equal(third.filter((line) => line.kind === "tool").length, 2);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
