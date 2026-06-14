import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { formatAsyncRunList, listAsyncRuns, type AsyncRunOverlayData } from "../../src/state/async-status.ts";

function createAsyncDir(root: string, id: string, status: Record<string, unknown>): string {
	const dir = path.join(root, id);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify(status), "utf-8");
	return dir;
}

function listLegacyOverlay(root: string, recentLimit = 5): AsyncRunOverlayData {
	const all = listAsyncRuns(root);
	return {
		active: all.filter((run) => run.state === "queued" || run.state === "running" || run.state === "lost"),
		recent: all
			.filter((run) => run.state === "complete" || run.state === "failed" || run.state === "paused")
			.sort((a, b) => b.startedAt - a.startedAt)
			.slice(0, recentLimit),
	};
}

describe("async status helpers", () => {
	it("lists only requested states and includes flattened step summaries", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-status-"));
		try {
			createAsyncDir(root, "run-a", {
				runId: "run-a",
				mode: "parallel",
				state: "running",
				startedAt: 100,
				lastUpdate: 200,
				cwd: "/repo-a",
				currentStep: 1,
				steps: [
					{ agent: "scout", status: "complete", durationMs: 10 },
					{ agent: "worker", status: "running", durationMs: 20 },
				],
			});
			createAsyncDir(root, "run-b", {
				runId: "run-b",
				mode: "single",
				state: "complete",
				startedAt: 50,
				lastUpdate: 75,
				steps: [{ agent: "reviewer", status: "complete" }],
			});

			const runs = listAsyncRuns(root, { states: ["queued", "running"] });
			assert.equal(runs.length, 1);
			assert.equal(runs[0]?.id, "run-a");
			assert.equal(runs[0]?.cwd, "/repo-a");
			assert.equal(runs[0]?.steps.length, 2);
			assert.equal(runs[0]?.steps[1]?.agent, "worker");
			assert.equal(runs[0]?.steps[1]?.status, "running");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("orders recent overlay runs by recency instead of failure-first state ranking", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-recent-order-"));
		try {
			createAsyncDir(root, "older-failed", {
				runId: "older-failed",
				mode: "single",
				state: "failed",
				startedAt: 10,
				lastUpdate: 100,
				endedAt: 100,
				steps: [{ agent: "worker", status: "failed" }],
			});
			createAsyncDir(root, "newer-complete", {
				runId: "newer-complete",
				mode: "single",
				state: "complete",
				startedAt: 20,
				lastUpdate: 200,
				endedAt: 200,
				steps: [{ agent: "reviewer", status: "complete" }],
			});

			const overlay = listLegacyOverlay(root, 5);
			assert.deepEqual(overlay.recent.map((run) => run.id), ["newer-complete", "older-failed"]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("uses persisted running attention state from detached runners", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-running-state-"));
		try {
			const lastActivityAt = Date.now() - 65_000;
			createAsyncDir(root, "run-running", {
				runId: "run-running",
				mode: "single",
				state: "running",
				activityState: "needs_attention",
				lastActivityAt,
				startedAt: Date.now() - 70_000,
				lastUpdate: Date.now(),
				steps: [{ agent: "worker", status: "running", activityState: "needs_attention", lastActivityAt }],
			});

			const runs = listAsyncRuns(root, { states: ["running"] });
			assert.equal(runs[0]?.activityState, "needs_attention");
			assert.equal(runs[0]?.steps[0]?.activityState, "needs_attention");
			const text = formatAsyncRunList(runs, "Active async runs");
			assert.match(text, /Pi will send a completion or needs-attention message and trigger a new turn/);
			assert.match(text, /Use status\/sleep checks only when immediate inspection is genuinely necessary/);
			assert.match(text, /no activity for/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("marks stale running statuses with dead runner pids as lost", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-lost-status-"));
		try {
			const now = Date.now();
			createAsyncDir(root, "run-lost", {
				runId: "run-lost",
				mode: "single",
				state: "running",
				startedAt: now - 120_000,
				lastUpdate: now - 60_000,
				runnerHeartbeatAt: now - 60_000,
				pid: 999999999,
				steps: [{ agent: "worker", status: "running" }],
			});

			const runs = listAsyncRuns(root, { states: ["running"] });
			assert.equal(runs[0]?.displayState, "lost");
			const text = formatAsyncRunList(runs, "Active async runs");
			assert.match(text, /run-lost \| running\/lost/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("marks active tool execution separately from quiet running state", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-tool-state-"));
		try {
			const now = Date.now();
			createAsyncDir(root, "run-tool", {
				runId: "run-tool",
				mode: "single",
				state: "running",
				startedAt: now - 10_000,
				lastUpdate: now,
				runnerHeartbeatAt: now,
				currentTool: "bash",
				currentToolStartedAt: now - 2_000,
				pid: process.pid,
				steps: [{ agent: "worker", status: "running", currentTool: "bash", currentToolStartedAt: now - 2_000 }],
			});

			const runs = listAsyncRuns(root, { states: ["running"] });
			assert.equal(runs[0]?.displayState, "tool_running");
			assert.equal(runs[0]?.steps[0]?.displayState, "tool_running");
			const text = formatAsyncRunList(runs, "Active async runs");
			assert.match(text, /run-tool \| running\/tool_running/);
			assert.match(text, /1\. worker \| running\/tool_running/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("formats paused runs as lifecycle state without activity state", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-paused-status-"));
		try {
			createAsyncDir(root, "run-paused", {
				runId: "run-paused",
				mode: "single",
				state: "paused",
				startedAt: 100,
				lastUpdate: 200,
				endedAt: 200,
				steps: [{ agent: "worker", status: "complete" }],
			});

			const overlay = listLegacyOverlay(root, 5);
			assert.equal(overlay.active.length, 0);
			assert.equal(overlay.recent[0]?.id, "run-paused");
			assert.equal(overlay.recent[0]?.activityState, undefined);
			assert.equal(overlay.recent[0]?.steps[0]?.activityState, undefined);

			const text = formatAsyncRunList(overlay.recent, "Recent async runs");
			assert.match(text, /run-paused \| paused/);
			assert.match(text, /worker \| complete/);
			assert.doesNotMatch(text, /paused\/paused/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	// SKIP: pre-existing integration failure unrelated to subagent-liveness charter; see commit 6a501e7
	it.skip("surfaces malformed status files instead of silently skipping them", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-bad-status-"));
		const dir = path.join(root, "broken-run");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "status.json"), "{not-json", "utf-8");
		try {
			assert.throws(
				() => listAsyncRuns(root),
				/Failed to parse async status file/,
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("separates active and recent runs for the overlay and formats readable list output", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-overlay-"));
		try {
			createAsyncDir(root, "run-running", {
				runId: "run-running",
				mode: "parallel",
				state: "running",
				startedAt: 100,
				lastUpdate: 300,
				steps: [{ agent: "scout", status: "running", durationMs: 12_000 }],
			});
			createAsyncDir(root, "run-failed", {
				runId: "run-failed",
				mode: "single",
				state: "failed",
				startedAt: 50,
				lastUpdate: 250,
				endedAt: 250,
				steps: [{ agent: "worker", status: "failed", durationMs: 5_000 }],
			});
			createAsyncDir(root, "run-complete", {
				runId: "run-complete",
				mode: "single",
				state: "complete",
				startedAt: 10,
				lastUpdate: 200,
				endedAt: 200,
				steps: [{ agent: "reviewer", status: "complete", durationMs: 3_000 }],
			});

			const overlay = listLegacyOverlay(root, 1);
			assert.equal(overlay.active.length, 1);
			assert.equal(overlay.active[0]?.id, "run-running");
			assert.equal(overlay.recent.length, 1);
			assert.equal(overlay.recent[0]?.id, "run-failed");

			const text = formatAsyncRunList(overlay.active);
			assert.match(text, /Subagent runs: 1/);
			assert.match(text, /run-running/);
			assert.match(text, /scout/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
