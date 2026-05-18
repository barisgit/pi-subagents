import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { RESULTS_DIR } from "../../types.ts";
import { readStatus } from "../../utils.ts";

function createAsyncDir(status: Record<string, unknown>): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-read-status-reconcile-"));
	fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({
		mode: "single",
		startedAt: Date.now(),
		...status,
	}), "utf-8");
	return dir;
}

function removeAsyncDir(dir: string): void {
	fs.rmSync(dir, { recursive: true, force: true });
}

function resultPath(runId: string): string {
	return path.join(RESULTS_DIR, `${runId}.json`);
}

describe("readStatus liveness reconciliation", () => {
	it("marks running statuses with dead pids as lost without mutating disk", () => {
		const dir = createAsyncDir({
			runId: "read-status-dead-pid",
			state: "running",
			pid: 999999999,
		});
		try {
			const status = readStatus(dir);
			assert.equal(status?.state, "lost");

			const raw = JSON.parse(fs.readFileSync(path.join(dir, "status.json"), "utf-8"));
			assert.equal(raw.state, "running");
		} finally {
			removeAsyncDir(dir);
		}
	});

	it("marks pid-less stale running statuses as lost when no result file exists", () => {
		const runId = "read-status-stale-no-result";
		fs.rmSync(resultPath(runId), { force: true });
		const dir = createAsyncDir({ runId, state: "running" });
		try {
			const stale = new Date(Date.now() - 15 * 60 * 1000);
			fs.utimesSync(path.join(dir, "status.json"), stale, stale);

			const status = readStatus(dir);
			assert.equal(status?.state, "lost");
		} finally {
			removeAsyncDir(dir);
		}
	});

	it("preserves pid-less fresh running statuses", () => {
		const runId = "read-status-fresh-no-result";
		fs.rmSync(resultPath(runId), { force: true });
		const dir = createAsyncDir({ runId, state: "running" });
		try {
			const fresh = new Date(Date.now() - 30 * 1000);
			fs.utimesSync(path.join(dir, "status.json"), fresh, fresh);

			const status = readStatus(dir);
			assert.equal(status?.state, "running");
		} finally {
			removeAsyncDir(dir);
		}
	});

	it("preserves running statuses with live pids", () => {
		const dir = createAsyncDir({
			runId: "read-status-live-pid",
			state: "running",
			pid: process.pid,
		});
		try {
			const status = readStatus(dir);
			assert.equal(status?.state, "running");
			assert.equal(status?.pid, process.pid);
		} finally {
			removeAsyncDir(dir);
		}
	});

	it("preserves terminal statuses regardless of pid liveness", () => {
		const dir = createAsyncDir({
			runId: "read-status-terminal",
			state: "failed",
			pid: 999999999,
		});
		try {
			const status = readStatus(dir);
			assert.equal(status?.state, "failed");
		} finally {
			removeAsyncDir(dir);
		}
	});

	it("preserves pid-less stale running statuses when a result file exists", () => {
		const runId = "read-status-stale-with-result";
		const result = resultPath(runId);
		const dir = createAsyncDir({ runId, state: "running" });
		try {
			fs.mkdirSync(RESULTS_DIR, { recursive: true });
			fs.writeFileSync(result, JSON.stringify({ id: runId, success: true }), "utf-8");
			const stale = new Date(Date.now() - 15 * 60 * 1000);
			fs.utimesSync(path.join(dir, "status.json"), stale, stale);

			const status = readStatus(dir);
			assert.equal(status?.state, "running");
		} finally {
			fs.rmSync(result, { force: true });
			removeAsyncDir(dir);
		}
	});
});
