import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { RunMessageReader } from "../../src/state/run-transcript.ts";
import { buildRunTranscriptPreview, runTranscriptPreviewPath } from "../../src/state/run-transcript-preview.ts";

function writeCanonicalSession(filePath: string, texts: string[]): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const records: Record<string, unknown>[] = [
		{ type: "session", version: 3, id: "session-1", timestamp: "2026-05-20T00:00:00.000Z", cwd: "/project" },
	];
	let parentId: string | null = null;
	for (const [index, text] of texts.entries()) {
		const id = `message-${index}`;
		records.push({
			type: "message",
			id,
			parentId,
			timestamp: `2026-05-20T00:00:0${index + 1}.000Z`,
			message: { role: "user", content: [{ type: "text", text }], timestamp: index + 1 },
		});
		parentId = id;
	}
	fs.writeFileSync(filePath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

describe("RunMessageReader", () => {
	it("loads ordered raw branch messages and reuses the stat-keyed result", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "run-messages-"));
		try {
			writeCanonicalSession(path.join(dir, "run-1", "session.jsonl"), ["second"]);
			writeCanonicalSession(path.join(dir, "run-0", "session.jsonl"), ["first"]);
			const reader = new RunMessageReader();
			const first = reader.read(dir);
			const repaint = reader.read(dir);
			assert.equal(repaint, first);
			assert.deepEqual(
				first.map((session) => [session.stepIndex, session.messages[0]?.role]),
				[
					[0, "user"],
					[1, "user"],
				],
			);
			assert.equal((first[0]?.messages[0] as { content?: Array<{ text?: string }> }).content?.[0]?.text, "first");
			assert.match(
				JSON.stringify(reader.readPreview(dir)),
				/first/,
				"the first full read backfills previews for legacy runs",
			);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("loads only validated per-step preview sidecars for the bounded initial tier", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "run-message-previews-"));
		try {
			const first = path.join(dir, "run-0", "session.jsonl");
			const second = path.join(dir, "run-1", "session.jsonl");
			writeCanonicalSession(first, ["full first"]);
			writeCanonicalSession(second, ["full second"]);
			fs.writeFileSync(
				runTranscriptPreviewPath(first),
				JSON.stringify(
					buildRunTranscriptPreview(0, [{ role: "user", content: "preview first", timestamp: 1 }]),
				),
			);
			fs.writeFileSync(runTranscriptPreviewPath(second), "invalid");

			const previews = new RunMessageReader().readPreview(dir);

			assert.equal(previews.length, 1);
			assert.equal(previews[0]?.stepIndex, 0);
			assert.equal((previews[0]?.messages[0] as { content?: string }).content, "preview first");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("evicts full transcripts by LRU recency and source bytes while retaining one oversized current entry", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "run-message-lru-"));
		try {
			const dirs = ["a", "b", "c"].map((name) => path.join(root, name));
			for (const dir of dirs) writeCanonicalSession(path.join(dir, "run-0", "session.jsonl"), ["x".repeat(800)]);
			const sourceSize = fs.statSync(path.join(dirs[0]!, "run-0", "session.jsonl")).size;
			const reader = new RunMessageReader({ maxEntries: 2, maxSourceBytes: sourceSize * 3 });
			const a = reader.read(dirs[0]!);
			const b = reader.read(dirs[1]!);
			assert.equal(reader.read(dirs[0]!), a, "a cache hit refreshes LRU recency");
			reader.read(dirs[2]!);
			assert.notEqual(reader.read(dirs[1]!), b, "entry pressure evicts the older destination");

			const byteReader = new RunMessageReader({ maxEntries: 10, maxSourceBytes: sourceSize * 2 + 1 });
			const byteA = byteReader.read(dirs[0]!);
			byteReader.read(dirs[1]!);
			byteReader.read(dirs[2]!);
			assert.notEqual(byteReader.read(dirs[0]!), byteA, "source-byte pressure evicts old destinations");

			const freshReader = new RunMessageReader();
			freshReader.read(dirs[0]!);
			fs.appendFileSync(path.join(dirs[0]!, "run-0", "session.jsonl"), "\n");
			assert.equal(freshReader.peek(dirs[0]!), undefined, "peek rejects a stale cached destination");

			const oversized = new RunMessageReader({ maxEntries: 1, maxSourceBytes: 10 });
			const first = oversized.read(dirs[0]!);
			assert.equal(oversized.read(dirs[0]!), first, "the sole oversized current entry remains cached");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("invalidates while a session grows and tolerates malformed, missing, or unopenable files", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "run-messages-grow-"));
		try {
			const filePath = path.join(dir, "run-0", "session.jsonl");
			writeCanonicalSession(filePath, ["first"]);
			const reader = new RunMessageReader();
			const first = reader.read(dir);
			writeCanonicalSession(filePath, ["first", "second"]);
			const grown = reader.read(dir);
			assert.notEqual(grown, first);
			assert.equal(grown[0]?.messages.length, 2);
			fs.writeFileSync(filePath, "not json\n");
			assert.deepEqual(reader.read(dir), []);
			fs.rmSync(filePath);
			assert.deepEqual(reader.read(dir), []);
			fs.mkdirSync(filePath);
			assert.deepEqual(reader.read(dir), []);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
