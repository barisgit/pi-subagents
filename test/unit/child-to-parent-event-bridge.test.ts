/**
 * Tests for f7-child-to-parent-event-bridge.
 *
 * Drives createPhaseEventHandler with a fake pi.events recorder and asserts
 * that subagent:phase-change is emitted for each RunPhase transition.
 */
import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
	createPhaseEventHandler,
	type PhaseEventHandlerOptions,
	type StatusPatch,
} from "../../src/dispatch/in-process-executor.ts";
import { SUBAGENT_PHASE_CHANGE_EVENT, type SubagentPhaseChangePayload } from "../../src/protocol/types.ts";

function event(record: Record<string, unknown>): AgentSessionEvent {
	return record as AgentSessionEvent;
}
function messageUpdate(assistantType: string): AgentSessionEvent {
	return event({ type: "message_update", assistantMessageEvent: { type: assistantType } });
}

/** Fake EventBus recorder. */
function makeEventsBus() {
	const calls: Array<{ event: string; payload: SubagentPhaseChangePayload }> = [];
	return {
		emit(ev: string, payload: SubagentPhaseChangePayload) { calls.push({ event: ev, payload }); },
		calls,
	};
}

function baseOpts(
	onStatusUpdate: (p: StatusPatch) => void,
	pi?: PhaseEventHandlerOptions["pi"],
): PhaseEventHandlerOptions {
	return { runId: "r1", stepIndex: 0, onStatusUpdate, initialNow: 1000, pi };
}

let testsRun = 0;
afterEach(() => { testsRun++; });
after(() => { process.stdout.write(`# tests ${testsRun}\n`); });

describe("child-to-parent event bridge: phase-change emits on parent pi", () => {
	it("emit-on-phase-change: transitions produce subagent:phase-change events with correct payload", () => {
		const bus = makeEventsBus();
		const patches: StatusPatch[] = [];
		const { handle } = createPhaseEventHandler(baseOpts((p) => patches.push(p), { events: bus }));

		// Drive: idle → waiting_model → thinking → tool_running → idle
		handle(event({ type: "turn_start" }), 1100);               // idle → waiting_model
		handle(messageUpdate("thinking_delta"), 1200);              // waiting_model → thinking
		handle(event({ type: "tool_execution_start", toolName: "bash" }), 1300); // thinking → tool_running
		handle(event({ type: "tool_execution_end" }), 1400);       // tool_running → idle

		const phaseEvents = bus.calls.filter((c) => c.event === SUBAGENT_PHASE_CHANGE_EVENT);
		assert.equal(phaseEvents.length, 4, `expected 4 phase-change events, got ${phaseEvents.length}`);

		assert.equal(phaseEvents[0]!.payload.phase, "waiting_model");
		assert.equal(phaseEvents[0]!.payload.previousPhase, "idle");
		assert.equal(phaseEvents[0]!.payload.runId, "r1");
		assert.equal(phaseEvents[0]!.payload.ts, 1100);

		assert.equal(phaseEvents[1]!.payload.phase, "thinking");
		assert.equal(phaseEvents[1]!.payload.previousPhase, "waiting_model");

		assert.equal(phaseEvents[2]!.payload.phase, "tool_running");
		assert.equal(phaseEvents[2]!.payload.toolName, "bash");

		assert.equal(phaseEvents[3]!.payload.phase, "idle");
		assert.equal(phaseEvents[3]!.payload.previousPhase, "tool_running");
	});

	it("within-phase deltas do NOT emit phase-change events", () => {
		const bus = makeEventsBus();
		const { handle } = createPhaseEventHandler(baseOpts(() => {}, { events: bus }));

		handle(messageUpdate("thinking_delta"), 1100); // → thinking (1 transition)
		handle(messageUpdate("thinking_delta"), 1200); // within-phase, no transition
		handle(messageUpdate("thinking_delta"), 1300); // within-phase, no transition

		const phaseEvents = bus.calls.filter((c) => c.event === SUBAGENT_PHASE_CHANGE_EVENT);
		assert.equal(phaseEvents.length, 1, "only the first thinking_delta must emit a phase-change event");
	});

	it("no-pi-noop: ctx.pi absent → no throw, onStatusUpdate still receives patches", () => {
		const patches: StatusPatch[] = [];
		let threw = false;
		try {
			const { handle } = createPhaseEventHandler(baseOpts((p) => patches.push(p), undefined));
			handle(event({ type: "turn_start" }), 1100);
			handle(messageUpdate("thinking_delta"), 1200);
		} catch {
			threw = true;
		}
		assert.ok(!threw, "missing pi must not throw");
		assert.ok(patches.length > 0, "onStatusUpdate must still receive patches when pi is absent");
	});

	it("no-events-bus-noop: ctx.pi present but events absent → no throw", () => {
		let threw = false;
		try {
			const { handle } = createPhaseEventHandler(baseOpts(() => {}, {}));
			handle(event({ type: "turn_start" }), 1100);
		} catch {
			threw = true;
		}
		assert.ok(!threw, "missing pi.events must not throw");
	});

	it("never-throws-on-emit-failure: pi.events.emit throwing must not propagate", () => {
		const evilBus = {
			emit() { throw new Error("bus exploded"); },
		};
		let threw = false;
		try {
			const { handle } = createPhaseEventHandler(baseOpts(() => {}, { events: evilBus }));
			handle(event({ type: "turn_start" }), 1100); // triggers transition → emit → throws internally
		} catch {
			threw = true;
		}
		assert.ok(!threw, "an emit() failure must not propagate out of the subscriber");
	});

	it("stepIndex and runId are correctly forwarded in payload", () => {
		const bus = makeEventsBus();
		const { handle } = createPhaseEventHandler({
			runId: "my-run",
			stepIndex: 3,
			onStatusUpdate: () => {},
			initialNow: 0,
			pi: { events: bus },
		});
		handle(event({ type: "turn_start" }), 500);
		const ev = bus.calls.find((c) => c.event === SUBAGENT_PHASE_CHANGE_EVENT);
		assert.ok(ev, "phase-change event must be emitted");
		assert.equal(ev!.payload.runId, "my-run");
		assert.equal(ev!.payload.stepIndex, 3);
	});

	it("toolName is included in payload for tool_running transition", () => {
		const bus = makeEventsBus();
		const { handle } = createPhaseEventHandler(baseOpts(() => {}, { events: bus }));
		handle(event({ type: "tool_execution_start", toolName: "read" }), 1100);
		const toolEv = bus.calls.find((c) => c.payload.phase === "tool_running");
		assert.ok(toolEv, "tool_running phase-change event expected");
		assert.equal(toolEv!.payload.toolName, "read");
	});
});
