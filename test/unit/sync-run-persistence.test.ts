import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { ensureSyncRunDir, writeSyncRunStatusEnd, writeSyncRunStatusStart, writeSyncRunStatusUpdate } from "../../sync-run-persistence.ts";

function readStatus(runId: string) {
	return JSON.parse(fs.readFileSync(path.join(ensureSyncRunDir(runId), "status.json"), "utf-8"));
}

describe("sync run persistence", () => {
	it("writes start, update, and terminal status", () => {
		const runId = `sync-persist-${process.pid}-${Date.now()}`;
		const dir = ensureSyncRunDir(runId);
		try {
			writeSyncRunStatusStart(runId, {
				mode: "single",
				startedAt: 100,
				cwd: "/repo",
				label: "demo",
				parentRunId: "parent-a",
				steps: [{ agent: "fixer", label: "step" }],
			});
			let status = readStatus(runId);
			assert.equal(status.state, "running");
			assert.equal(status.parentRunId, "parent-a");
			assert.equal(status.steps[0].status, "pending");

			writeSyncRunStatusUpdate(runId, { currentTool: "bash", steps: [{ status: "running", currentTool: "bash" }] }, { flush: true });
			status = readStatus(runId);
			assert.equal(status.currentTool, "bash");
			assert.equal(status.steps[0].status, "running");

			writeSyncRunStatusEnd(runId, { state: "complete", steps: [{ tokens: { input: 1, output: 2, total: 3 } }] });
			status = readStatus(runId);
			assert.equal(status.state, "complete");
			assert.equal(status.steps[0].status, "complete");
			assert.equal(status.steps[0].tokens.total, 3);
			assert.ok(fs.existsSync(path.join(dir, "status.json")));
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("defaults end state to complete", () => {
		const runId = `sync-persist-default-${process.pid}-${Date.now()}`;
		const dir = ensureSyncRunDir(runId);
		try {
			writeSyncRunStatusStart(runId, { mode: "single", steps: [{ agent: "worker" }] });
			writeSyncRunStatusEnd(runId, {});
			assert.equal(readStatus(runId).state, "complete");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
