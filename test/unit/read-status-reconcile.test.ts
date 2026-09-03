import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { readStatus } from "../../src/shared/utils.ts";
import { currentRunnerToken } from "../../src/shared/process-global.ts";
import {
	RUNNER_STALE_GRACE_MS,
	__resetRunnerStaleGraceForTest,
	__setRunnerStaleGraceNowForTest,
} from "../../src/shared/runner-stale-grace.ts";

function createRunDir(status: Record<string, unknown>): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-read-status-reconcile-"));
	fs.writeFileSync(
		path.join(dir, "status.json"),
		JSON.stringify({
			mode: "single",
			startedAt: Date.now(),
			...status,
		}),
		"utf-8",
	);
	return dir;
}

describe("readStatus liveness reconciliation", () => {
	it("marks stale running statuses as lost without mutating disk", () => {
		const dir = createRunDir({ runId: "read-status-stale", state: "running" });
		try {
			const stale = new Date(Date.now() - 15 * 60 * 1000);
			fs.utimesSync(path.join(dir, "status.json"), stale, stale);

			const status = readStatus(dir);
			assert.equal(status?.state, "lost");
			const raw = JSON.parse(fs.readFileSync(path.join(dir, "status.json"), "utf-8"));
			assert.equal(raw.state, "running");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reaps a stale current-process status when its heartbeat does not refresh during grace", () => {
		__resetRunnerStaleGraceForTest();
		let now = Date.now();
		const restoreNow = __setRunnerStaleGraceNowForTest(() => now);
		const dir = createRunDir({
			runId: "read-status-current-runner",
			state: "running",
			runnerPid: process.pid,
			runnerToken: currentRunnerToken(),
		});
		try {
			const stale = new Date(Date.now() - 15 * 60 * 1000);
			fs.utimesSync(path.join(dir, "status.json"), stale, stale);

			const status = readStatus(dir);
			assert.equal(status?.state, "running");
			now += RUNNER_STALE_GRACE_MS + 1;
			assert.equal(readStatus(dir)?.state, "lost");
		} finally {
			restoreNow();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps a stale current-process status live when its heartbeat refreshes after wake", () => {
		__resetRunnerStaleGraceForTest();
		let now = Date.now();
		const restoreNow = __setRunnerStaleGraceNowForTest(() => now);
		const dir = createRunDir({
			runId: "read-status-wake-refresh",
			state: "running",
			runnerPid: process.pid,
			runnerToken: currentRunnerToken(),
			runnerHeartbeatAt: now - 15 * 60 * 1000,
		});
		try {
			const statusPath = path.join(dir, "status.json");
			const stale = new Date(now - 15 * 60 * 1000);
			fs.utimesSync(statusPath, stale, stale);
			assert.equal(readStatus(dir)?.state, "running");

			now += RUNNER_STALE_GRACE_MS + 1;
			const raw = JSON.parse(fs.readFileSync(statusPath, "utf-8"));
			raw.runnerHeartbeatAt = now;
			fs.writeFileSync(statusPath, JSON.stringify(raw), "utf-8");
			assert.equal(readStatus(dir)?.state, "running");
		} finally {
			restoreNow();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("preserves fresh running statuses", () => {
		const dir = createRunDir({ runId: "read-status-fresh", state: "running" });
		try {
			const fresh = new Date(Date.now() - 30 * 1000);
			fs.utimesSync(path.join(dir, "status.json"), fresh, fresh);

			const status = readStatus(dir);
			assert.equal(status?.state, "running");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("preserves terminal statuses", () => {
		const dir = createRunDir({ runId: "read-status-terminal", state: "failed" });
		try {
			const status = readStatus(dir);
			assert.equal(status?.state, "failed");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps a queued waiter owned by the current process recoverable", () => {
		__resetRunnerStaleGraceForTest();
		let now = Date.now();
		const restoreNow = __setRunnerStaleGraceNowForTest(() => now);
		const dir = createRunDir({
			runId: "read-status-current-queued",
			state: "queued",
			runnerPid: process.pid,
			runnerToken: currentRunnerToken(),
		});
		try {
			const stale = new Date(now - 15 * 60 * 1000);
			fs.utimesSync(path.join(dir, "status.json"), stale, stale);

			assert.equal(readStatus(dir)?.state, "queued");
			now += RUNNER_STALE_GRACE_MS + 1;
			assert.equal(readStatus(dir)?.state, "queued");
		} finally {
			restoreNow();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("marks stale queued orphans as lost without mutating disk", () => {
		// A child blocked on a leaf permit when its owning activation died stays queued
		// forever. A queued record untouched past the ceiling has a dead owner.
		const dir = createRunDir({ runId: "read-status-queued-orphan", state: "queued" });
		try {
			const stale = new Date(Date.now() - 15 * 60 * 1000);
			fs.utimesSync(path.join(dir, "status.json"), stale, stale);

			const status = readStatus(dir);
			assert.equal(status?.state, "lost");
			const raw = JSON.parse(fs.readFileSync(path.join(dir, "status.json"), "utf-8"));
			assert.equal(raw.state, "queued");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("preserves fresh queued statuses (a live run still waiting for a permit)", () => {
		const dir = createRunDir({ runId: "read-status-queued-fresh", state: "queued" });
		try {
			const fresh = new Date(Date.now() - 30 * 1000);
			fs.utimesSync(path.join(dir, "status.json"), fresh, fresh);

			const status = readStatus(dir);
			assert.equal(status?.state, "queued");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
