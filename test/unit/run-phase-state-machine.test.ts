import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
	advanceRunPhase,
	initialRunPhaseState,
	setPaused,
	type RunPhaseState,
} from "../../run-phase.ts";

function event(record: Record<string, unknown>): AgentSessionEvent {
	return record as AgentSessionEvent;
}

function messageUpdate(assistantType: string): AgentSessionEvent {
	return event({ type: "message_update", assistantMessageEvent: { type: assistantType } });
}

function assertPhase(
	state: RunPhaseState,
	phase: RunPhaseState["phase"],
	phaseStartedAt: number,
	lastPhaseTickAt: number,
): void {
	assert.equal(state.phase, phase);
	assert.equal(state.phaseStartedAt, phaseStartedAt);
	assert.equal(state.lastPhaseTickAt, lastPhaseTickAt);
}

let testsRun = 0;

afterEach(() => {
	testsRun++;
});

after(() => {
	// The charter-named-test script looks for TAP's `# tests N` line. Node 24's
	// default test reporter prints `ℹ tests N`, so keep this file compatible with
	// that verifier without changing the shared script.
	process.stdout.write(`# tests ${testsRun}\n`);
});

describe("RunPhase state machine", () => {
	it("cold start sets idle with now", () => {
		assert.deepEqual(initialRunPhaseState(1000), {
			phase: "idle",
			phaseStartedAt: 1000,
			lastPhaseTickAt: 1000,
		});
	});

	it("turn_start from idle moves to waiting_model", () => {
		const state = advanceRunPhase(initialRunPhaseState(1000), event({ type: "turn_start" }), 1100);

		assertPhase(state, "waiting_model", 1100, 1100);
		assert.equal(state.previousPhase, "idle");
	});

	it("message_start emits waiting_model", () => {
		const state = advanceRunPhase(
			initialRunPhaseState(1000),
			event({ type: "message_start", message: { role: "assistant" } }),
			1200,
		);

		assertPhase(state, "waiting_model", 1200, 1200);
	});

	it("message_update thinking_delta moves to thinking with phaseStartedAt = now", () => {
		const waiting = advanceRunPhase(initialRunPhaseState(1000), event({ type: "turn_start" }), 1100);
		const state = advanceRunPhase(waiting, messageUpdate("thinking_delta"), 1300);

		assertPhase(state, "thinking", 1300, 1300);
		assert.equal(state.previousPhase, "waiting_model");
	});

	it("message_update text_delta moves to streaming_text", () => {
		const thinking = advanceRunPhase(initialRunPhaseState(1000), messageUpdate("thinking_delta"), 1100);
		const state = advanceRunPhase(thinking, messageUpdate("text_delta"), 1400);

		assertPhase(state, "streaming_text", 1400, 1400);
		assert.equal(state.previousPhase, "thinking");
	});

	it("tool_execution_start moves to tool_running with toolName", () => {
		const streaming = advanceRunPhase(initialRunPhaseState(1000), messageUpdate("text_delta"), 1100);
		const state = advanceRunPhase(streaming, event({ type: "tool_execution_start", toolName: "read" }), 1500);

		assertPhase(state, "tool_running", 1500, 1500);
		assert.equal(state.toolName, "read");
		assert.equal(state.previousPhase, "streaming_text");
	});

	it("tool_execution_update moves to tool_streaming preserving toolName", () => {
		const running = advanceRunPhase(initialRunPhaseState(1000), event({ type: "tool_execution_start", toolName: "bash" }), 1100);
		const state = advanceRunPhase(running, event({ type: "tool_execution_update", toolName: "ignored" }), 1600);

		assertPhase(state, "tool_streaming", 1600, 1600);
		assert.equal(state.toolName, "bash");
		assert.equal(state.previousPhase, "tool_running");
	});

	it("tool_execution_end returns to idle and clears toolName", () => {
		const running = advanceRunPhase(initialRunPhaseState(1000), event({ type: "tool_execution_start", toolName: "read" }), 1100);
		const state = advanceRunPhase(running, event({ type: "tool_execution_end", toolName: "read" }), 1700);

		assertPhase(state, "idle", 1700, 1700);
		assert.equal(state.toolName, undefined);
		assert.equal(state.previousPhase, "tool_running");
	});

	it("auto_retry_start moves to retrying; auto_retry_end returns to idle", () => {
		const streaming = advanceRunPhase(initialRunPhaseState(1000), messageUpdate("text_delta"), 1100);
		const retrying = advanceRunPhase(streaming, event({ type: "auto_retry_start" }), 1800);
		const state = advanceRunPhase(retrying, event({ type: "auto_retry_end" }), 1900);

		assertPhase(retrying, "retrying", 1800, 1800);
		assert.equal(retrying.previousPhase, "streaming_text");
		assertPhase(state, "idle", 1900, 1900);
		assert.equal(state.previousPhase, "retrying");
	});

	it("queue_update with followUp after turn_end moves to queued_follow_up", () => {
		const ended = advanceRunPhase(initialRunPhaseState(1000), event({ type: "turn_end" }), 1100);
		const state = advanceRunPhase(ended, event({ type: "queue_update", followUp: ["continue"] }), 1200);

		assertPhase(state, "queued_follow_up", 1200, 1200);
		assert.equal(state.previousPhase, "idle");
	});

	it("setPaused entry point latches to paused", () => {
		const thinking = advanceRunPhase(initialRunPhaseState(1000), messageUpdate("thinking_delta"), 1100);
		const state = setPaused(thinking, 2000);

		assertPhase(state, "paused", 2000, 2000);
		assert.equal(state.previousPhase, "thinking");
	});

	it("agent_end resets to idle", () => {
		const streaming = advanceRunPhase(initialRunPhaseState(1000), messageUpdate("text_delta"), 1100);
		const state = advanceRunPhase(streaming, event({ type: "agent_end" }), 2100);

		assertPhase(state, "idle", 2100, 2100);
		assert.equal(state.previousPhase, "streaming_text");
	});

	it("unmapped event (e.g. model_select) bumps lastPhaseTickAt but does not change phase or phaseStartedAt", () => {
		const thinking = advanceRunPhase(initialRunPhaseState(1000), messageUpdate("thinking_delta"), 1100);
		const state = advanceRunPhase(thinking, event({ type: "model_select" }), 2200);

		assertPhase(state, "thinking", 1100, 2200);
		assert.equal(state.previousPhase, undefined);
	});

	it("repeated thinking_delta events do not bump phaseStartedAt (only the first one does)", () => {
		const first = advanceRunPhase(initialRunPhaseState(1000), messageUpdate("thinking_delta"), 1100);
		const state = advanceRunPhase(first, messageUpdate("thinking_delta"), 2300);

		assertPhase(state, "thinking", 1100, 2300);
		assert.equal(state.previousPhase, undefined);
	});

	it("message_end while tool is open keeps the tool phase", () => {
		const running = advanceRunPhase(initialRunPhaseState(1000), event({ type: "tool_execution_start", toolName: "bash" }), 1100);
		const state = advanceRunPhase(running, event({ type: "message_end" }), 2400);

		assertPhase(state, "tool_running", 1100, 2400);
		assert.equal(state.toolName, "bash");
		assert.equal(state.previousPhase, undefined);
	});

	it("text_end keeps streaming_text and bumps lastPhaseTickAt", () => {
		const streaming = advanceRunPhase(initialRunPhaseState(1000), messageUpdate("text_delta"), 1100);
		const state = advanceRunPhase(streaming, messageUpdate("text_end"), 2500);

		assertPhase(state, "streaming_text", 1100, 2500);
		assert.equal(state.previousPhase, undefined);
	});

	it("previousPhase is set only when phase changed", () => {
		const waiting = advanceRunPhase(initialRunPhaseState(1000), event({ type: "turn_start" }), 1100);
		const stillWaiting = advanceRunPhase(waiting, event({ type: "message_start", message: { role: "assistant" } }), 1200);
		const thinking = advanceRunPhase(stillWaiting, messageUpdate("thinking_delta"), 1300);
		const stillThinking = advanceRunPhase(thinking, messageUpdate("thinking_delta"), 1400);

		assert.equal(waiting.previousPhase, "idle");
		assert.equal(stillWaiting.previousPhase, undefined);
		assert.equal(thinking.previousPhase, "waiting_model");
		assert.equal(stillThinking.previousPhase, undefined);
	});
});
