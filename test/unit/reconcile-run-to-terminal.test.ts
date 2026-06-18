import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { reconcileRunToTerminalOnDisk, writeStatusJson } from "../../src/state/status-writer.ts";
import type { PersistedRunStatus } from "../../src/protocol/status-types.ts";
import { createTempDir, removeTempDir } from "../support/helpers.ts";

function statusPath(dir: string): string {
	return path.join(dir, "status.json");
}

function readRaw(dir: string): string {
	return fs.readFileSync(statusPath(dir), "utf-8");
}

/**
 * A fully-populated running status seeded through the same atomic writer the
 * reconcile uses, so it parses cleanly through parsePersistedRunStatus. Carries
 * every "rich" field (outputText/error/totalUsage/totalTokens/steps/sessionFile/
 * parentRunId/resumeCount) the reconcile must preserve rather than rebuild.
 */
function seedRunningStatus(dir: string): PersistedRunStatus {
	const status: PersistedRunStatus = {
		version: 1,
		runId: "run-reconcile",
		mode: "single",
		state: "running",
		startedAt: 1000,
		lastUpdate: 2000,
		runnerHeartbeatAt: 2000,
		phase: "streaming_text",
		phaseStartedAt: 1500,
		currentTool: "read",
		currentToolStartedAt: 1600,
		activityState: "needs_attention",
		parentRunId: "parent-run-1",
		resumeCount: 2,
		sessionFile: "/tmp/session.jsonl",
		outputText: "partial work in progress",
		error: "a prior transient error",
		totalTokens: { input: 100, output: 50, total: 150 },
		totalUsage: { input: 100, output: 50, cost: 0.01, turns: 3 },
		steps: [{ agent: "fixer", status: "running", startedAt: 1100 }],
	};
	writeStatusJson(statusPath(dir), status);
	return status;
}

describe("reconcileRunToTerminalOnDisk", () => {
	it("returns null and writes nothing when status.json is absent", () => {
		const dir = createTempDir("pi-reconcile-absent-");
		try {
			const result = reconcileRunToTerminalOnDisk(dir, "lost");
			assert.equal(result, null);
			assert.equal(fs.existsSync(statusPath(dir)), false);
		} finally {
			removeTempDir(dir);
		}
	});

	it("returns null and leaves malformed bytes untouched when the codec rejects the file", () => {
		const dir = createTempDir("pi-reconcile-malformed-");
		try {
			const garbage = '{ "runId": "x", not valid json';
			fs.writeFileSync(statusPath(dir), garbage, "utf-8");

			const result = reconcileRunToTerminalOnDisk(dir, "lost");
			assert.equal(result, null);
			assert.equal(readRaw(dir), garbage);
		} finally {
			removeTempDir(dir);
		}
	});

	it("returns a non-running status unchanged without writing", () => {
		const dir = createTempDir("pi-reconcile-terminal-");
		try {
			const status: PersistedRunStatus = {
				version: 1,
				runId: "run-complete",
				mode: "single",
				state: "complete",
				startedAt: 1000,
				endedAt: 3000,
				outputText: "done",
				steps: [{ agent: "fixer", status: "complete" }],
			};
			writeStatusJson(statusPath(dir), status);
			const before = readRaw(dir);
			const beforeMtime = fs.statSync(statusPath(dir)).mtimeMs;

			const result = reconcileRunToTerminalOnDisk(dir, "lost");
			assert.equal(result?.state, "complete");
			// No write: bytes and mtime are byte-identical.
			assert.equal(readRaw(dir), before);
			assert.equal(fs.statSync(statusPath(dir)).mtimeMs, beforeMtime);
		} finally {
			removeTempDir(dir);
		}
	});

	it("stamps terminal scalars, preserves all rich fields, and writes when state is running", () => {
		const dir = createTempDir("pi-reconcile-running-");
		try {
			const seed = seedRunningStatus(dir);
			const before = readRaw(dir);
			const now = 9999;

			const result = reconcileRunToTerminalOnDisk(dir, "lost", now);
			assert.ok(result, "expected a reconciled status");
			// A write happened (bytes changed).
			assert.notEqual(readRaw(dir), before);

			const onDisk = JSON.parse(readRaw(dir)) as PersistedRunStatus;
			for (const status of [result!, onDisk]) {
				// Terminal scalars stamped.
				assert.equal(status.state, "lost");
				assert.equal(status.endedAt, now);
				assert.equal(status.lastUpdate, now);
				assert.equal(status.runnerHeartbeatAt, now);
				assert.equal(status.phase, "idle");
				assert.equal(status.phaseStartedAt, undefined);
				assert.equal(status.currentTool, undefined);
				assert.equal(status.currentToolStartedAt, undefined);
				assert.equal(status.activityState, undefined);
				assert.equal(status.version, 1);
				// Rich fields preserved (NOT rebuilt from a meta subset).
				assert.equal(status.outputText, seed.outputText);
				assert.equal(status.error, seed.error);
				assert.deepEqual(status.totalUsage, seed.totalUsage);
				assert.deepEqual(status.totalTokens, seed.totalTokens);
				assert.deepEqual(status.steps, seed.steps);
				assert.equal(status.sessionFile, seed.sessionFile);
				assert.equal(status.parentRunId, seed.parentRunId);
				assert.equal(status.resumeCount, seed.resumeCount);
			}
		} finally {
			removeTempDir(dir);
		}
	});

	it("is idempotent: a second call on the now-lost record returns it unchanged with no further write", () => {
		const dir = createTempDir("pi-reconcile-idempotent-");
		try {
			seedRunningStatus(dir);
			reconcileRunToTerminalOnDisk(dir, "lost", 9999);
			const afterFirst = readRaw(dir);
			const mtimeAfterFirst = fs.statSync(statusPath(dir)).mtimeMs;

			const second = reconcileRunToTerminalOnDisk(dir, "lost", 12345);
			assert.equal(second?.state, "lost");
			// No further write: the record is no longer 'running'.
			assert.equal(readRaw(dir), afterFirst);
			assert.equal(fs.statSync(statusPath(dir)).mtimeMs, mtimeAfterFirst);
		} finally {
			removeTempDir(dir);
		}
	});
});
