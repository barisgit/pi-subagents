/**
 * Integration tests for deriveRunDisplayState — f5-lost-requires-unknown-phase.
 *
 * "lost" may be returned for stale idle/legacy runs, or phase-agnostically
 * once the runner heartbeat is past the hard-dead ceiling.
 */
import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import { RUNNER_HARD_DEAD_MS, RUNNER_HEARTBEAT_STALE_MS, deriveRunDisplayState } from "../../src/state/run-liveness.ts";

const THIRTY_SECONDS = RUNNER_HEARTBEAT_STALE_MS + 15_000;
const FIVE_SECONDS = 5_000;
const NOW = 100_000;

let testsRun = 0;
afterEach(() => {
	testsRun++;
});
after(() => {
	process.stdout.write(`# tests ${testsRun}\n`);
});

describe("deriveRunDisplayState lost requires unknown phase", () => {
	it("active-phase-not-lost: thinking + 30s old heartbeat → not lost", () => {
		const result = deriveRunDisplayState({
			state: "running",
			phase: "thinking",
			runnerHeartbeatAt: NOW - THIRTY_SECONDS,
			now: NOW,
		});
		assert.notEqual(result, "lost", "thinking phase must not produce lost");
	});

	it("hard-dead-mid-phase: waiting_model + current tool + heartbeat over hard-dead ceiling → lost", () => {
		const result = deriveRunDisplayState({
			state: "running",
			currentTool: "ls",
			phase: "waiting_model",
			runnerHeartbeatAt: NOW - 36_000,
			now: NOW,
		});
		assert.equal(result, "lost", "hard-dead heartbeat must mark non-idle phase lost");
	});

	it("live-mid-phase: waiting_model + fresh heartbeat + current tool → tool_running", () => {
		const result = deriveRunDisplayState({
			state: "running",
			currentTool: "ls",
			phase: "waiting_model",
			runnerHeartbeatAt: NOW - 3_000,
			now: NOW,
		});
		assert.equal(result, "tool_running", "fresh non-idle heartbeat must keep current tool display");
	});

	it("hard-dead-boundary: just over the ceiling is lost, just under is not", () => {
		const justOver = deriveRunDisplayState({
			state: "running",
			currentTool: "ls",
			phase: "waiting_model",
			runnerHeartbeatAt: NOW - RUNNER_HARD_DEAD_MS - 1,
			now: NOW,
			hardDeadMs: RUNNER_HARD_DEAD_MS,
		});
		const justUnder = deriveRunDisplayState({
			state: "running",
			currentTool: "ls",
			phase: "waiting_model",
			runnerHeartbeatAt: NOW - RUNNER_HARD_DEAD_MS + 1,
			now: NOW,
			hardDeadMs: RUNNER_HARD_DEAD_MS,
		});
		assert.equal(justOver, "lost", "heartbeat just over hard-dead ceiling must be lost");
		assert.equal(justUnder, "tool_running", "heartbeat just under hard-dead ceiling must not be lost");
	});

	it("active-phase-stopped-heartbeat-fails-open-at-hard-dead-ceiling", () => {
		const result = deriveRunDisplayState({
			state: "running",
			phase: "thinking",
			runnerHeartbeatAt: NOW - RUNNER_HARD_DEAD_MS - 1,
			now: NOW,
			hardDeadMs: RUNNER_HARD_DEAD_MS,
		});
		assert.equal(result, "lost", "active in-process children must still render lost after heartbeat patches stop");
	});

	it("legacy-no-phase-still-lost-on-stale: missing phase + 30s old heartbeat → lost", () => {
		const result = deriveRunDisplayState({
			state: "running",
			runnerHeartbeatAt: NOW - THIRTY_SECONDS,
			now: NOW,
		});
		assert.equal(result, "lost", "legacy runs without phase must still go lost on stale heartbeat");
	});

	it("idle-with-stale-still-lost: idle + 30s old heartbeat → lost", () => {
		const result = deriveRunDisplayState({
			state: "running",
			phase: "idle",
			runnerHeartbeatAt: NOW - THIRTY_SECONDS,
			now: NOW,
		});
		assert.equal(result, "lost", "idle phase is treated as no active phase — still lost on stale");
	});

	it("active-phase-fresh-heartbeat-not-lost: thinking + 5s old heartbeat → working, not lost", () => {
		const result = deriveRunDisplayState({
			state: "running",
			phase: "thinking",
			runnerHeartbeatAt: NOW - FIVE_SECONDS,
			now: NOW,
		});
		assert.equal(result, "working", "fresh heartbeat must not produce lost during active phase");
	});

	it("terminal-state-wins: tool_running phase + terminal state → not lost", () => {
		const result = deriveRunDisplayState({
			state: "complete",
			phase: "tool_running",
			runnerHeartbeatAt: NOW - 60_000,
			now: NOW,
		});
		assert.notEqual(result, "lost", "terminal state must not be classified as lost");
	});
});
