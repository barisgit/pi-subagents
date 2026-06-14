import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { type AsyncRunSummary } from "../../src/state/async-status.ts";
import { buildRightLines } from "../../src/surfaces/dashboard-detail-renderer.ts";
import { type ForegroundRunSummary } from "../../src/surfaces/subagents-status.ts";
import type { PersistedRunStatus } from "../../src/protocol/status-types.ts";

const theme = { fg: (_name: string, text: string) => text, bg: (_name: string, text: string) => text } as never;

function asyncRun(id: string, asyncDir: string): AsyncRunSummary {
	return {
		id,
		asyncDir,
		state: "running",
		mode: "single",
		startedAt: 100,
		steps: [{ index: 0, agent: "fixer", status: "running" }],
	};
}

function syncRun(id: string, asyncDir: string): ForegroundRunSummary {
	return { id, asyncDir, state: "running", mode: "single", startedAt: 100 };
}

function writeRunRecord(dir: string, id: string): void {
	const status: PersistedRunStatus = {
		runId: id,
		mode: "single",
		state: "running",
		startedAt: 100,
		lastUpdate: 120,
		steps: [{ agent: "fixer", status: "running", startedAt: 100 }],
	};
	fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify(status), "utf-8");
	const runDir = path.join(dir, "run-0");
	fs.mkdirSync(runDir, { recursive: true });
	const records = [
		{ type: "session", version: 3, id: `${id}-session`, timestamp: "2026-05-20T00:00:00.000Z", cwd: dir },
		{ type: "message", timestamp: "2026-05-20T00:00:00.110Z", message: { role: "assistant", content: [{ type: "tool_use", id: `${id}-read`, name: "read", input: { path: "/abs/a.ts" } }] } },
		{ type: "message", timestamp: "2026-05-20T00:00:00.120Z", message: { role: "assistant", content: [{ type: "tool_use", id: `${id}-bash`, name: "bash", input: { command: "echo hi" } }] } },
	];
	fs.writeFileSync(path.join(runDir, "session.jsonl"), records.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf-8");
}

describe("subagents-status uniform args rendering", () => {
	it("renders matched async and sync tool args identically", () => {
		const asyncDir = fs.mkdtempSync(path.join(os.tmpdir(), "status-uniform-async-"));
		const syncDir = fs.mkdtempSync(path.join(os.tmpdir(), "status-uniform-sync-"));
		try {
			writeRunRecord(asyncDir, "async-a");
			writeRunRecord(syncDir, "sync-a");

			const asyncLines = buildRightLines(theme, { source: "async", run: asyncRun("async-a", asyncDir) }, 120);
			const syncLines = buildRightLines(theme, { source: "sync", run: syncRun("sync-a", syncDir) }, 120);
			assert.deepEqual(syncLines, asyncLines);
			assert.ok(!syncLines.concat(asyncLines).some((line) => line.includes("preview")));
		} finally {
			fs.rmSync(asyncDir, { recursive: true, force: true });
			fs.rmSync(syncDir, { recursive: true, force: true });
		}
	});
});
