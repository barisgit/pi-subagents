import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import registerSubagentNotify from "../../src/surfaces/notify.ts";
import { evictCompletionDedupeForRunId } from "../../src/state/completion-dedupe.ts";
import { computeGroupStatus } from "../../src/dispatch/layer0-runs.ts";
import { setCurrentPi } from "../../src/shared/current-pi.ts";
import { SUBAGENT_ASYNC_COMPLETE_EVENT, SUBAGENT_ASYNC_RUN_COMPLETE_EVENT } from "../../src/protocol/types.ts";

function createPi() {
	const inner = new EventEmitter();
	const bus = { on: (channel: string, handler: (data: unknown) => void) => { inner.on(channel, handler); return () => inner.off(channel, handler); }, emit: (channel: string, data: unknown) => inner.emit(channel, data) };
	const sent: Array<{ message: any; options: unknown }> = [];
	const pi = { events: bus, on: () => {}, sendMessage: (message: unknown, options: unknown) => sent.push({ message, options }) };
	setCurrentPi(pi as never);
	registerSubagentNotify(pi as never);
	return { events: inner, sent };
}

describe("resume notify group", () => {
	it("notify exactly once after dedupe eviction", () => {
		const h = createPi();
		const payload = { id: "resume-notify-once", runId: "resume-notify-once", agent: "fixer", success: true, state: "complete", summary: "done", timestamp: Date.now() };
		h.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, payload);
		h.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, { ...payload, summary: "deduped" });
		assert.equal(h.sent.length, 1);
		evictCompletionDedupeForRunId("resume-notify-once");
		h.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, { ...payload, summary: "done again" });
		h.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, { ...payload, summary: "deduped again" });
		assert.equal(h.sent.length, 2);
		assert.match(h.sent[1]!.message.content, /done again/);
	});

	it("group refold rolls up accumulated child completions", () => {
		assert.equal(computeGroupStatus(["complete", "running"]), "running");
		assert.equal(computeGroupStatus(["complete", "complete"]), "complete");
		const h = createPi();
		for (const id of ["child-a", "child-b"]) {
			h.events.emit(SUBAGENT_ASYNC_RUN_COMPLETE_EVENT, { id, runId: id, parentRunId: "group-refold", notifyPolicy: "rollup", agent: id, success: true, state: "complete", summary: id, timestamp: Date.now() });
		}
		h.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, { id: "group-refold", runId: "group-refold", notifyPolicy: "rollup", agent: "child-a,child-b", success: true, state: "complete", summary: "group", timestamp: Date.now() });
		assert.equal(h.sent.length, 1);
		assert.match(h.sent[0]!.message.content, /Background batch completed/);
		assert.match(h.sent[0]!.message.content, /child-a/);
		assert.match(h.sent[0]!.message.content, /child-b/);
	});

	it("no group refire when resuming a single child", () => {
		const h = createPi();
		h.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, { id: "group-original", runId: "group-original", notifyPolicy: "rollup", agent: "a,b", success: true, state: "complete", summary: "group done", children: [{ id: "child-only", runId: "child-only", agent: "a", state: "complete", success: true, summary: "child" }], timestamp: Date.now() });
		evictCompletionDedupeForRunId("child-only");
		h.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, { id: "child-only", runId: "child-only", parentRunId: "group-original", notifyPolicy: "each", agent: "a", success: true, state: "complete", summary: "child resumed", timestamp: Date.now() });
		assert.equal(h.sent.length, 2);
		assert.match(h.sent[1]!.message.content, /Background task completed/);
		assert.doesNotMatch(h.sent[1]!.message.content, /Background batch completed/);
	});

	it("rollup dedups resumed child completions by runId keeping latest", () => {
		const h = createPi();
		h.events.emit(SUBAGENT_ASYNC_RUN_COMPLETE_EVENT, { id: "child-a", runId: "child-a", parentRunId: "group-latest", notifyPolicy: "rollup", agent: "a", success: true, state: "complete", summary: "old", timestamp: 1 });
		h.events.emit(SUBAGENT_ASYNC_RUN_COMPLETE_EVENT, { id: "child-a", runId: "child-a", parentRunId: "group-latest", notifyPolicy: "rollup", agent: "a", success: true, state: "complete", summary: "latest", timestamp: 2 });
		h.events.emit(SUBAGENT_ASYNC_RUN_COMPLETE_EVENT, { id: "child-b", runId: "child-b", parentRunId: "group-latest", notifyPolicy: "rollup", agent: "b", success: true, state: "complete", summary: "other", timestamp: 3 });
		h.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, { id: "group-latest", runId: "group-latest", notifyPolicy: "rollup", agent: "a,b", success: true, state: "complete", summary: "group", timestamp: 4 });
		assert.equal(h.sent.length, 1);
		assert.equal(h.sent[0]!.message.details.children.length, 2);
		assert.deepEqual(h.sent[0]!.message.details.children.map((child: { runId: string }) => child.runId), ["child-a", "child-b"]);
	});
});
