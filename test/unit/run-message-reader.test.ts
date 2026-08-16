import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { RunMessageReader } from "../../src/state/run-transcript.ts";

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
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
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
