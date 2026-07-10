import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	DEFAULT_NEEDS_ATTENTION_AFTER_MS,
	buildControlEvent,
	claimControlNotification,
	claimControlNotificationKey,
	controlNotificationKey,
	createControlNotificationDedupeStore,
	deriveActivityState,
	evictControlNotificationsForRunId,
	formatControlIntercomMessage,
	formatControlNoticeMessage,
	isControlEventAllowed,
	resolveControlConfig,
	shouldEmitControlEvent,
	shouldNotifyControlEvent,
} from "../../src/dispatch/subagent-control.ts";

const config = resolveControlConfig(undefined, {
	needsAttentionAfterMs: 300,
});

describe("subagent control attention state", () => {
	it("defaults the inactivity threshold to fifteen minutes", () => {
		assert.equal(resolveControlConfig().needsAttentionAfterMs, DEFAULT_NEEDS_ATTENTION_AFTER_MS);
		assert.equal(DEFAULT_NEEDS_ATTENTION_AFTER_MS, 15 * 60 * 1000);
	});

	it("marks a run as needing attention only after the idle threshold", () => {
		assert.equal(deriveActivityState({ config, startedAt: 0, lastActivityAt: 0, now: 50 }), undefined);
		assert.equal(deriveActivityState({ config, startedAt: 0, lastActivityAt: 0, now: 400 }), "needs_attention");
		assert.equal(deriveActivityState({ config, startedAt: 0, now: 400 }), "needs_attention");
	});

	it("never marks a queued run as needing attention, however long it waits", () => {
		// A queued child is blocked on a leaf-concurrency permit with no activity yet;
		// its baseline would otherwise fall back to dispatch time and fire the stall timer.
		assert.equal(deriveActivityState({ config, startedAt: 0, queued: true, now: 10_000 }), undefined);
		assert.equal(
			deriveActivityState({ config, startedAt: 0, lastActivityAt: 0, queued: true, now: 10_000 }),
			undefined,
		);
	});

	it("anchors the stall window on executionStartedAt, not dispatch time", () => {
		// Dispatched at 0, started executing at 9_900; at now=10_000 only 100ms of
		// execution has elapsed, well under the 300ms threshold -> not stalled.
		assert.equal(deriveActivityState({ config, startedAt: 0, executionStartedAt: 9_900, now: 10_000 }), undefined);
		// Past the threshold measured from executionStartedAt -> stalled.
		assert.equal(
			deriveActivityState({ config, startedAt: 0, executionStartedAt: 9_900, now: 10_300 }),
			"needs_attention",
		);
		// lastActivityAt still wins over executionStartedAt when present.
		assert.equal(
			deriveActivityState({ config, startedAt: 0, executionStartedAt: 0, lastActivityAt: 9_900, now: 10_000 }),
			undefined,
		);
	});

	it("suppresses needs-attention while the model is in an engaged phase", () => {
		for (const phase of ["waiting_model", "thinking", "streaming_text", "retrying"]) {
			assert.equal(
				deriveActivityState({ config, startedAt: 0, lastActivityAt: 0, phase, now: 1_000 }),
				undefined,
			);
		}

		assert.equal(deriveActivityState({ config, startedAt: 0, lastActivityAt: 0, now: 1_000 }), "needs_attention");
		assert.equal(
			deriveActivityState({ config, startedAt: 0, lastActivityAt: 0, phase: "idle", now: 1_000 }),
			"needs_attention",
		);
		assert.equal(
			deriveActivityState({ config, startedAt: 0, lastActivityAt: 0, phase: "paused", now: 1_000 }),
			"needs_attention",
		);
	});

	it("never marks an in-flight tool phase as needing attention", () => {
		for (const phase of ["tool_running", "tool_streaming"]) {
			assert.equal(
				deriveActivityState({ config, startedAt: 0, lastActivityAt: 0, phase, now: 1_000_000 }),
				undefined,
			);
		}
	});

	it("emits only needs-attention transitions", () => {
		assert.equal(shouldEmitControlEvent(config, undefined, undefined), false);
		assert.equal(shouldEmitControlEvent(config, undefined, "needs_attention"), true);
		assert.equal(shouldEmitControlEvent(config, "needs_attention", "needs_attention"), false);
		assert.equal(shouldEmitControlEvent(config, "needs_attention", undefined), false);
	});

	it("builds compact needs-attention control events", () => {
		const event = buildControlEvent({
			to: "needs_attention",
			runId: "run-1",
			agent: "worker",
			index: 2,
			ts: 1_000,
			lastActivityAt: 100,
		});
		assert.deepEqual(event, {
			type: "needs_attention",
			from: undefined,
			to: "needs_attention",
			ts: 1_000,
			activityAt: 100,
			runId: "run-1",
			agent: "worker",
			index: 2,
			message: "worker needs attention (no observed activity for 0s)",
		});
	});

	it("defaults notifications to needs attention", () => {
		const event = buildControlEvent({ to: "needs_attention", runId: "run-1", agent: "worker" });
		assert.equal(shouldNotifyControlEvent(config, event), true);
		assert.deepEqual(config.notifyOn, ["needs_attention"]);
		assert.deepEqual(config.notifyChannels, ["event", "async", "intercom"]);
	});

	it("resolves custom notification config", () => {
		const custom = resolveControlConfig(undefined, {
			needsAttentionAfterMs: 1234,
			notifyOn: ["needs_attention", "nope" as never],
			notifyChannels: ["event", "intercom", "bad" as never],
		});
		assert.equal(custom.needsAttentionAfterMs, 1234);
		assert.deepEqual(custom.notifyOn, ["needs_attention"]);
		assert.deepEqual(custom.notifyChannels, ["event", "intercom"]);
	});

	it("falls back to defaults for invalid non-empty notification arrays", () => {
		const custom = resolveControlConfig(undefined, {
			notifyOn: ["bogus" as never],
			notifyChannels: ["bogus" as never],
		});
		assert.deepEqual(custom.notifyOn, ["needs_attention"]);
		assert.deepEqual(custom.notifyChannels, ["event", "async", "intercom"]);
	});

	it("allows empty notification arrays to disable notifications", () => {
		const custom = resolveControlConfig(undefined, {
			notifyOn: [],
			notifyChannels: [],
		});
		const event = buildControlEvent({ to: "needs_attention", runId: "run-1", agent: "worker" });
		assert.deepEqual(custom.notifyOn, []);
		assert.deepEqual(custom.notifyChannels, []);
		assert.equal(shouldNotifyControlEvent(custom, event), false);
	});

	it("formats control notices with a proactive hint and concrete commands", () => {
		const event = buildControlEvent({ to: "needs_attention", runId: "78f659a3", agent: "worker" });

		const message = formatControlNoticeMessage(event, "subagent-worker-78f659a3");

		assert.match(message, /Subagent needs attention: worker/);
		assert.match(message, /Hint: Inspect status first unless the run is clearly blocked/);
		assert.match(message, /Nudge: intercom\(\{ action: "send", to: "subagent-worker-78f659a3"/);
		assert.match(message, /Status: subagent\(\{ action: "status", id: "78f659a3" \}\)/);
		assert.match(message, /Interrupt: subagent\(\{ action: "interrupt", id: "78f659a3" \}\)/);
		assert.doesNotMatch(message, /Wait:/);
	});

	it("formats intercom notifications with the same control commands", () => {
		const event = buildControlEvent({ to: "needs_attention", runId: "78f659a3", agent: "worker" });

		const message = formatControlIntercomMessage(event, "subagent-worker-78f659a3");

		assert.match(message, /worker needs attention in run 78f659a3/);
		assert.match(message, /Nudge: intercom\(\{ action: "send", to: "subagent-worker-78f659a3"/);
	});

	it("suppresses control events once the run has finalized", () => {
		assert.equal(isControlEventAllowed({ runFinalized: false }), true);
		assert.equal(isControlEventAllowed({ runFinalized: true }), false);
	});

	it("dedupes notifications once per child target and event transition", () => {
		const event = buildControlEvent({
			to: "needs_attention",
			runId: "run-1",
			agent: "worker",
			index: 0,
			ts: 1_000,
			activityAt: 500,
		});
		const seen = createControlNotificationDedupeStore();
		const legacySeen = new Set<string>();

		assert.equal(
			controlNotificationKey(event, "subagent-worker-run-1-1"),
			"subagent-worker-run-1-1:needs_attention",
		);
		assert.equal(claimControlNotification(config, event, legacySeen, "subagent-worker-run-1-1"), true);
		assert.equal(claimControlNotification(config, event, legacySeen, "subagent-worker-run-1-1"), false);
		assert.equal(claimControlNotificationKey(event, seen, "subagent-worker-run-1-1"), true);
		assert.equal(claimControlNotificationKey(event, seen, "subagent-worker-run-1-1"), false);
		assert.equal(claimControlNotificationKey({ ...event, ts: 2_000 }, seen, "subagent-worker-run-1-1"), false);
		assert.equal(
			claimControlNotificationKey({ ...event, ts: 3_000, activityAt: 2_500 }, seen, "subagent-worker-run-1-1"),
			true,
		);
		assert.equal(seen.byRunId.get("run-1")?.size, 1);

		const delimiterRun = { ...event, runId: "run-1:0", index: undefined, activityAt: 500 };
		assert.equal(claimControlNotificationKey(delimiterRun, seen), true);
		evictControlNotificationsForRunId(seen, "run-1");
		assert.equal(seen.byRunId.has("run-1"), false);
		assert.equal(seen.byRunId.has("run-1:0"), true);
	});
});
