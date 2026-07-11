import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import registerSubagentNotify from "../../src/surfaces/notify.ts";
import { setCurrentPi } from "../../src/shared/current-pi.ts";
import { batchToNotifyPolicy } from "../../src/dispatch/executor-helpers.ts";
import { SUBAGENT_ASYNC_COMPLETE_EVENT, SUBAGENT_ASYNC_RUN_COMPLETE_EVENT } from "../../src/protocol/types.ts";

function createBus() {
	const inner = new EventEmitter();
	return {
		inner,
		bus: {
			on(channel: string, handler: (data: unknown) => void): () => void {
				inner.on(channel, handler);
				return () => inner.off(channel, handler);
			},
			emit(channel: string, data: unknown) {
				inner.emit(channel, data);
			},
		},
	};
}

function createPi() {
	const { bus, inner } = createBus();
	const sent: Array<{ message: unknown; options: unknown }> = [];
	const pi = {
		events: bus,
		on() {},
		sendMessage(message: unknown, options: unknown) {
			sent.push({ message, options });
		},
	};
	setCurrentPi(pi as never);
	registerSubagentNotify(pi as never);
	return { events: inner, sent };
}

describe("notifyPolicy node behavior", () => {
	it("notifyPolicy is per-node and batch:true is sugar for the group node", () => {
		assert.equal(batchToNotifyPolicy(true), "rollup");
		assert.equal(batchToNotifyPolicy(false), "each");
		assert.equal(batchToNotifyPolicy(undefined), "each");

		const { events, sent } = createPi();
		events.emit(SUBAGENT_ASYNC_RUN_COMPLETE_EVENT, {
			id: "phase-a",
			runId: "phase-a",
			parentRunId: "phase-group",
			rootRunId: "phase-group",
			notifyPolicy: "rollup",
			agent: "A",
			success: true,
			state: "complete",
			summary: "visible phase child",
			timestamp: 100,
		});
		events.emit(SUBAGENT_ASYNC_RUN_COMPLETE_EVENT, {
			id: "silent-subtree-child",
			runId: "silent-subtree-child",
			parentRunId: "silent-subtree",
			rootRunId: "phase-group",
			notifyPolicy: "silent",
			agent: "quiet",
			success: true,
			state: "complete",
			summary: "must not notify",
			timestamp: 101,
		});
		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
			id: "silent-subtree",
			runId: "silent-subtree",
			parentRunId: "phase-group",
			rootRunId: "phase-group",
			notifyPolicy: "silent",
			agent: "quiet",
			success: true,
			state: "complete",
			summary: "silent subtree done",
			timestamp: 102,
		});
		events.emit(SUBAGENT_ASYNC_RUN_COMPLETE_EVENT, {
			id: "phase-b",
			runId: "phase-b",
			parentRunId: "phase-group",
			rootRunId: "phase-group",
			notifyPolicy: "rollup",
			agent: "B",
			success: true,
			state: "complete",
			summary: "visible second child",
			timestamp: 103,
		});
		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
			id: "phase-group",
			runId: "phase-group",
			rootRunId: "phase-group",
			notifyPolicy: "rollup",
			agent: "A,B",
			success: true,
			state: "complete",
			summary: "phase boundary done",
			timestamp: 104,
		});

		assert.equal(sent.length, 1);
		const content = (sent[0]!.message as { content?: string }).content ?? "";
		assert.ok(content.includes("✓ A (A): complete"));
		assert.ok(content.includes("✓ B (B): complete"));
		assert.ok(!content.includes("phase-a"));
		assert.ok(!content.includes("phase-b"));
		assert.ok(!content.includes("silent-subtree-child"));
		assert.ok(!content.includes("silent-subtree done"));
	});
});
