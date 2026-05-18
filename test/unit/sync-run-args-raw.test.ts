import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { appendSyncRunTool, ensureSyncRunDir } from "../../sync-run-persistence.ts";

describe("sync run raw tool args", () => {
	it("writes raw args without a preview wrapper", () => {
		const runId = `sync-raw-${process.pid}-${Date.now()}`;
		const dir = ensureSyncRunDir(runId);
		try {
			appendSyncRunTool(runId, 0, "read", { path: "/abs/foo.ts" }, 100);
			const raw = fs.readFileSync(path.join(dir, "events.jsonl"), "utf-8");
			assert.doesNotMatch(raw, /preview/);
			const event = JSON.parse(raw.trim()) as { args?: unknown };
			assert.deepEqual(event.args, { path: "/abs/foo.ts" });
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
