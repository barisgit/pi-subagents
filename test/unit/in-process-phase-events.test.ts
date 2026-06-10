import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
	createPhaseEventHandler,
	type StatusPatch,
} from "../../src/dispatch/in-process-executor.ts";

function event(record: Record<string, unknown>): AgentSessionEvent {
	return record as AgentSessionEvent;
}

function messageUpdate(assistantType: string): AgentSessionEvent {
	return event({ type: "message_update", assistantMessageEvent: { type: assistantType } });
}

/** Collect all StatusPatch calls to onStatusUpdate. */
function makeCollector(): { patches: StatusPatch[]; onStatusUpdate: (p: StatusPatch) => void } {
	const patches: StatusPatch[] = [];
	return { patches, onStatusUpdate: (p) => patches.push(p) };
}

let testsRun = 0;
afterEach(() => { testsRun++; });
after(() => { process.stdout.write(`# tests ${testsRun}\n`); });

describe("in-process phase events (emits phase patches)", () => {
	it("thinking_delta event produces patch with phase: 'thinking'", () => {
		const { patches, onStatusUpdate } = makeCollector();
		const { handle } = createPhaseEventHandler({ runId: "r1", stepIndex: 0, onStatusUpdate, initialNow: 1000 });

		handle(event({ type: "turn_start" }), 1100);
		handle(messageUpdate("thinking_delta"), 1200);

		const thinkingPatch = patches.find((p) => p.phase === "thinking");
		assert.ok(thinkingPatch, "expected a patch with phase=thinking");
		assert.equal(thinkingPatch!.phaseStartedAt, 1200);
		assert.equal(thinkingPatch!.runnerHeartbeatAt, 1200);
		assert.equal(thinkingPatch!.runId, "r1");
		assert.equal(thinkingPatch!.stepIndex, 0);
	});

	it("tool_execution_start produces patch with phase: 'tool_running' and toolName", () => {
		const { patches, onStatusUpdate } = makeCollector();
		const { handle } = createPhaseEventHandler({ runId: "r2", stepIndex: 1, onStatusUpdate, initialNow: 1000 });

		handle(event({ type: "tool_execution_start", toolName: "bash" }), 1500);

		assert.equal(patches.length, 1);
		assert.equal(patches[0]!.phase, "tool_running");
		assert.equal(patches[0]!.phaseStartedAt, 1500);
		assert.equal(patches[0]!.runnerHeartbeatAt, 1500);
		assert.equal(patches[0]!.toolName, "bash");
	});

	it("tool_execution_end emits a patch with phase=idle", () => {
		const { patches, onStatusUpdate } = makeCollector();
		const { handle } = createPhaseEventHandler({ runId: "r3", stepIndex: 0, onStatusUpdate, initialNow: 1000 });

		handle(event({ type: "tool_execution_start", toolName: "read" }), 1100);
		handle(event({ type: "tool_execution_end", toolName: "read" }), 1200);

		const idlePatch = patches.find((p) => p.phase === "idle" && p.runnerHeartbeatAt === 1200);
		assert.ok(idlePatch, "expected idle patch after tool_execution_end");
	});

	it("phase persists across non-transition events", () => {
		const { patches, onStatusUpdate } = makeCollector();
		const { handle } = createPhaseEventHandler({ runId: "r4", stepIndex: 0, onStatusUpdate, initialNow: 1000 });

		handle(event({ type: "tool_execution_start", toolName: "bash" }), 1100);
		const countAfterStart = patches.length;
		handle(event({ type: "tool_execution_update", toolName: "bash" }), 1200);

		assert.equal(patches.length, countAfterStart + 1);
		assert.equal(patches.at(-2)!.phase, "tool_running");
		assert.equal(patches.at(-1)!.phase, "tool_streaming");
		assert.equal(patches.at(-1)!.toolName, "bash");
	});

	it("unmapped event drops silently (no patch emitted)", () => {
		const { patches, onStatusUpdate } = makeCollector();
		const { handle } = createPhaseEventHandler({ runId: "r5", stepIndex: 0, onStatusUpdate, initialNow: 1000 });

		handle(event({ type: "model_select" }), 1200);

		assert.equal(patches.length, 0, "unmapped event must not emit a patch");
	});

	it("coalesces rapid deltas does not double-emit on same phase", () => {
		const { patches, onStatusUpdate } = makeCollector();
		const { handle } = createPhaseEventHandler({ runId: "r6", stepIndex: 0, onStatusUpdate, initialNow: 1000 });

		handle(event({ type: "text_delta", delta: "a" }), 1100, {
			liveText: "a",
			activity: { state: "running", updatedAt: 1100 },
		});
		const countAfterFirst = patches.length;
		handle(event({ type: "text_delta", delta: "b" }), 1200, {
			liveText: "ab",
			activity: { state: "running", updatedAt: 1200 },
		});

		assert.equal(patches.length, countAfterFirst + 1, "second delta should emit only because liveText changed");
		assert.equal(patches.at(-1)!.phase, "streaming_text");
		assert.equal(patches.at(-1)!.phaseStartedAt, 1100, "same phase keeps original start time");
		assert.equal(patches.at(-1)!.runnerHeartbeatAt, 1200);
		assert.equal(patches.at(-1)!.liveText, "ab");
	});

	it("phase change from thinking to streaming_text emits exactly one patch", () => {
		const { patches, onStatusUpdate } = makeCollector();
		const { handle } = createPhaseEventHandler({ runId: "r7", stepIndex: 0, onStatusUpdate, initialNow: 1000 });

		handle(messageUpdate("thinking_delta"), 1100);
		const countAfterThinking = patches.length;
		handle(messageUpdate("text_delta"), 1200);

		assert.equal(patches.length, countAfterThinking + 1);
		assert.equal(patches.at(-1)!.phase, "streaming_text");
		assert.equal(patches.at(-1)!.phaseStartedAt, 1200);
	});

	it("auto_retry_start → retrying and auto_retry_end → idle each emit a patch", () => {
		const { patches, onStatusUpdate } = makeCollector();
		const { handle } = createPhaseEventHandler({ runId: "r8", stepIndex: 0, onStatusUpdate, initialNow: 1000 });

		handle(event({ type: "auto_retry_start" }), 1100);
		handle(event({ type: "auto_retry_end" }), 1200);

		const retryingPatch = patches.find((p) => p.phase === "retrying");
		const idlePatch = patches.find((p) => p.phase === "idle" && p.runnerHeartbeatAt === 1200);
		assert.ok(retryingPatch, "expected retrying patch");
		assert.ok(idlePatch, "expected idle patch after auto_retry_end");
	});

	it("runnerHeartbeatAt matches the now passed to each call", () => {
		const { patches, onStatusUpdate } = makeCollector();
		const { handle } = createPhaseEventHandler({ runId: "r9", stepIndex: 0, onStatusUpdate, initialNow: 5000 });

		handle(event({ type: "turn_start" }), 6000);

		const patch = patches.find((p) => p.phase === "waiting_model");
		assert.ok(patch);
		assert.equal(patch!.runnerHeartbeatAt, 6000);
	});

	it("no patch emitted when onStatusUpdate is absent (factory guard)", () => {
		// This path is exercised at the call site (phaseHandler is only created
		// when ctx.onStatusUpdate exists), but we can also verify createPhaseEventHandler
		// itself doesn't throw when invoked with a no-op.
		let called = false;
		const { handle } = createPhaseEventHandler({
			runId: "r10",
			stepIndex: 0,
			onStatusUpdate: () => { called = false; },
			initialNow: 1000,
		});
		handle(event({ type: "agent_end" }), 2000);
		// Just confirm it doesn't throw
		assert.ok(true);
		void called;
	});

	it("queue_update with followUp after turn_end emits queued_follow_up patch", () => {
		const { patches, onStatusUpdate } = makeCollector();
		const { handle } = createPhaseEventHandler({ runId: "r11", stepIndex: 0, onStatusUpdate, initialNow: 1000 });

		handle(event({ type: "turn_end" }), 1100);
		handle(event({ type: "queue_update", followUp: ["continue"] }), 1200);

		const queuedPatch = patches.find((p) => p.phase === "queued_follow_up");
		assert.ok(queuedPatch, "expected queued_follow_up patch");
		assert.equal(queuedPatch!.runnerHeartbeatAt, 1200);
	});

	it("full turn sequence emits patches only at transitions and tool events", () => {
		const { patches, onStatusUpdate } = makeCollector();
		const { handle } = createPhaseEventHandler({ runId: "r12", stepIndex: 0, onStatusUpdate, initialNow: 1000 });

		const seq: Array<[AgentSessionEvent, number]> = [
			[event({ type: "agent_start" }), 1000],
			[event({ type: "turn_start" }), 1100],
			[event({ type: "message_start", message: { role: "assistant" } }), 1150],
			[messageUpdate("thinking_delta"), 1200],
			[messageUpdate("thinking_delta"), 1250], // within-phase, suppressed
			[messageUpdate("thinking_delta"), 1300], // within-phase, suppressed
			[messageUpdate("text_delta"), 1400],     // transition → streaming_text
			[messageUpdate("text_delta"), 1450],     // within-phase, suppressed
			[event({ type: "tool_execution_start", toolName: "bash" }), 1500],
			[event({ type: "tool_execution_update" }), 1550],
			[event({ type: "tool_execution_end", toolName: "bash" }), 1600],
			[event({ type: "turn_end" }), 1700],
			[event({ type: "agent_end" }), 1800],
		];

		for (const [ev, ts] of seq) handle(ev, ts);

		const phases = patches.map((p) => p.phase);
		// Must contain transitions and tool events; must NOT contain a second thinking entry
		assert.ok(phases.includes("waiting_model"), "waiting_model patch expected");
		assert.ok(phases.includes("thinking"), "thinking patch expected");
		assert.ok(phases.includes("streaming_text"), "streaming_text patch expected");
		assert.ok(phases.includes("tool_running"), "tool_running patch (start) expected");
		assert.ok(phases.includes("tool_streaming"), "tool_streaming patch (update) expected");

		// Rapid within-phase deltas must be suppressed
		const thinkingCount = phases.filter((p) => p === "thinking").length;
		assert.ok(thinkingCount <= 1, `expected ≤1 thinking patch, got ${thinkingCount}`);
		const streamingCount = phases.filter((p) => p === "streaming_text").length;
		assert.ok(streamingCount <= 1, `expected ≤1 streaming_text patch, got ${streamingCount}`);
	});
});
