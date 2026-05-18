import assert from "node:assert/strict";
import * as fs from "node:fs";
import { describe, it } from "node:test";
import { readEventLog } from "../../events-log.ts";
import { appendSyncRunFinalText, appendSyncRunStepEnd, appendSyncRunStepStart, appendSyncRunTool, ensureSyncRunDir } from "../../sync-run-persistence.ts";

describe("sync run event writers", () => {
	it("writes event lines parsed by readEventLog", () => {
		const runId = `sync-events-${process.pid}-${Date.now()}`;
		const dir = ensureSyncRunDir(runId);
		try {
			appendSyncRunStepStart(runId, 0, "fixer", 100, "do task", "label");
			appendSyncRunTool(runId, 0, "bash", { command: "echo hi" }, 110, 25);
			appendSyncRunFinalText(runId, 0, "fixer", "done");
			appendSyncRunStepEnd(runId, 0, "fixer", 150, "completed", { input: 1, output: 2, total: 3 }, 50);

			const lines = readEventLog(dir);
			assert.deepEqual(lines.map((line) => line.kind), ["step-start", "tool", "step-end", "final-text"]);
			assert.equal(lines[0]?.kind === "step-start" && lines[0].task, "do task");
			assert.equal(lines[1]?.kind === "tool" && lines[1].durationMs, 25);
			assert.equal(lines[2]?.kind === "step-end" && lines[2].tokens, 3);
			assert.equal(lines[3]?.kind === "final-text" && lines[3].text, "done");

			fs.appendFileSync(`${dir}/events.jsonl`, "{not-json");
			assert.ok(readEventLog(dir).length >= 4);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
