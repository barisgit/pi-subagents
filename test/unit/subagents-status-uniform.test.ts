import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { type AsyncRunSummary } from "../../async-status.ts";
import { buildRightLines, type ForegroundRunSummary } from "../../subagents-status.ts";
import { appendSyncRunStepStart, appendSyncRunTool, ensureSyncRunDir } from "../../sync-run-persistence.ts";

const theme = { fg: (_name: string, text: string) => text, bg: (_name: string, text: string) => text } as never;

function asyncRun(id: string, asyncDir: string): AsyncRunSummary {
	return {
		id,
		asyncDir,
		state: "running",
		mode: "single",
		startedAt: 1,
		steps: [{ index: 0, agent: "fixer", status: "running" }],
	};
}

function syncRun(id: string): ForegroundRunSummary {
	return { id, state: "running", mode: "single", startedAt: 1 };
}

describe("subagents-status uniform args rendering", () => {
	it("renders matched async and sync tool args identically", () => {
		const asyncDir = fs.mkdtempSync(path.join(os.tmpdir(), "status-uniform-"));
		const syncId = `status-uniform-${process.pid}-${Date.now()}`;
		const syncDir = ensureSyncRunDir(syncId);
		try {
			const asyncEvents = [
				{ type: "subagent.step.started", stepIndex: 0, agent: "fixer", ts: 100 },
				{ type: "tool_execution_start", subagentStepIndex: 0, toolName: "read", toolCallId: "r", args: { path: "/abs/a.ts" }, observedAt: 110 },
				{ type: "tool_execution_start", subagentStepIndex: 0, toolName: "bash", toolCallId: "b", args: { command: "echo hi" }, observedAt: 120 },
			];
			fs.writeFileSync(path.join(asyncDir, "events.jsonl"), asyncEvents.map((e) => JSON.stringify(e)).join("\n") + "\n");

			appendSyncRunStepStart(syncId, 0, "fixer", 100);
			appendSyncRunTool(syncId, 0, "read", { path: "/abs/a.ts" }, 110);
			appendSyncRunTool(syncId, 0, "bash", { command: "echo hi" }, 120);

			const asyncLines = buildRightLines(theme, { source: "async", run: asyncRun("async-a", asyncDir) }, 120);
			const syncLines = buildRightLines(theme, { source: "sync", run: syncRun(syncId) }, 120);
			assert.deepEqual(syncLines, asyncLines);
			assert.ok(!syncLines.concat(asyncLines).some((line) => line.includes("preview")));
		} finally {
			fs.rmSync(asyncDir, { recursive: true, force: true });
			fs.rmSync(syncDir, { recursive: true, force: true });
		}
	});
});
