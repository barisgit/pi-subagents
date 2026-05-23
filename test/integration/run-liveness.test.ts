/**
 * Integration tests for deriveRunDisplayState — f5-lost-requires-unknown-phase.
 *
 * "lost" may only be returned when phase is undefined/idle AND the heartbeat
 * is stale. A run with an active phase (thinking, tool_running, etc.) is
 * immune to "lost" regardless of heartbeat age.
 */
import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import { RUNNER_HEARTBEAT_STALE_MS, deriveRunDisplayState } from "../../run-liveness.ts";

const THIRTY_SECONDS = RUNNER_HEARTBEAT_STALE_MS + 15_000;
const SIXTY_SECONDS = 60_000;
const FIVE_SECONDS = 5_000;
const NOW = 100_000;

let testsRun = 0;
afterEach(() => { testsRun++; });
after(() => { process.stdout.write(`# tests ${testsRun}\n`); });

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

	it("active-tool-phase-not-lost: tool_running + 60s old heartbeat → tool_running, not lost", () => {
		const result = deriveRunDisplayState({
			state: "running",
			currentTool: "bash",
			phase: "tool_running",
			runnerHeartbeatAt: NOW - SIXTY_SECONDS,
			now: NOW,
		});
		assert.equal(result, "tool_running", "tool_running phase must not produce lost");
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
			runnerHeartbeatAt: NOW - SIXTY_SECONDS,
			now: NOW,
		});
		assert.notEqual(result, "lost", "terminal state must not be classified as lost");
	});
});
