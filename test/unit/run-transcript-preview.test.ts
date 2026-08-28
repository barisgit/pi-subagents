import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
	buildRunTranscriptPreview,
	cloneRunTranscriptPreview,
	createRunTranscriptPreviewWriter,
	parseRunTranscriptPreview,
	readRunTranscriptPreview,
	runTranscriptPreviewPath,
} from "../../src/state/run-transcript-preview.ts";

describe("run transcript preview", () => {
	it("keeps recent complete message groups in a validated hard-bounded sidecar", () => {
		const messages = Array.from({ length: 40 }, (_, index) => [
			{
				role: "assistant" as const,
				content: [
					{ type: "thinking" as const, thinking: "private".repeat(20_000) },
					{ type: "text" as const, text: `useful assistant ${index} ${"x".repeat(8_000)}` },
					{
						type: "toolCall" as const,
						id: `tool-${index}`,
						name: "read",
						arguments: { path: "/tmp/file", huge: "y".repeat(20_000) },
					},
				],
				stopReason: "toolUse" as const,
				timestamp: index,
			},
			{
				role: "toolResult" as const,
				toolCallId: `tool-${index}`,
				toolName: "read",
				content: [{ type: "text" as const, text: `useful result ${index} ${"z".repeat(20_000)}` }],
				isError: false,
				timestamp: index,
			},
		]).flat();

		const preview = buildRunTranscriptPreview(3, messages);
		const serialized = JSON.stringify(preview);
		const parsed = parseRunTranscriptPreview(serialized);

		assert.equal(parsed.ok, true);
		assert.ok(Buffer.byteLength(serialized) <= 128 * 1024);
		assert.equal(preview.version, 1);
		assert.equal(preview.stepIndex, 3);
		assert.match(serialized, /useful assistant 39/);
		assert.match(serialized, /useful result 39/);
		assert.doesNotMatch(serialized, /privateprivateprivate/);
		assert.ok(!serialized.includes("y".repeat(1_000)));
		const assistants = preview.messages.filter((message) => message.role === "assistant");
		const results = preview.messages.filter((message) => message.role === "toolResult");
		assert.equal(assistants.length, results.length, "assistant/tool result groups stay complete");
		const contiguousSuffix = buildRunTranscriptPreview(0, [
			{ role: "user", content: "oldest message must not jump the gap", timestamp: 1 },
			{
				role: "assistant",
				content: Array.from({ length: 32 }, (_, index) => ({
					type: "text",
					text: `${index} ${"m".repeat(8_000)}`,
				})),
			},
			{ role: "user", content: "newest contiguous suffix", timestamp: 3 },
		]);
		assert.match(JSON.stringify(contiguousSuffix), /newest contiguous suffix/);
		assert.doesNotMatch(JSON.stringify(contiguousSuffix), /oldest message must not jump the gap/);

		const oversizedLatest = buildRunTranscriptPreview(0, [
			{ role: "user", content: "older useful group", timestamp: 1 },
			{
				role: "assistant",
				content: Array.from({ length: 32 }, (_, index) => ({
					type: "text",
					text: `${index} ${"q".repeat(8_000)}`,
				})),
			},
		]);
		assert.equal(
			oversizedLatest.messages.length,
			0,
			"an oversized newest group must not admit older messages past a gap",
		);
		assert.equal(
			parseRunTranscriptPreview('{"version":1,"stepIndex":0,"messages":[{"role":"assistant","content":[null]}]}')
				.ok,
			false,
			"nested message payloads are validated before display",
		);
	});

	it("coalesces atomic sidecar writes, flushes on dispose, and clones a valid fork preview", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "run-preview-writer-"));
		try {
			const sourceSession = path.join(dir, "source", "session.jsonl");
			const targetSession = path.join(dir, "target", "session.jsonl");
			let messages: unknown[] = [{ role: "user", content: "first", timestamp: 1 }];
			let scheduled: (() => void) | undefined;
			let schedules = 0;
			const writer = createRunTranscriptPreviewWriter({
				sessionFile: sourceSession,
				stepIndex: 2,
				getMessages: () => messages,
				setTimeoutFn: (callback: () => void) => {
					schedules++;
					scheduled = callback;
					return 1 as never;
				},
				clearTimeoutFn: () => {
					scheduled = undefined;
				},
			});

			writer.schedule();
			messages = [{ role: "user", content: "newest", timestamp: 2 }];
			writer.schedule();
			assert.equal(schedules, 1);
			assert.equal(fs.existsSync(runTranscriptPreviewPath(sourceSession)), false);
			scheduled?.();
			assert.equal(readRunTranscriptPreview(sourceSession)?.messages[0]?.role, "user");

			messages = [{ role: "user", content: "terminal", timestamp: 3 }];
			writer.schedule();
			writer.dispose();
			const persisted = fs.readFileSync(runTranscriptPreviewPath(sourceSession), "utf8");
			assert.match(persisted, /terminal/);
			assert.equal(fs.existsSync(`${runTranscriptPreviewPath(sourceSession)}.tmp`), false);

			assert.equal(cloneRunTranscriptPreview(sourceSession, targetSession), true);
			assert.match(fs.readFileSync(runTranscriptPreviewPath(targetSession), "utf8"), /terminal/);
			fs.writeFileSync(runTranscriptPreviewPath(sourceSession), "invalid");
			assert.equal(readRunTranscriptPreview(sourceSession), undefined);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
