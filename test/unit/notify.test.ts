import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import registerSubagentNotify from "../../notify.ts";
import { setCurrentPi } from "../../current-pi.ts";
import { SUBAGENT_ASYNC_COMPLETE_EVENT, SUBAGENT_ASYNC_RUN_COMPLETE_EVENT, SUBAGENT_NOTIFY_DELIVERED_EVENT } from "../../types.ts";

/**
 * Build a pi.events stand-in whose `on()` returns an unsubscribe function
 * (matching @earendil-works/pi-coding-agent's EventBus contract). Plain
 * node:events EventEmitter.on() returns the emitter itself, which masks the
 * exact bug that previously tore down the host's notify listener when a
 * child session activated. Tests MUST use this shim to catch that class of
 * regression.
 */
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
			listenerCount(channel: string): number {
				return inner.listenerCount(channel);
			},
		},
	};
}

function createPi() {
	const { bus, inner } = createBus();
	const sent: Array<{ message: unknown; options: unknown }> = [];
	const pi = {
		events: bus,
		sendMessage(message: unknown, options: unknown) {
			sent.push({ message, options });
		},
	};

	// notify.ts resolves the active pi via getCurrentPi() at emit time (so a
	// reload-invalidated capture cannot reach a dead session). Pin the mock as
	// the current pi for each test.
	setCurrentPi(pi as never);
	registerSubagentNotify(pi as never);

	return { events: inner, bus, sent };
}

const CHILD_SESSION_FLAG_KEY = "__piSubagentInsideChildSession";

function asChildSession<T>(fn: () => T): T {
	const g = globalThis as Record<string, unknown>;
	const prev = g[CHILD_SESSION_FLAG_KEY];
	g[CHILD_SESSION_FLAG_KEY] = true;
	try {
		return fn();
	} finally {
		if (prev === undefined) delete g[CHILD_SESSION_FLAG_KEY];
		else g[CHILD_SESSION_FLAG_KEY] = prev;
	}
}

describe("registerSubagentNotify", () => {
	it("uses a fallback summary when a background completion is empty", () => {
		const { events, sent } = createPi();

		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
			id: "notify-empty-1",
			agent: "worker",
			success: true,
			summary: "",
			exitCode: 0,
			timestamp: 123,
		});

		assert.equal(sent.length, 1);
		assert.deepEqual(sent[0], {
			message: {
				customType: "subagent-notify",
				content: "Background task completed: **worker**\n\n(no output)",
				display: true,
			},
			options: { triggerTurn: true },
		});
	});

	it("preserves non-empty completion summaries", () => {
		const { events, sent } = createPi();
		const summary = "  Done streaming\nAll clear  ";

		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
			id: "notify-summary-1",
			agent: "worker",
			success: true,
			summary,
			exitCode: 0,
			timestamp: 456,
			taskIndex: 1,
			totalTasks: 3,
		});

		assert.equal(sent.length, 1);
		assert.deepEqual(sent[0], {
			message: {
				customType: "subagent-notify",
				content: `Background task completed: **worker** (2/3)\n\n${summary}`,
				display: true,
			},
			options: { triggerTurn: true },
		});
	});

	it("preserves session paths in notification content", () => {
		const { events, sent } = createPi();

		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
			id: "notify-path-1",
			agent: "worker",
			success: true,
			summary: "Done",
			exitCode: 0,
			timestamp: 456,
			sessionFile: "/tmp/session.jsonl",
		});

		assert.deepEqual(sent, [{
			message: {
				customType: "subagent-notify",
				content: "Background task completed: **worker**\n\nDone\n\nSession file: /tmp/session.jsonl",
				display: true,
			},
			options: { triggerTurn: true },
		}]);
	});

	it("keeps the host notify subscription alive when a child session activates", () => {
		// Regression: previously the child's registerSubagentNotify() called
		// the host's previousUnsubscribe() via an unscoped globalThis slot,
		// silently tearing down the host's notify listener. The user then never
		// got a wake-up message after an async subagent finished.
		const host = createPi();
		assert.equal(host.events.listenerCount(SUBAGENT_ASYNC_COMPLETE_EVENT), 1);

		// Simulate the in-process executor activating this extension again for
		// the child session (createAgentSession→activate(childPi)).
		const { bus: childBus } = createBus();
		const childPi = {
			events: childBus,
			sendMessage() {
				// Child pi: must NEVER be called for host-bus events.
				throw new Error("child pi.sendMessage must not be invoked for host events");
			},
		};
		asChildSession(() => {
			registerSubagentNotify(childPi as never);
		});

		// Host bus must still have its notify listener attached.
		assert.equal(
			host.events.listenerCount(SUBAGENT_ASYNC_COMPLETE_EVENT),
			1,
			"child activate must NOT remove the host's notify listener",
		);

		// And the host must still receive notifications.
		host.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
			id: "host-survives-child-1",
			agent: "worker",
			success: true,
			summary: "Done",
			exitCode: 0,
			timestamp: 1000,
		});
		assert.equal(host.sent.length, 1);
		assert.equal(
			(host.sent[0]?.message as { content?: string })?.content,
			"Background task completed: **worker**\n\nDone",
		);
	});

	it("child-session subscriptions are scoped to their own bus, not the host's", () => {
		// A child session subscribing to async-complete on its own ephemeral bus
		// must NOT also pick up host-bus events. Otherwise every async would be
		// notified twice (once by host pi, once by every alive child pi).
		const host = createPi();

		const { inner: childInner, bus: childBus } = createBus();
		const childSent: Array<{ message: unknown; options: unknown }> = [];
		const childPi = {
			events: childBus,
			sendMessage(message: unknown, options: unknown) {
				childSent.push({ message, options });
			},
		};
		asChildSession(() => {
			registerSubagentNotify(childPi as never);
		});

		host.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
			id: "child-scope-1",
			agent: "worker",
			success: true,
			summary: "Done",
			exitCode: 0,
			timestamp: 2000,
		});

		assert.equal(host.sent.length, 1);
		assert.equal(childSent.length, 0, "child bus must not receive host events");

		// Child bus emits route to its own listener (which sends via the pinned
		// host pi by design — child does not pin its pi as current). What matters
		// for regression: the child listener exists on the child bus only.
		void childInner;
	});

	it("labels paused completions as paused even without an exit code", () => {
		const { events, sent } = createPi();

		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
			id: "notify-paused-1",
			agent: "worker",
			success: false,
			state: "paused",
			summary: "Paused after interrupt. Waiting for explicit next action.",
			timestamp: 789,
		});

		assert.equal(sent.length, 1);
		assert.deepEqual(sent[0], {
			message: {
				customType: "subagent-notify",
				content: "Background task paused: **worker**\n\nPaused after interrupt. Waiting for explicit next action.",
				display: true,
			},
			options: { triggerTurn: true },
		});
	});

	it("emits a delivered event covering the group and every rollup child", () => {
		const rollup = createPi();
		const delivered: string[][] = [];
		rollup.bus.on(SUBAGENT_NOTIFY_DELIVERED_EVENT, (data) => {
			delivered.push(((data as { runIds?: string[] })?.runIds ?? []).slice());
		});
		for (const childRunId of ["d0000000-0000-4000-8000-00000000000a", "d0000000-0000-4000-8000-00000000000b"]) {
			rollup.events.emit(SUBAGENT_ASYNC_RUN_COMPLETE_EVENT, {
				id: childRunId,
				runId: childRunId,
				parentRunId: "group-delivered",
				rootRunId: "group-delivered",
				notifyPolicy: "rollup",
				agent: "A",
				success: true,
				state: "complete",
				summary: "child done",
				timestamp: Date.now(),
			});
		}
		// Children buffered; nothing delivered yet.
		assert.equal(delivered.length, 0);

		rollup.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
			id: "group-delivered",
			runId: "group-delivered",
			rootRunId: "group-delivered",
			notifyPolicy: "rollup",
			agent: "A,A",
			success: true,
			state: "complete",
			summary: "group done",
			timestamp: Date.now(),
		});

		assert.equal(rollup.sent.length, 1);
		assert.equal(delivered.length, 1);
		assert.deepEqual(
			[...delivered[0]!].sort(),
			["d0000000-0000-4000-8000-00000000000a", "d0000000-0000-4000-8000-00000000000b", "group-delivered"].sort(),
		);
	});

	it("batch rollup aggregates time-separated per-run completions by notifyPolicy", () => {
		const rollup = createPi();
		for (const child of [
			{ runId: "00000000-0000-4000-8000-00000000000a", agent: "A", label: "Alpha check", summary: "from child A" },
			{ runId: "00000000-0000-4000-8000-00000000000b", agent: "B", label: "Bravo check", summary: "from child B" },
			{ runId: "00000000-0000-4000-8000-00000000000c", agent: "C", label: "Charlie check", summary: "from child C" },
		]) {
			rollup.events.emit(SUBAGENT_ASYNC_RUN_COMPLETE_EVENT, {
				id: child.runId,
				runId: child.runId,
				parentRunId: "group-rollup",
				rootRunId: "group-rollup",
				notifyPolicy: "rollup",
				agent: child.agent,
				label: child.label,
				success: true,
				state: "complete",
				summary: child.summary,
				timestamp: Date.now(),
			});
		}
		rollup.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
			id: "group-rollup",
			runId: "group-rollup",
			rootRunId: "group-rollup",
			notifyPolicy: "rollup",
			agent: "A,B,C",
			success: true,
			state: "complete",
			summary: "group summary without children",
			timestamp: Date.now(),
		});

		assert.equal(rollup.sent.length, 1);
		const rollupMessage = rollup.sent[0]!.message as { content?: string; details?: { kind?: string; completed?: number; total?: number; children?: Array<{ label?: string; agent?: string; state?: string; runId?: string }> } };
		const rollupContent = rollupMessage.content ?? "";
		assert.ok(rollupContent.startsWith("Background batch completed:"));
		for (const label of ["Alpha check", "Bravo check", "Charlie check"]) {
			assert.ok(rollupContent.includes(label), `rollup should include ${label}`);
		}
		assert.ok(!rollupContent.includes("00000000-0000-4000-8000-00000000000a"));
		assert.ok(rollupContent.includes("✓ Alpha check (A): complete"));
		assert.deepEqual(rollupMessage.details, {
			kind: "batch",
			completed: 3,
			total: 3,
			children: [
				{ label: "Alpha check", agent: "A", state: "complete", runId: "00000000-0000-4000-8000-00000000000a" },
				{ label: "Bravo check", agent: "B", state: "complete", runId: "00000000-0000-4000-8000-00000000000b" },
				{ label: "Charlie check", agent: "C", state: "complete", runId: "00000000-0000-4000-8000-00000000000c" },
			],
		});

		const each = createPi();
		for (const child of ["each-a", "each-b", "each-c"]) {
			each.events.emit(SUBAGENT_ASYNC_RUN_COMPLETE_EVENT, {
				id: child,
				runId: child,
				parentRunId: "group-each",
				rootRunId: "group-each",
				notifyPolicy: "each",
				agent: child,
				success: true,
				state: "complete",
				summary: `done ${child}`,
				timestamp: Date.now(),
			});
		}
		assert.equal(each.sent.length, 3);
		assert.ok(each.sent.every((entry) => ((entry.message as { content?: string }).content ?? "").startsWith("Background task completed:")));

		const silent = createPi();
		silent.events.emit(SUBAGENT_ASYNC_RUN_COMPLETE_EVENT, {
			id: "silent-a",
			runId: "silent-a",
			parentRunId: "group-silent",
			rootRunId: "group-silent",
			notifyPolicy: "silent",
			agent: "quiet",
			success: true,
			state: "complete",
			summary: "quiet",
			timestamp: Date.now(),
		});
		silent.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
			id: "group-silent",
			runId: "group-silent",
			rootRunId: "group-silent",
			notifyPolicy: "silent",
			agent: "quiet",
			success: true,
			state: "complete",
			summary: "quiet",
			timestamp: Date.now(),
		});
		assert.equal(silent.sent.length, 0);
	});

	it("a workflow sends exactly one notification carrying the script's return value", () => {
		const { events, sent } = createPi();

		// Workflow children complete silent: no individual notifications.
		for (const child of ["wfn-a", "wfn-b"]) {
			events.emit(SUBAGENT_ASYNC_RUN_COMPLETE_EVENT, {
				id: child,
				runId: child,
				parentRunId: "wfn-group",
				rootRunId: "wfn-group",
				notifyPolicy: "silent",
				agent: "explorer",
				success: true,
				state: "complete",
				summary: "child detail",
				timestamp: Date.now(),
			});
		}
		assert.equal(sent.length, 0, "workflow children must not notify individually");

		// The group completion identifies itself as a workflow and carries the
		// script's return value as the summary; children[] must NOT fan out.
		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
			id: "wfn-group",
			runId: "wfn-group",
			rootRunId: "wfn-group",
			notifyPolicy: "each",
			kind: "workflow",
			agent: "workflow",
			agents: "explorer,explorer",
			success: true,
			state: "complete",
			summary: '{ "verified": true }',
			children: [
				{ id: "wfn-a", agent: "explorer", success: true, summary: "child detail", timestamp: Date.now() },
				{ id: "wfn-b", agent: "explorer", success: true, summary: "child detail", timestamp: Date.now() },
			],
			timestamp: Date.now(),
		});

		assert.equal(sent.length, 1, "a workflow completion is exactly one notification");
		const content = (sent[0].message as { content?: string }).content ?? "";
		assert.ok(content.includes("**workflow**"), `workflow notification should name the workflow entity, got: ${content}`);
		assert.ok(content.includes('{ "verified": true }'), "notification must carry the script's return value");
	});
});
