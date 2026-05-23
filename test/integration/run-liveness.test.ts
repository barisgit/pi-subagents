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

const STALE = RUNNER_HEARTBEAT_STALE_MS + 5_000; // clearly stale
const NOW = 100_000;

let testsRun = 0;
afterEach(() => { testsRun++; });
after(() => { process.stdout.write(`# tests ${testsRun}\n`); });

describe("lost requires unknown phase", () => {
	it("active-phase-not-lost: tool_running + stale heartbeat → working, not lost", () => {
		const result = deriveRunDisplayState({
			state: "running",
			phase: "tool_running",
			runnerHeartbeatAt: NOW - STALE,
			now: NOW,
		});
		assert.notEqual(result, "lost", "tool_running phase must not produce lost");
	});

	it("active-phase-not-lost: thinking + stale heartbeat → not lost", () => {
		const result = deriveRunDisplayState({
			state: "running",
			phase: "thinking",
			runnerHeartbeatAt: NOW - STALE,
			now: NOW,
		});
		assert.notEqual(result, "lost", "thinking phase must not produce lost");
	});

	it("active-phase-not-lost: streaming_text + stale heartbeat → not lost", () => {
		const result = deriveRunDisplayState({
			state: "running",
			phase: "streaming_text",
			runnerHeartbeatAt: NOW - STALE,
			now: NOW,
		});
		assert.notEqual(result, "lost");
	});

	it("active-phase-not-lost: retrying + stale heartbeat → not lost", () => {
		const result = deriveRunDisplayState({
			state: "running",
			phase: "retrying",
			runnerHeartbeatAt: NOW - STALE,
			now: NOW,
		});
		assert.notEqual(result, "lost");
	});

	it("active-phase-not-lost: tool_streaming + stale heartbeat → not lost", () => {
		const result = deriveRunDisplayState({
			state: "running",
			phase: "tool_streaming",
			runnerHeartbeatAt: NOW - STALE,
			now: NOW,
		});
		assert.notEqual(result, "lost");
	});

	it("legacy-no-phase-still-lost-on-stale: undefined phase + stale heartbeat → lost", () => {
		const result = deriveRunDisplayState({
			state: "running",
			phase: undefined,
			runnerHeartbeatAt: NOW - STALE,
			now: NOW,
		});
		assert.equal(result, "lost", "legacy runs without phase must still go lost on stale heartbeat");
	});

	it("idle-with-stale-still-lost: phase: 'idle' + stale heartbeat → lost", () => {
		const result = deriveRunDisplayState({
			state: "running",
			phase: "idle",
			runnerHeartbeatAt: NOW - STALE,
			now: NOW,
		});
		assert.equal(result, "lost", "idle phase is treated as no active phase — still lost on stale");
	});

	it("terminal-state-wins: tool_running phase + terminal state → not lost (not running)", () => {
		const result = deriveRunDisplayState({
			state: "complete",
			phase: "tool_running",
			runnerHeartbeatAt: NOW - STALE,
			now: NOW,
		});
		// deriveRunDisplayState returns undefined for terminal states
		assert.notEqual(result, "lost", "terminal state must not be classified as lost");
	});

	it("fresh heartbeat + no phase → not lost (heartbeat not stale)", () => {
		const result = deriveRunDisplayState({
			state: "running",
			phase: undefined,
			runnerHeartbeatAt: NOW - 1_000, // fresh
			now: NOW,
		});
		assert.notEqual(result, "lost", "fresh heartbeat must not produce lost even without phase");
	});

	it("queued-follow-up phase + stale heartbeat → not lost", () => {
		const result = deriveRunDisplayState({
			state: "running",
			phase: "queued_follow_up",
			runnerHeartbeatAt: NOW - STALE,
			now: NOW,
		});
		assert.notEqual(result, "lost", "queued_follow_up is an active phase — must not be lost");
	});
});
