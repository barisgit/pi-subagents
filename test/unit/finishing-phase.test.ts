import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { advanceRunPhase, formatPhase, initialRunPhaseState } from "../../src/state/run-phase.ts";

function event(record: Record<string, unknown>): AgentSessionEvent {
	return record as AgentSessionEvent;
}

function toolCallUpdate(assistantType: "toolcall_start" | "toolcall_delta", name: string): AgentSessionEvent {
	return event({
		type: "message_update",
		assistantMessageEvent: { type: assistantType, contentIndex: 0 },
		message: { content: [{ type: "toolCall", name, arguments: {} }] },
	});
}

let testsRun = 0;
afterEach(() => {
	testsRun++;
});
after(() => {
	process.stdout.write(`# tests ${testsRun}\n`);
});

describe("finishing phase", () => {
	it("does not enter finishing for ordinary tool calls", () => {
		const state = advanceRunPhase(initialRunPhaseState(1000), toolCallUpdate("toolcall_start", "read"), 2000);

		assert.notEqual(state.phase, "finishing");
		assert.equal(state.phase, "idle");
	});

	it("enters tool_running when an ordinary tool starts executing", () => {
		const state = advanceRunPhase(
			initialRunPhaseState(1000),
			event({ type: "tool_execution_start", toolName: "read" }),
			2000,
		);

		assert.equal(state.phase, "tool_running");
		assert.equal(state.phaseStartedAt, 2000);
		assert.equal(state.previousPhase, "idle");
	});

	it("formats finishing with elapsed duration", () => {
		const label = formatPhase("finishing", 1000, 4000);

		assert.match(label, /^finishing/);
		assert.match(label, /3\.0s/);
	});
});
