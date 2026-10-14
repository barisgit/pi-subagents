import assert from "node:assert/strict";
import { EventEmitter, getEventListeners } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, describe, it } from "node:test";
import {
	ChildAgentRegistry,
	__setChildAgentExecutorDepsForTest,
	dispatchAsyncChild,
	runChildAgent,
	__setNestedParkKeepAliveForTest,
	type ChildAgentContext,
	type ChildAgentHandle,
	type ChildAgentResult,
	type ChildAgentStep,
} from "../../src/dispatch/in-process-executor.ts";
import { safeEmit } from "../../src/dispatch/executor-helpers.ts";
import { SUBAGENT_ASYNC_COMPLETE_EVENT, SUBAGENT_ASYNC_STARTED_EVENT } from "../../src/protocol/types.ts";
import { claimPendingChildLineage, getLineageForSession, setHostLineage } from "../../src/state/lineage.ts";
import {
	type ChildSessionMessageDelivery,
	getChildSessionMessageDelivery,
	isInsideChildSession,
} from "../../src/shared/child-session-context.ts";
import { LiveSessionDirectory } from "../../src/shared/live-session-relay.ts";
import { readRunTranscriptPreview } from "../../src/state/run-transcript-preview.ts";
import {
	__nestedAsyncWaiterCountForTest,
	enqueueNestedCompletionReprompt,
	flushNestedCompletionReprompts,
	holdNestedAsyncRollup,
	markNestedAsyncFinished,
	markNestedAsyncProgress,
	markNestedAsyncStarted,
	markNestedParentTurn,
	nestedAsyncParentSnapshot,
	registerNestedAsyncParent,
	registerNestedAsyncCancellation,
	releaseNestedAsyncParent,
} from "../../src/dispatch/nested-async-coordinator.ts";
import { __resetLeafConcurrencyForTest, leafConcurrencyLimit } from "../../src/dispatch/leaf-concurrency.ts";

const cleanup: string[] = [];
const restoreFns: Array<() => void> = [];

function clearLineage(...sessionIds: string[]): void {
	const globals = globalThis as Record<string, unknown>;
	const lineageStore = globals.__piSubagentLineageBySession as Map<string, unknown> | undefined;
	const boundSessionFiles = globals.__piSubagentLineageBoundSessionFiles as Map<string, unknown> | undefined;
	for (const sessionId of sessionIds) {
		lineageStore?.delete(sessionId);
		boundSessionFiles?.delete(sessionId);
	}
}

afterEach(() => {
	while (restoreFns.length > 0) restoreFns.pop()?.();
	__resetLeafConcurrencyForTest();
});

it("reaches quiescence and releases the leaf permit when parent-session delivery rejects before agent_start", async () => {
	leafConcurrencyLimit(1);
	const parentRunId = "run-failed-send-parent";
	let promptSettled!: () => void;
	const settled = new Promise<void>((resolve) => {
		promptSettled = resolve;
	});
	let deliverMessage: ChildSessionMessageDelivery | undefined;
	const parentSession = new FakeAgentSession(async (self) => {
		registerNestedAsyncParent(parentRunId);
		markNestedAsyncStarted(parentRunId, "run-failed-send-child");
		self.lastAssistantText = "<output>waiting</output>";
		promptSettled();
	});
	parentSession.sendCustomMessageImpl = async () => {
		throw new Error("before_agent_start rejected");
	};
	const nextSession = new FakeAgentSession(async (self) => {
		self.lastAssistantText = "<output>next</output>";
	});
	installFakeRuntime([parentSession, nextSession], () => {
		deliverMessage = getChildSessionMessageDelivery();
	});
	const parent = runChildAgent(makeStep({ runId: parentRunId }), makeContext());
	await settled;
	markNestedAsyncFinished(parentRunId, "run-failed-send-child");
	enqueueNestedCompletionReprompt(parentRunId, async () => {
		assert.ok(deliverMessage);
		await deliverMessage(
			{ customType: "subagent-notify", content: "Done", display: true, details: { runId: "child" } },
			{ triggerTurn: true },
		);
		return true;
	});

	const result = await parent;
	assert.equal(result.state, "failed");
	assert.equal(result.error?.reason, "nested_delivery_failed");
	assert.deepEqual(parentSession.sendCustomMessageCalls, [
		{
			message: { customType: "subagent-notify", content: "Done", display: true, details: { runId: "child" } },
			options: { triggerTurn: true },
		},
	]);
	assert.equal(nestedAsyncParentSnapshot(parentRunId), null);
	assert.equal(parentSession.disposeCalls, 1);
	assert.equal((await runChildAgent(makeStep({ runId: "run-after-failed-send" }), makeContext())).state, "complete");
});

it("aborts the active session when its controller fires during completion delivery", async () => {
	const parentRunId = "run-aborted-delivery-parent";
	const controller = new AbortController();
	let promptSettled!: () => void;
	const settled = new Promise<void>((resolve) => {
		promptSettled = resolve;
	});
	let deliveryStarted!: () => void;
	const started = new Promise<void>((resolve) => {
		deliveryStarted = resolve;
	});
	let deliverMessage: ChildSessionMessageDelivery | undefined;
	const session = new FakeAgentSession(async (self) => {
		registerNestedAsyncParent(parentRunId);
		markNestedAsyncStarted(parentRunId, "run-aborted-delivery-child");
		self.lastAssistantText = "<output>waiting</output>";
		promptSettled();
	});
	session.sendCustomMessageImpl = async () => {
		deliveryStarted();
		await new Promise<void>(() => {});
	};
	installFakeRuntime([session], () => {
		deliverMessage = getChildSessionMessageDelivery();
	});
	const parent = runChildAgent(makeStep({ runId: parentRunId }), makeContext({ abortSignal: controller.signal }));
	await settled;
	markNestedAsyncFinished(parentRunId, "run-aborted-delivery-child");
	enqueueNestedCompletionReprompt(parentRunId, async () => {
		assert.ok(deliverMessage);
		await deliverMessage({ customType: "subagent-notify", content: "Done", display: true }, { triggerTurn: true });
		return true;
	});
	await started;

	controller.abort("controller-only abort");
	const terminatedPromptly = await Promise.race([
		parent.then(() => true),
		new Promise<false>((resolve) => setImmediate(() => resolve(false))),
	]);
	const result = await parent;

	assert.equal(terminatedPromptly, true);
	assert.equal(result.state, "interrupted");
	assert.equal(result.error?.reason, "controller-only abort");
	assert.equal(session.abortCalls, 1);
	assert.equal(session.disposeCalls, 1);
	assert.equal(nestedAsyncParentSnapshot(parentRunId), null);
});

it("releases nested coordinator state when an active parent child is aborted", async () => {
	const parentRunId = "run-aborted-nested-parent";
	let promptStarted!: () => void;
	const started = new Promise<void>((resolve) => {
		promptStarted = resolve;
	});
	let cancelCalls = 0;
	const session = new FakeAgentSession(async () => {
		registerNestedAsyncParent(parentRunId);
		markNestedAsyncStarted(parentRunId, "run-active-descendant");
		registerNestedAsyncCancellation(parentRunId, () => cancelCalls++);
		promptStarted();
		await new Promise(() => {});
	});
	installFakeRuntime([session]);
	const handle = dispatchAsyncChild(makeStep({ runId: parentRunId }), makeContext());
	await started;

	await handle.abort("test abort");
	assert.equal((await handle.completed).state, "interrupted");
	assert.equal(session.disposeCalls, 1);
	assert.equal(cancelCalls, 1);
	assert.equal(nestedAsyncParentSnapshot(parentRunId), null);
});

it("aborts a parked nested parent while a sibling holds the saturated leaf permit", async () => {
	leafConcurrencyLimit(1);
	const parentRunId = "run-aborted-parked-parent";
	let parentPromptSettled!: () => void;
	const parentSettled = new Promise<void>((resolve) => {
		parentPromptSettled = resolve;
	});
	let siblingPromptStarted!: () => void;
	const siblingStarted = new Promise<void>((resolve) => {
		siblingPromptStarted = resolve;
	});
	let releaseSibling!: () => void;
	const siblingGate = new Promise<void>((resolve) => {
		releaseSibling = resolve;
	});
	const parentSession = new FakeAgentSession(async (self) => {
		registerNestedAsyncParent(parentRunId);
		markNestedAsyncStarted(parentRunId, "run-parked-descendant");
		self.lastAssistantText = "<output>waiting</output>";
		parentPromptSettled();
	});
	const siblingSession = new FakeAgentSession(async (self) => {
		siblingPromptStarted();
		await siblingGate;
		self.lastAssistantText = "<output>sibling</output>";
	});
	let nextPromptStarted = false;
	const nextSession = new FakeAgentSession(async (self) => {
		nextPromptStarted = true;
		self.lastAssistantText = "<output>next</output>";
	});
	installFakeRuntime([parentSession, siblingSession, nextSession]);

	const parent = dispatchAsyncChild(makeStep({ runId: parentRunId }), makeContext());
	await parentSettled;
	const sibling = runChildAgent(makeStep({ runId: "run-saturated-sibling" }), makeContext());
	await siblingStarted;

	await parent.abort("test abort");
	const abortedPromptly = await Promise.race([
		parent.completed.then(() => true),
		new Promise<false>((resolve) => setImmediate(() => resolve(false))),
	]);
	const next = runChildAgent(makeStep({ runId: "run-after-aborted-parent" }), makeContext());
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(nextPromptStarted, false, "aborted parked parent must not leak a leaf permit");
	releaseSibling();
	await Promise.all([sibling, next]);

	assert.equal(abortedPromptly, true);
	assert.equal((await parent.completed).state, "interrupted");
	assert.equal(nestedAsyncParentSnapshot(parentRunId), null);
});

it("keeps a nested batch parent active between its last leaf and rollup enqueue", () => {
	const parentRunId = "run-batch-parent";
	const groupRunId = "run-batch-group";
	registerNestedAsyncParent(parentRunId);
	holdNestedAsyncRollup(parentRunId, groupRunId);
	markNestedAsyncStarted(parentRunId, "run-batch-last-leaf");

	markNestedAsyncFinished(parentRunId, "run-batch-last-leaf");
	assert.equal(nestedAsyncParentSnapshot(parentRunId)?.active, true);

	enqueueNestedCompletionReprompt(parentRunId, () => true);
	markNestedAsyncFinished(parentRunId, groupRunId);
	assert.equal(nestedAsyncParentSnapshot(parentRunId)?.pendingReprompts, 1);
	releaseNestedAsyncParent(parentRunId);
});

it("clears speculative parent activity when a completion reprompt cannot be queued", async () => {
	const parentRunId = "run-failed-reprompt";
	registerNestedAsyncParent(parentRunId);
	enqueueNestedCompletionReprompt(parentRunId, () => false);

	await flushNestedCompletionReprompts(parentRunId);
	assert.deepEqual(nestedAsyncParentSnapshot(parentRunId), {
		active: false,
		agentInFlight: false,
		pendingReprompts: 0,
		version: 2,
	});
	releaseNestedAsyncParent(parentRunId);
});

it("clears a failed completion reprompt when a descendant finishes during delivery", async () => {
	const parentRunId = "run-failed-reprompt-with-descendant";
	let finishDelivery!: () => void;
	const deliveryGate = new Promise<void>((resolve) => {
		finishDelivery = resolve;
	});
	registerNestedAsyncParent(parentRunId);
	markNestedAsyncStarted(parentRunId, "run-finishing-descendant");
	enqueueNestedCompletionReprompt(parentRunId, async () => {
		await deliveryGate;
		return false;
	});

	const flush = flushNestedCompletionReprompts(parentRunId);
	markNestedAsyncFinished(parentRunId, "run-finishing-descendant");
	finishDelivery();
	await flush;

	assert.equal(nestedAsyncParentSnapshot(parentRunId)?.active, false);
	assert.equal(nestedAsyncParentSnapshot(parentRunId)?.agentInFlight, false);
	releaseNestedAsyncParent(parentRunId);
});

it("cancels nested descendants and drops pending reprompts when the parent is released", () => {
	const parentRunId = "run-cancel-nested-parent";
	let cancelCalls = 0;
	let repromptCalls = 0;
	registerNestedAsyncParent(parentRunId);
	registerNestedAsyncCancellation(parentRunId, () => cancelCalls++);
	enqueueNestedCompletionReprompt(parentRunId, () => {
		repromptCalls++;
		return true;
	});

	releaseNestedAsyncParent(parentRunId);
	assert.equal(cancelCalls, 1);
	assert.equal(repromptCalls, 0);
});

it("ignores late nested completion and parent turn events after release", () => {
	const parentRunId = "run-released-nested-parent";
	registerNestedAsyncParent(parentRunId);
	releaseNestedAsyncParent(parentRunId);

	markNestedAsyncFinished(parentRunId, "run-late-child");
	markNestedParentTurn(parentRunId, true);

	assert.equal(nestedAsyncParentSnapshot(parentRunId), null);
});

it("retains an idle parent, parks its leaf permit, and disposes after its nested completion turn", async () => {
	leafConcurrencyLimit(1);
	const parentRunId = "run-nested-parent";
	let parentPromptSettled!: () => void;
	const promptSettled = new Promise<void>((resolve) => {
		parentPromptSettled = resolve;
	});
	const parentSession = new FakeAgentSession(async (self) => {
		registerNestedAsyncParent(parentRunId);
		markNestedAsyncStarted(parentRunId, "run-descendant");
		registerNestedAsyncCancellation(parentRunId, () => cancelCalls++);
		self.lastAssistantText = "<output>waiting</output>";
		parentPromptSettled();
	});
	const siblingSession = new FakeAgentSession(async (self) => {
		self.lastAssistantText = "<output>sibling</output>";
	});
	installFakeRuntime([parentSession, siblingSession]);
	let cancelCalls = 0;

	const parent = runChildAgent(makeStep({ runId: parentRunId }), makeContext());
	await promptSettled;
	assert.equal(parentSession.disposeCalls, 0);

	const sibling = await runChildAgent(makeStep({ runId: "run-sibling" }), makeContext());
	assert.equal(sibling.state, "complete");

	let reprompted = false;
	markNestedAsyncFinished(parentRunId, "run-descendant");
	enqueueNestedCompletionReprompt(parentRunId, () => {
		reprompted = true;
		queueMicrotask(() => markNestedParentTurn(parentRunId, false));
		return true;
	});
	const result = await parent;
	assert.equal(result.state, "complete");
	assert.equal(reprompted, true);
	assert.equal(parentSession.disposeCalls, 1);
	assert.equal(cancelCalls, 1);
	assert.equal(nestedAsyncParentSnapshot(parentRunId), null);
});

it("refreshes retained parent activity when an active async descendant progresses", async () => {
	leafConcurrencyLimit(1);
	const parentRunId = "run-progress-parent";
	const descendantRunId = "run-progress-descendant";
	let parentPromptSettled!: () => void;
	const promptSettled = new Promise<void>((resolve) => {
		parentPromptSettled = resolve;
	});
	const parentSession = new FakeAgentSession(async (self) => {
		registerNestedAsyncParent(parentRunId);
		markNestedAsyncStarted(parentRunId, descendantRunId);
		self.lastAssistantText = "<output>waiting</output>";
		parentPromptSettled();
	});
	const siblingSession = new FakeAgentSession(async (self) => {
		self.lastAssistantText = "<output>sibling</output>";
	});
	installFakeRuntime([parentSession, siblingSession]);
	const patches: Array<{ activity?: { updatedAt?: number } }> = [];

	const parent = runChildAgent(
		makeStep({ runId: parentRunId }),
		makeContext({ onStatusUpdate: (patch) => patches.push(patch) }),
	);
	await promptSettled;
	assert.equal((await runChildAgent(makeStep({ runId: "run-progress-sibling" }), makeContext())).state, "complete");
	const beforeProgress = patches.length;
	const versionBefore = nestedAsyncParentSnapshot(parentRunId)?.version;
	markNestedAsyncProgress(descendantRunId);
	assert.equal(nestedAsyncParentSnapshot(parentRunId)?.version, (versionBefore ?? 0) + 1);
	await new Promise<void>((resolve) => setImmediate(resolve));

	assert.equal(patches.length, beforeProgress + 1);
	assert.equal(typeof patches.at(-1)?.activity?.updatedAt, "number");
	markNestedAsyncFinished(parentRunId, descendantRunId);
	assert.equal((await parent).state, "complete");
});

/** Poll until `check` holds or the timeout elapses; the caller asserts the outcome. */
async function waitForAtMost(check: () => boolean, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!check() && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

interface RecordedPatch {
	activity?: { updatedAt?: number };
}

/** Settle the microtask chain so one descendant patch finishes bubbling to every ancestor. */
async function settleBubbling(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(() => setImmediate(resolve)));
}

it("keeps every ancestor fresh while a deep descendant works quietly in an engaged phase", async () => {
	leafConcurrencyLimit(4);
	const topRunId = "run-deep-top";
	const midRunId = "run-deep-mid";
	const leafRunId = "run-deep-leaf";
	let settleMidPrompt!: () => void;
	const midPromptSettled = new Promise<void>((resolve) => {
		settleMidPrompt = resolve;
	});
	let signalLeafEngaged!: () => void;
	const leafEngaged = new Promise<void>((resolve) => {
		signalLeafEngaged = resolve;
	});
	let releaseLeaf!: () => void;
	const leafGate = new Promise<void>((resolve) => {
		releaseLeaf = resolve;
	});
	const leafSession = new FakeAgentSession(async (self) => {
		self.emit({ type: "tool_execution_start", toolName: "bash" });
		signalLeafEngaged();
		await leafGate;
		self.emit({ type: "tool_execution_end", toolName: "bash" });
		self.lastAssistantText = "<output>leaf-done</output>";
	});
	// Only mid's own executor patches reach midPatches (the leaf dispatch records nothing),
	// so the stamp-count assertions below measure mid's own liveness, not the leaf's traffic.
	const midPatches: RecordedPatch[] = [];
	const midSession = new FakeAgentSession(async (self) => {
		registerNestedAsyncParent(midRunId);
		dispatchAsyncChild(makeStep({ runId: leafRunId }), makeContext());
		markNestedAsyncStarted(midRunId, leafRunId);
		self.lastAssistantText = "<output>mid-dispatched</output>";
		settleMidPrompt();
	});
	const topSession = new FakeAgentSession(async (self) => {
		registerNestedAsyncParent(topRunId);
		dispatchAsyncChild(
			makeStep({ runId: midRunId }),
			makeContext({ onStatusUpdate: (patch) => midPatches.push(patch) }),
		);
		markNestedAsyncStarted(topRunId, midRunId);
		self.lastAssistantText = "<output>top-dispatched</output>";
	});
	installFakeRuntime([topSession, midSession, leafSession]);
	const topPatches: RecordedPatch[] = [];

	const top = runChildAgent(
		makeStep({ runId: topRunId }),
		makeContext({ onStatusUpdate: (patch) => topPatches.push(patch) }),
	);
	await midPromptSettled;
	await leafEngaged;
	await settleBubbling();

	// Baseline: the leaf's tool_execution_start instant already bubbled one stamp per level.
	const topVersionBefore = nestedAsyncParentSnapshot(topRunId)?.version ?? 0;
	const midVersionBefore = nestedAsyncParentSnapshot(midRunId)?.version ?? 0;
	const topStampsBefore = topPatches.filter((patch) => patch.activity !== undefined).length;
	const midStampsBefore = midPatches.filter((patch) => patch.activity !== undefined).length;

	// The leaf stays quiet inside its sustained tool phase; its engagement must keep
	// refreshing mid AND top through the parked parents (deep subtree activity).
	await waitForAtMost(() => (nestedAsyncParentSnapshot(topRunId)?.version ?? 0) > topVersionBefore, 9_000);

	assert.ok(
		(nestedAsyncParentSnapshot(midRunId)?.version ?? 0) > midVersionBefore,
		"mid parent must be woken by the leaf's engaged quiet tick",
	);
	assert.ok(
		(nestedAsyncParentSnapshot(topRunId)?.version ?? 0) > topVersionBefore,
		"top ancestor must be woken through the parked mid parent",
	);
	assert.ok(
		midPatches.filter((patch) => patch.activity !== undefined).length > midStampsBefore,
		"parked mid parent must stamp fresh activity while its descendant works",
	);
	assert.ok(
		topPatches.filter((patch) => patch.activity !== undefined).length > topStampsBefore,
		"top ancestor must stamp fresh activity while its grandchild works",
	);

	releaseLeaf();
	markNestedAsyncFinished(midRunId, leafRunId);
	markNestedAsyncFinished(topRunId, midRunId);
	assert.equal((await top).state, "complete");
});

it("bubbles sustained descendant activity through a parallel group container without skipping a level", async () => {
	leafConcurrencyLimit(4);
	const topRunId = "run-group-top";
	const midRunId = "run-group-mid";
	const leafRunId = "run-group-leaf";
	const groupRunId = "run-group-container";
	let settleMidPrompt!: () => void;
	const midPromptSettled = new Promise<void>((resolve) => {
		settleMidPrompt = resolve;
	});
	let signalLeafEngaged!: () => void;
	const leafEngaged = new Promise<void>((resolve) => {
		signalLeafEngaged = resolve;
	});
	let releaseLeaf!: () => void;
	const leafGate = new Promise<void>((resolve) => {
		releaseLeaf = resolve;
	});
	const leafSession = new FakeAgentSession(async (self) => {
		self.emit({ type: "tool_execution_start", toolName: "bash" });
		signalLeafEngaged();
		await leafGate;
		self.emit({ type: "tool_execution_end", toolName: "bash" });
		self.lastAssistantText = "<output>leaf-done</output>";
	});
	const midSession = new FakeAgentSession(async (self) => {
		registerNestedAsyncParent(midRunId);
		// Parallel/async group shape: the rollup registers the group id while per-child
		// started events register child run ids, exactly like run-async-path.
		holdNestedAsyncRollup(midRunId, groupRunId);
		dispatchAsyncChild(makeStep({ runId: leafRunId }), makeContext());
		markNestedAsyncStarted(midRunId, leafRunId);
		self.lastAssistantText = "<output>mid-dispatched</output>";
		settleMidPrompt();
	});
	const topSession = new FakeAgentSession(async (self) => {
		registerNestedAsyncParent(topRunId);
		dispatchAsyncChild(makeStep({ runId: midRunId }), makeContext());
		markNestedAsyncStarted(topRunId, midRunId);
		self.lastAssistantText = "<output>top-dispatched</output>";
	});
	installFakeRuntime([topSession, midSession, leafSession]);
	const topPatches: RecordedPatch[] = [];

	const top = runChildAgent(
		makeStep({ runId: topRunId }),
		makeContext({ onStatusUpdate: (patch) => topPatches.push(patch) }),
	);
	await midPromptSettled;
	await leafEngaged;
	await settleBubbling();

	const topVersionBefore = nestedAsyncParentSnapshot(topRunId)?.version ?? 0;
	const midVersionBefore = nestedAsyncParentSnapshot(midRunId)?.version ?? 0;
	const topStampsBefore = topPatches.filter((patch) => patch.activity !== undefined).length;

	await waitForAtMost(() => (nestedAsyncParentSnapshot(topRunId)?.version ?? 0) > topVersionBefore, 9_000);

	assert.ok(
		(nestedAsyncParentSnapshot(midRunId)?.version ?? 0) > midVersionBefore,
		"group container must not break the mid parent's wake chain",
	);
	assert.ok(
		(nestedAsyncParentSnapshot(topRunId)?.version ?? 0) > topVersionBefore,
		"top ancestor must be woken through the group container",
	);
	assert.ok(
		topPatches.filter((patch) => patch.activity !== undefined).length > topStampsBefore,
		"top ancestor must stamp fresh activity through the group container",
	);

	releaseLeaf();
	// The leaf completes first (its child id empties mid's active set), then the
	// rollup releases its group id — otherwise mid stays held on the unfinished
	// child registration and its settle loop keeps cycling.
	markNestedAsyncFinished(midRunId, leafRunId);
	markNestedAsyncFinished(midRunId, groupRunId);
	markNestedAsyncFinished(topRunId, midRunId);
	assert.equal((await top).state, "complete");
});

it("keeps a parked parent's liveness fresh while its whole subtree is active but silent", async () => {
	leafConcurrencyLimit(4);
	const topRunId = "run-silent-top";
	const midRunId = "run-silent-mid";
	const leafRunId = "run-silent-leaf";
	let settleMidPrompt!: () => void;
	const midPromptSettled = new Promise<void>((resolve) => {
		settleMidPrompt = resolve;
	});
	let signalLeafParked!: () => void;
	const leafParked = new Promise<void>((resolve) => {
		signalLeafParked = resolve;
	});
	let releaseLeaf!: () => void;
	const leafGate = new Promise<void>((resolve) => {
		releaseLeaf = resolve;
	});
	// The leaf produces no session events at all while it works: the parked ancestors
	// must keep stamping activity on their own keep-alive, or the async control loop
	// reports "no observed activity" against a subtree that is demonstrably working.
	const leafSession = new FakeAgentSession(async () => {
		signalLeafParked();
		await leafGate;
	});
	const midPatches: RecordedPatch[] = [];
	const midSession = new FakeAgentSession(async (self) => {
		registerNestedAsyncParent(midRunId);
		dispatchAsyncChild(makeStep({ runId: leafRunId }), makeContext());
		markNestedAsyncStarted(midRunId, leafRunId);
		self.lastAssistantText = "<output>mid-dispatched</output>";
		settleMidPrompt();
	});
	const topSession = new FakeAgentSession(async (self) => {
		registerNestedAsyncParent(topRunId);
		// mid's own executor patches (incl. settle-loop stamps) land in midPatches via
		// top's dispatch recorder; the leaf emits nothing, so any new liveness there is
		// the parked parents' own keep-alive, not traffic from below.
		dispatchAsyncChild(
			makeStep({ runId: midRunId }),
			makeContext({ onStatusUpdate: (patch) => midPatches.push(patch) }),
		);
		markNestedAsyncStarted(topRunId, midRunId);
		self.lastAssistantText = "<output>top-dispatched</output>";
	});
	installFakeRuntime([topSession, midSession, leafSession]);
	const topPatches: RecordedPatch[] = [];

	const top = runChildAgent(
		makeStep({ runId: topRunId }),
		makeContext({ onStatusUpdate: (patch) => topPatches.push(patch) }),
	);
	await midPromptSettled;
	await leafParked;
	await settleBubbling();

	const midActivityBefore = midPatches.filter((patch) => patch.activity !== undefined).length;
	const topActivityBefore = topPatches.filter((patch) => patch.activity !== undefined).length;

	// Nothing below emits, so only the parked parents' own keep-alive can refresh
	// lastActivityAt: activity stamps must keep arriving while the subtree is held.
	await waitForAtMost(
		() => midPatches.filter((patch) => patch.activity !== undefined).length > midActivityBefore,
		9_000,
	);

	assert.ok(
		midPatches.filter((patch) => patch.activity !== undefined).length > midActivityBefore,
		"parked mid parent must keep stamping activity while its subtree is active",
	);
	assert.ok(
		topPatches.filter((patch) => patch.activity !== undefined).length > topActivityBefore,
		"top ancestor must stay activity-fresh through the parked mid parent",
	);
	assert.equal(topSession.disposeCalls, 0, "held ancestors must not be disposed while the subtree works");
	assert.equal(midSession.disposeCalls, 0, "held middle parent must not be disposed while the subtree works");

	releaseLeaf();
	markNestedAsyncFinished(midRunId, leafRunId);
	markNestedAsyncFinished(topRunId, midRunId);
	assert.equal((await top).state, "complete");
});

it("does not accumulate abandoned change-waits across quiet keep-alive ticks", async () => {
	leafConcurrencyLimit(4);
	restoreFns.push(__setNestedParkKeepAliveForTest(60));
	const parentRunId = "run-quiet-ticks-parent";
	const leafRunId = "run-quiet-ticks-leaf";
	let settleParentPrompt!: () => void;
	const parentPromptSettled = new Promise<void>((resolve) => {
		settleParentPrompt = resolve;
	});
	let signalLeafParked!: () => void;
	const leafParked = new Promise<void>((resolve) => {
		signalLeafParked = resolve;
	});
	let releaseLeaf!: () => void;
	const leafGate = new Promise<void>((resolve) => {
		releaseLeaf = resolve;
	});
	const leafSession = new FakeAgentSession(async () => {
		signalLeafParked();
		await leafGate;
	});
	const parentSession = new FakeAgentSession(async (self) => {
		registerNestedAsyncParent(parentRunId);
		dispatchAsyncChild(makeStep({ runId: leafRunId }), makeContext());
		markNestedAsyncStarted(parentRunId, leafRunId);
		self.lastAssistantText = "<output>waiting</output>";
		settleParentPrompt();
	});
	installFakeRuntime([parentSession, leafSession]);
	const patches: RecordedPatch[] = [];

	const parent = runChildAgent(
		makeStep({ runId: parentRunId }),
		makeContext({ onStatusUpdate: (patch) => patches.push(patch) }),
	);
	await parentPromptSettled;
	await leafParked;

	// Each quiet cadence wake re-stamps activity; three stamps prove three
	// keep-alive cycles ran and (pre-fix) three change-waits were abandoned.
	const stampsBefore = patches.filter((patch) => patch.activity !== undefined).length;
	await waitForAtMost(
		() => patches.filter((patch) => patch.activity !== undefined).length >= stampsBefore + 3,
		5_000,
	);
	assert.ok(
		patches.filter((patch) => patch.activity !== undefined).length >= stampsBefore + 3,
		"at least three keep-alive cycles must have run",
	);
	assert.ok(
		__nestedAsyncWaiterCountForTest(parentRunId) <= 1,
		`a quiet hold must keep at most the current change-wait registered (got ${__nestedAsyncWaiterCountForTest(parentRunId)})`,
	);

	releaseLeaf();
	markNestedAsyncFinished(parentRunId, leafRunId);
	assert.equal((await parent).state, "complete");
	assert.equal(__nestedAsyncWaiterCountForTest(parentRunId), 0, "release must drain every waiter");
});

it("stops keeping a parent fresh once its descendant subtree settles, and exits exactly once", async () => {
	const parentRunId = "run-settles-after-subtree";
	const descendantRunId = "run-settles-descendant";
	let settleParentPrompt!: () => void;
	const parentPromptSettled = new Promise<void>((resolve) => {
		settleParentPrompt = resolve;
	});
	const parentSession = new FakeAgentSession(async (self) => {
		registerNestedAsyncParent(parentRunId);
		markNestedAsyncStarted(parentRunId, descendantRunId);
		self.lastAssistantText = "<output>waiting</output>";
		settleParentPrompt();
	});
	const siblingSession = new FakeAgentSession(async (self) => {
		self.lastAssistantText = "<output>sibling</output>";
	});
	installFakeRuntime([parentSession, siblingSession]);
	const patches: RecordedPatch[] = [];

	const parent = runChildAgent(
		makeStep({ runId: parentRunId }),
		makeContext({ onStatusUpdate: (patch) => patches.push(patch) }),
	);
	await parentPromptSettled;

	let reprompted = false;
	markNestedAsyncFinished(parentRunId, descendantRunId);
	enqueueNestedCompletionReprompt(parentRunId, () => {
		reprompted = true;
		queueMicrotask(() => markNestedParentTurn(parentRunId, false));
		return true;
	});
	const result = await parent;
	assert.equal(result.state, "complete");
	assert.equal(reprompted, true);
	assert.equal(parentSession.disposeCalls, 1, "a settled parent must dispose exactly once");
	assert.equal(nestedAsyncParentSnapshot(parentRunId), null);

	// A terminal descendant must not keep the parent's record alive: after the subtree
	// settles, no further activity stamps may land on the parent's run record.
	const stampsAfterSettle = patches.filter((patch) => patch.activity !== undefined).length;
	await new Promise((resolve) => setTimeout(resolve, 300));
	assert.equal(patches.filter((patch) => patch.activity !== undefined).length, stampsAfterSettle);
	// A follow-on run must still acquire a leaf permit: a settled hold may not leak the parked slot.
	assert.equal(
		(await runChildAgent(makeStep({ runId: "run-after-settled-parent" }), makeContext())).state,
		"complete",
	);
});

it("holds a failing parent until its active subtree settles before finalizing", async () => {
	leafConcurrencyLimit(4);
	const parentRunId = "run-fail-hold-parent";
	const leafRunId = "run-fail-hold-leaf";
	// Ordered lifecycle events: the parent must not report terminal failure (or
	// dispose its session) while its descendant subtree is still active.
	const order: string[] = [];
	// Production registration wiring (extension-runtime session listeners):
	// started/complete events on the dispatching session's bus drive the marks.
	const events = new EventEmitter();
	events.on(SUBAGENT_ASYNC_STARTED_EVENT, (data: { runId?: string }) => {
		if (data.runId) markNestedAsyncStarted(parentRunId, data.runId);
	});
	events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, (data: { runId?: string }) => {
		if (data.runId) markNestedAsyncFinished(parentRunId, data.runId);
	});
	const pi = { events } as never;

	const leafSession = new FakeAgentSession(async (self) => {
		// Outlives the parent's prompt resolution: the parent fails while the leaf
		// is mid-flight, so only a settled hold keeps the leaf alive to complete.
		await new Promise((resolve) => setTimeout(resolve, 150));
		self.lastAssistantText = "<output>leaf-done</output>";
	});
	let leafResult: ChildAgentResult | undefined;
	let settleLeafDone!: () => void;
	const leafDone = new Promise<void>((resolve) => {
		settleLeafDone = resolve;
	});
	const finalizeLeaf = async (handle: ChildAgentHandle): Promise<void> => {
		const result = await handle.completed;
		leafResult = result;
		// run-async-path finalize: the dispatching parent's bus learns the child ended.
		safeEmit(SUBAGENT_ASYNC_COMPLETE_EVENT, { id: handle.runId, runId: handle.runId, state: result.state }, pi);
		settleLeafDone();
	};
	const leafAbort = new AbortController();
	const parentSession = new FakeAgentSession(async (self) => {
		// session_start equivalent: the child session registers its own run id...
		registerNestedAsyncParent(parentRunId);
		// ...then dispatches a descendant the production way: dispatch primitive,
		// started event on the session bus, and cancellation wiring (run-async-path's
		// single-dispatch shape).
		const leafHandle = dispatchAsyncChild(
			makeStep({ runId: leafRunId }),
			makeContext({
				pi,
				abortSignal: leafAbort.signal,
				onStatusUpdate: (patch) => {
					if (patch.state === "complete") order.push("leaf:complete");
				},
			}),
		);
		registerNestedAsyncCancellation(parentRunId, () => leafAbort.abort());
		safeEmit(SUBAGENT_ASYNC_STARTED_EVENT, { id: leafRunId, runId: leafRunId }, pi);
		void finalizeLeaf(leafHandle);
		// The prompt fails like a swallowed provider error: last assistant outcome
		// carries stopReason "error" (detectProviderFailure's read).
		self.messages.push({ role: "assistant", stopReason: "error", errorMessage: "provider down" });
	});
	parentSession.disposeImpl = () => order.push("parent:disposed");
	installFakeRuntime([parentSession, leafSession]);
	const patches: RecordedPatch[] = [];

	const result = await runChildAgent(
		makeStep({ runId: parentRunId }),
		makeContext({
			pi,
			onStatusUpdate: (patch) => {
				patches.push(patch);
				if (patch.state === "failed") order.push("parent:failed");
			},
		}),
	);
	await leafDone;
	assert.ok(leafResult, "leaf must have settled");
	assert.equal(leafResult.state, "complete", "a failing parent's release must not cancel its active descendant");
	assert.equal(result.state, "failed");
	assert.equal(result.error?.message, "provider down");
	assert.ok(
		order.indexOf("leaf:complete") !== -1 && order.indexOf("leaf:complete") < order.indexOf("parent:failed"),
		"parent must not report failure while its subtree is active",
	);
	assert.ok(
		order.indexOf("parent:disposed") > order.indexOf("leaf:complete"),
		"parent must not dispose its session while its subtree is active",
	);
	assert.equal(parentSession.disposeCalls, 1, "a held-then-failed parent must dispose exactly once");
	assert.equal(nestedAsyncParentSnapshot(parentRunId), null);
});

it("keeps a failing parent's hold alive when a completion reprompt fails to deliver", async () => {
	leafConcurrencyLimit(4);
	const parentRunId = "run-fail-hold-delivery-parent";
	const leafRunId = "run-fail-hold-delivery-leaf";
	const order: string[] = [];
	const failedPatches: RecordedPatch[] = [];
	const events = new EventEmitter();
	events.on(SUBAGENT_ASYNC_STARTED_EVENT, (data: { runId?: string }) => {
		if (data.runId) markNestedAsyncStarted(parentRunId, data.runId);
	});
	events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, (data: { runId?: string }) => {
		if (data.runId) markNestedAsyncFinished(parentRunId, data.runId);
	});
	const pi = { events } as never;

	const leafSession = new FakeAgentSession(async (self) => {
		await new Promise((resolve) => setTimeout(resolve, 150));
		self.lastAssistantText = "<output>leaf-done</output>";
	});
	let leafResult: ChildAgentResult | undefined;
	let settleLeafDone!: () => void;
	const leafDone = new Promise<void>((resolve) => {
		settleLeafDone = resolve;
	});
	const finalizeLeaf = async (handle: ChildAgentHandle): Promise<void> => {
		const result = await handle.completed;
		leafResult = result;
		safeEmit(SUBAGENT_ASYNC_COMPLETE_EVENT, { id: handle.runId, runId: handle.runId, state: result.state }, pi);
		settleLeafDone();
	};
	const leafAbort = new AbortController();
	const parentSession = new FakeAgentSession(async (self) => {
		registerNestedAsyncParent(parentRunId);
		const leafHandle = dispatchAsyncChild(
			makeStep({ runId: leafRunId }),
			makeContext({
				pi,
				abortSignal: leafAbort.signal,
				onStatusUpdate: (patch) => {
					if (patch.state === "complete") order.push("leaf:complete");
				},
			}),
		);
		registerNestedAsyncCancellation(parentRunId, () => leafAbort.abort());
		safeEmit(SUBAGENT_ASYNC_STARTED_EVENT, { id: leafRunId, runId: leafRunId }, pi);
		void finalizeLeaf(leafHandle);
		// The descendant's completion nudge cannot reach the failing parent's
		// session: the send reports failure while the leaf is still working.
		enqueueNestedCompletionReprompt(parentRunId, async () => false);
		self.messages.push({ role: "assistant", stopReason: "error", errorMessage: "provider down" });
	});
	installFakeRuntime([parentSession, leafSession]);
	const patches: RecordedPatch[] = [];

	const result = await runChildAgent(
		makeStep({ runId: parentRunId }),
		makeContext({
			pi,
			onStatusUpdate: (patch) => {
				patches.push(patch);
				if (patch.state === "failed") {
					failedPatches.push(patch);
					order.push("parent:failed");
				}
			},
		}),
	);
	await leafDone;
	assert.ok(leafResult, "leaf must have settled");
	assert.equal(
		leafResult.state,
		"complete",
		"a failed reprompt delivery during a failure-hold must not cancel the active subtree",
	);
	assert.equal(result.state, "failed");
	assert.equal(result.error?.message, "provider down", "the original failure must stay terminal");
	assert.ok(
		!/deliver/i.test(result.error?.message ?? ""),
		"delivery failure must not mask the original failure",
	);
	assert.equal(failedPatches.length, 1, "the parent must report its failure exactly once");
	assert.ok(
		order.indexOf("leaf:complete") !== -1 && order.indexOf("leaf:complete") < order.indexOf("parent:failed"),
		"parent must not report failure while its subtree is active",
	);
	assert.equal(nestedAsyncParentSnapshot(parentRunId), null);
});

it("keeps cascade-cancel semantics when a parent is explicitly aborted", async () => {
	leafConcurrencyLimit(4);
	const parentRunId = "run-abort-cascade-parent";
	const leafRunId = "run-abort-cascade-leaf";
	const events = new EventEmitter();
	events.on(SUBAGENT_ASYNC_STARTED_EVENT, (data: { runId?: string }) => {
		if (data.runId) markNestedAsyncStarted(parentRunId, data.runId);
	});
	const pi = { events } as never;
	const parentAbort = new AbortController();
	const leafAbort = new AbortController();
	const leafSession = new FakeAgentSession(async () => {
		await new Promise(() => {});
	});
	let leafResult: ChildAgentResult | undefined;
	let settleLeafDone!: () => void;
	const leafDone = new Promise<void>((resolve) => {
		settleLeafDone = resolve;
	});
	const finalizeLeaf = async (handle: ChildAgentHandle): Promise<void> => {
		leafResult = await handle.completed;
		settleLeafDone();
	};
	const parentSession = new FakeAgentSession(async () => {
		registerNestedAsyncParent(parentRunId);
		const leafHandle = dispatchAsyncChild(
			makeStep({ runId: leafRunId }),
			makeContext({ pi, abortSignal: leafAbort.signal }),
		);
		registerNestedAsyncCancellation(parentRunId, () => leafAbort.abort());
		safeEmit(SUBAGENT_ASYNC_STARTED_EVENT, { id: leafRunId, runId: leafRunId }, pi);
		void finalizeLeaf(leafHandle);
		await new Promise(() => {});
	});
	installFakeRuntime([parentSession, leafSession]);

	const parent = runChildAgent(
		makeStep({ runId: parentRunId }),
		makeContext({ pi, abortSignal: parentAbort.signal }),
	);
	await waitForAtMost(() => nestedAsyncParentSnapshot(parentRunId)?.active === true, 2_000);
	parentAbort.abort();

	assert.equal((await parent).state, "interrupted");
	await leafDone;
	assert.ok(leafResult, "leaf must have settled");
	assert.equal(leafResult.state, "interrupted", "explicit abort cascade-cancels active descendants");
});

it("binds extensions before prompting so nested async activation retains the parent", async () => {
	const parentRunId = "run-sdk-faithful-parent";
	const descendantRunId = "run-sdk-faithful-descendant";
	let promptSettled!: () => void;
	const settled = new Promise<void>((resolve) => {
		promptSettled = resolve;
	});
	let activated = false;
	const session = new FakeAgentSession(
		async (self) => {
			if (activated) markNestedAsyncStarted(parentRunId, descendantRunId);
			self.lastAssistantText = "<output>Nested async started.</output>";
			promptSettled();
		},
		async () => {
			activated = true;
			registerNestedAsyncParent(parentRunId);
		},
	);
	installFakeRuntime([session]);
	const parent = runChildAgent(makeStep({ runId: parentRunId }), makeContext());
	await settled;
	await Promise.resolve();

	assert.equal(session.bindExtensionsCalls, 1);
	assert.equal(session.disposeCalls, 0);
	markNestedAsyncFinished(parentRunId, descendantRunId);
	enqueueNestedCompletionReprompt(parentRunId, () => {
		queueMicrotask(() => markNestedParentTurn(parentRunId, false));
		return true;
	});
	assert.equal((await parent).state, "complete");
	assert.equal(session.disposeCalls, 1);
});

it("writes the opened branch preview before prompting", async () => {
	const step = makeStep({ runId: "run-preview-open" });
	const session = new FakeAgentSession(async (self) => {
		assert.match(JSON.stringify(readRunTranscriptPreview(step.sessionFile)), /opened branch/);
		self.lastAssistantText = "<output>done</output>";
	});
	session.messages = [{ role: "user", content: "opened branch", timestamp: 1 }];
	installFakeRuntime([session]);

	assert.equal((await runChildAgent(step, makeContext())).state, "complete");
});

it("updates the registered handle to the reopened fallback session", async () => {
	const primaryCleanup: string[] = [];
	const primarySession = new FakeAgentSession(async (self) => {
		self.messages.push({
			role: "assistant",
			stopReason: "error",
			errorMessage: "HTTP 429 rate limit exceeded",
			content: [],
		});
	});
	primarySession.shutdownHandler = () => {
		primaryCleanup.push("shutdown");
	};
	primarySession.disposeImpl = () => {
		primaryCleanup.push("dispose");
	};
	let markFallbackStarted!: () => void;
	let releaseFallback!: () => void;
	const fallbackStarted = new Promise<void>((resolve) => {
		markFallbackStarted = resolve;
	});
	const fallbackReleased = new Promise<void>((resolve) => {
		releaseFallback = resolve;
	});
	const fallbackSession = new FakeAgentSession(async (self) => {
		markFallbackStarted();
		await fallbackReleased;
		self.messages.push({ role: "assistant", stopReason: "stop", content: [] });
		self.lastAssistantText = "<output>done</output>";
	});
	installFakeRuntime([primarySession, fallbackSession]);
	const directory = new LiveSessionDirectory();
	const handle = dispatchAsyncChild(
		makeStep({ modelCandidates: [{ provider: "test", id: "model-b" } as never] }),
		makeContext(),
	);

	try {
		await fallbackStarted;
		assert.deepEqual(primaryCleanup, ["shutdown", "dispose"]);
		assert.equal(handle.session, fallbackSession as never);
		assert.deepEqual(directory.sessionsForRun("run-1"), [fallbackSession]);
		releaseFallback();
		assert.equal((await handle.completed).state, "complete");
		assert.deepEqual(directory.sessionsForRun("run-1"), []);
	} finally {
		directory.dispose();
	}
});

it("disposes the failed provider session only once when reopening the fallback throws", async () => {
	const primarySession = new FakeAgentSession(async (self) => {
		self.messages.push({
			role: "assistant",
			stopReason: "error",
			errorMessage: "HTTP 429 rate limit exceeded",
			content: [],
		});
	});
	let shutdownCalls = 0;
	primarySession.shutdownHandler = () => {
		shutdownCalls++;
	};
	const fallbackSession = new FakeAgentSession(
		async () => {},
		async () => {
			throw new Error("fallback activation failed");
		},
	);
	installFakeRuntime([primarySession, fallbackSession]);

	const result = await runChildAgent(
		makeStep({ modelCandidates: [{ provider: "test", id: "model-b" } as never] }),
		makeContext(),
	);

	assert.equal(result.state, "failed");
	assert.match(result.error?.message ?? "", /fallback activation failed/);
	assert.equal(shutdownCalls, 1);
	assert.equal(primarySession.disposeCalls, 1);
});

it("continues fallback ordering after startup authentication selects a later candidate", async () => {
	const startupFallbackSession = new FakeAgentSession(async (self) => {
		self.messages.push({
			role: "assistant",
			stopReason: "error",
			errorMessage: "HTTP 429 rate limit exceeded",
			content: [],
		});
	});
	const finalSession = new FakeAgentSession(async (self) => {
		self.messages.push({ role: "assistant", stopReason: "stop", content: [] });
		self.lastAssistantText = "<output>done</output>";
	});
	installFakeRuntime([startupFallbackSession, finalSession], undefined, undefined, [
		new Error("authentication failed for model-a"),
	]);
	const result = await runChildAgent(
		makeStep({
			modelCandidates: [
				{ provider: "test", id: "model-b" } as never,
				{ provider: "test", id: "model-c" } as never,
			],
		}),
		makeContext(),
	);

	assert.equal(result.state, "complete");
	assert.equal(result.model, "test/model-c");
	assert.deepEqual(result.attemptedModels, ["test/model-a", "test/model-b", "test/model-c"]);
	assert.equal(startupFallbackSession.promptCalls, 1);
	assert.equal(finalSession.promptCalls, 1);
});

after(() => {
	for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });
});

type Listener = (event: Record<string, unknown>) => void;

class FakeResourceLoader {
	reloadCount = 0;
	readonly opts: Record<string, unknown>;

	constructor(opts: Record<string, unknown>) {
		this.opts = opts;
	}

	async reload(): Promise<void> {
		this.reloadCount++;
	}
}

class FakeAgentSession {
	listeners: Listener[] = [];
	activeToolNames: string[] = [];
	abortCalls = 0;
	disposeCalls = 0;
	bindExtensionsCalls = 0;
	promptCalls = 0;
	sendCustomMessageCalls: Array<{
		message: Parameters<ChildSessionMessageDelivery>[0];
		options: Parameters<ChildSessionMessageDelivery>[1];
	}> = [];
	sendCustomMessageImpl?: ChildSessionMessageDelivery;
	setModelCalls: Array<{ provider: string; id: string }> = [];
	messages: unknown[] = [];
	lastAssistantText = "";
	exportImpl?: () => Promise<string>;
	disposeImpl?: () => void;
	shutdownHandler?: () => void | Promise<void>;
	readonly promptImpl: (session: FakeAgentSession) => Promise<void>;
	readonly bindExtensionsImpl?: (session: FakeAgentSession) => Promise<void>;
	readonly extensionRunner = {
		hasHandlers: (eventType: string) => eventType === "session_shutdown" && this.shutdownHandler !== undefined,
		emit: async (event: { type: string; reason?: string }) => {
			if (event.type === "session_shutdown") await this.shutdownHandler?.();
		},
	};

	constructor(
		promptImpl: (session: FakeAgentSession) => Promise<void>,
		bindExtensionsImpl?: (session: FakeAgentSession) => Promise<void>,
	) {
		this.promptImpl = promptImpl;
		this.bindExtensionsImpl = bindExtensionsImpl;
	}

	async bindExtensions(_bindings: Record<string, unknown>): Promise<void> {
		this.bindExtensionsCalls++;
		await this.bindExtensionsImpl?.(this);
	}

	subscribe(listener: Listener): () => void {
		this.listeners.push(listener);
		return () => {
			this.listeners = this.listeners.filter((candidate) => candidate !== listener);
		};
	}

	emit(event: Record<string, unknown>): void {
		for (const listener of this.listeners) listener(event);
	}

	async prompt(_text: string, _options: Record<string, unknown>): Promise<void> {
		this.promptCalls++;
		await this.promptImpl(this);
	}

	async sendCustomMessage(
		message: Parameters<ChildSessionMessageDelivery>[0],
		options?: Parameters<ChildSessionMessageDelivery>[1],
	): Promise<void> {
		this.sendCustomMessageCalls.push({ message, options });
		await this.sendCustomMessageImpl?.(message, options);
	}

	async setModel(model: { provider: string; id: string }): Promise<void> {
		this.setModelCalls.push(model);
	}

	async abort(): Promise<void> {
		this.abortCalls++;
	}

	dispose(): void {
		this.disposeCalls++;
		this.disposeImpl?.();
	}

	setActiveToolsByName(names: string[]): void {
		this.activeToolNames = names;
	}

	getLastAssistantText(): string {
		return this.lastAssistantText;
	}

	async exportToHtml(): Promise<string> {
		return this.exportImpl ? await this.exportImpl() : "https://example.test/share";
	}
}

function tempDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	cleanup.push(dir);
	return dir;
}

function makeStep(overrides: Partial<ChildAgentStep> = {}): ChildAgentStep {
	const root = tempDir("pi-in-process-step-");
	return {
		runId: overrides.runId ?? "run-1",
		stepIndex: overrides.stepIndex ?? 0,
		agentName: "fixer",
		agentConfig: {
			name: "fixer",
			description: "Fix things",
			systemPromptMode: "replace",
			inheritProjectContext: false,
			inheritSkills: false,
			systemPrompt: "You fix things.",
			source: "builtin",
			filePath: "fixer.md",
		},
		task: "Do it",
		cwd: root,
		model: { provider: "test", id: "model-a" } as never,
		modelCandidates: [],
		activeToolNames: ["read", "bash"],
		systemPrompt: "You fix things.",
		skillsResolved: [],
		sessionFile: path.join(root, "run-1", "run-0", "session.jsonl"),
		runRecordDir: path.join(root, "run-1", "run-0"),
		maxSubagentDepth: 2,
		shareEnabled: false,
		...overrides,
	};
}

function makeContext(overrides: Partial<ChildAgentContext> = {}): ChildAgentContext {
	return {
		extensionCtx: { modelRegistry: { name: "registry" } } as never,
		abortSignal: new AbortController().signal,
		registry: new ChildAgentRegistry(),
		pi: {} as never,
		...overrides,
	};
}

function installFakeRuntime(
	sessions: FakeAgentSession[],
	createHook?: () => void,
	childSessionId?: string | ((sessionFile: string) => string | undefined),
	createErrors: Error[] = [],
	ResourceLoader: typeof FakeResourceLoader = FakeResourceLoader,
): void {
	const restore = __setChildAgentExecutorDepsForTest({
		DefaultResourceLoader: ResourceLoader as never,
		getAgentDir: () => "/tmp/pi-agent",
		SessionManager: {
			open: (file: string) =>
				({
					file,
					getSessionId: () => (typeof childSessionId === "function" ? childSessionId(file) : childSessionId),
				}) as never,
		},
		createAgentSession: async () => {
			createHook?.();
			const createError = createErrors.shift();
			if (createError) throw createError;
			const session = sessions.shift();
			if (!session) throw new Error("No fake session queued");
			return { session: session as never, extensionsResult: { extensions: [], diagnostics: [] } } as never;
		},
	});
	restoreFns.push(restore);
}

describe("runChildAgent", () => {
	it("inherits a parent runtime-only API key for an in-process child", async () => {
		const session = new FakeAgentSession(async (self) => {
			self.lastAssistantText = "<output>done</output>";
		});
		let childKey: string | undefined;
		Object.defineProperty(session, "modelRuntime", {
			value: {
				getRegisteredProviderIds: () => [],
				getAuth: async () => {
					throw new Error("stored OAuth refresh failed");
				},
				setRuntimeApiKey: async (_provider: string, key: string) => {
					childKey = key;
				},
			},
		});
		installFakeRuntime([session]);
		const ctx = makeContext({
			extensionCtx: {
				modelRegistry: {
					getApiKeyForProvider: async () => "parent-runtime-key",
					getProviderAuthStatus: () => ({ configured: true, source: "runtime" }),
				},
			} as never,
		});
		const step = makeStep({ model: { provider: "openai", id: "gpt-4o" } as never });

		assert.equal((await runChildAgent(step, ctx)).state, "complete");
		assert.equal(childKey, "parent-runtime-key");
	});

	it("carries a parent-only provider registration into the child runtime", async () => {
		const config = { name: "Parent-only provider" };
		let registered: unknown;
		const session = new FakeAgentSession(async (self) => {
			self.lastAssistantText = "<output>done</output>";
		});
		Object.defineProperty(session, "modelRuntime", {
			value: {
				getRegisteredProviderIds: () => [],
				registerProvider: (provider: string, value: unknown) => {
					assert.equal(provider, "parent-only");
					registered = value;
				},
			},
		});
		installFakeRuntime([session]);
		const ctx = makeContext({
			extensionCtx: {
				modelRegistry: {
					getApiKeyForProvider: async () => undefined,
					getRegisteredProviderConfig: () => config,
					getRegisteredNativeProvider: () => undefined,
				},
			} as never,
		});
		const step = makeStep({ model: { provider: "parent-only", id: "model-a" } as never });

		assert.equal((await runChildAgent(step, ctx)).state, "complete");
		assert.equal(registered, config);
	});

	it("keeps stored OAuth auth when replaying a native provider before availability refresh", async () => {
		const native = { id: "parent-oauth" };
		let registered = false;
		let runtimeKeySet = false;
		const session = new FakeAgentSession(async (self) => {
			self.lastAssistantText = "<output>done</output>";
		});
		Object.defineProperty(session, "modelRuntime", {
			value: {
				getRegisteredProviderIds: () => [],
				registerNativeProvider: (value: unknown) => {
					assert.equal(value, native);
					registered = true;
				},
				hasConfiguredAuth: () => false,
				getAuth: async () => ({ auth: { apiKey: "child-oauth-key" } }),
				setRuntimeApiKey: async () => {
					runtimeKeySet = true;
				},
			},
		});
		installFakeRuntime([session]);
		const ctx = makeContext({
			extensionCtx: {
				modelRegistry: {
					getRegisteredNativeProvider: () => native,
					getApiKeyForProvider: async () => "parent-oauth-key",
					getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
				},
			} as never,
		});
		const step = makeStep({ model: { provider: "parent-oauth", id: "model-a" } as never });

		assert.equal((await runChildAgent(step, ctx)).state, "complete");
		assert.equal(registered, true);
		assert.equal(runtimeKeySet, false);
	});

	it("disposes an extension-bound session when runtime key setup fails before fallback", async () => {
		const cleanup: string[] = [];
		const failed = new FakeAgentSession(async () => {});
		failed.shutdownHandler = () => {
			cleanup.push("shutdown");
		};
		failed.disposeImpl = () => {
			cleanup.push("dispose");
		};
		Object.defineProperty(failed, "modelRuntime", {
			value: {
				getRegisteredProviderIds: () => [],
				getAuth: async () => undefined,
				setRuntimeApiKey: async () => {
					throw new Error("API key synchronization failed");
				},
			},
		});
		const fallback = new FakeAgentSession(async (self) => {
			self.lastAssistantText = "<output>done</output>";
		});
		Object.defineProperty(fallback, "modelRuntime", {
			value: {
				getRegisteredProviderIds: () => [],
				getAuth: async () => undefined,
				setRuntimeApiKey: async () => {},
			},
		});
		installFakeRuntime([failed, fallback]);
		const ctx = makeContext({
			extensionCtx: {
				modelRegistry: { getApiKeyForProvider: async () => "parent-runtime-key" },
			} as never,
		});
		const result = await runChildAgent(
			makeStep({ modelCandidates: [{ provider: "test", id: "model-b" } as never] }),
			ctx,
		);

		assert.equal(result.state, "complete");
		assert.deepEqual(cleanup, ["shutdown", "dispose"]);
		assert.equal(failed.disposeCalls, 1);
	});

	it("runs child lifecycle shutdown before dispose invalidates its live tracker context", async () => {
		let stale = false;
		let contextAccesses = 0;
		let staleAccesses = 0;
		const context = {
			get hasUI() {
				contextAccesses++;
				if (stale) throw new Error("stale context accessed");
				return false;
			},
		};
		const timer = setInterval(() => {
			try {
				context.hasUI;
			} catch {
				staleAccesses++;
			}
		}, 1);
		const session = new FakeAgentSession(async (self) => {
			self.lastAssistantText = "<output>done</output>";
		});
		session.shutdownHandler = () => clearInterval(timer);
		session.disposeImpl = () => {
			stale = true;
		};
		installFakeRuntime([session]);

		try {
			assert.equal(
				(await runChildAgent(makeStep({ runId: "lifecycle-before-dispose" }), makeContext())).state,
				"complete",
			);
			const accessesAtDispose = contextAccesses;
			await new Promise((resolve) => setTimeout(resolve, 20));

			assert.equal(contextAccesses, accessesAtDispose);
			assert.equal(staleAccesses, 0);
			assert.equal(session.disposeCalls, 1);
		} finally {
			clearInterval(timer);
		}
	});

	it("publishes only a created session and unpublishes it after completion", async () => {
		let markPromptStarted!: () => void;
		let releasePrompt!: () => void;
		const promptStarted = new Promise<void>((resolve) => {
			markPromptStarted = resolve;
		});
		const promptReleased = new Promise<void>((resolve) => {
			releasePrompt = resolve;
		});
		const session = new FakeAgentSession(async (self) => {
			markPromptStarted();
			await promptReleased;
			self.lastAssistantText = "<output>done</output>";
		});
		installFakeRuntime([session]);
		const directory = new LiveSessionDirectory();
		const handle = dispatchAsyncChild(makeStep({ runId: "relay-complete" }), makeContext());

		try {
			assert.deepEqual(directory.sessionsForRun("relay-complete"), []);
			await promptStarted;
			assert.deepEqual(directory.sessionsForRun("relay-complete"), [session]);
			releasePrompt();
			assert.equal((await handle.completed).state, "complete");
			assert.deepEqual(directory.sessionsForRun("relay-complete"), []);
		} finally {
			directory.dispose();
		}
	});

	it("does not leak a relay entry when session creation fails", async () => {
		installFakeRuntime([], undefined, undefined, [new Error("session create failed")]);
		const directory = new LiveSessionDirectory();

		try {
			const result = await runChildAgent(makeStep({ runId: "relay-create-failure" }), makeContext());
			assert.equal(result.state, "failed");
			assert.deepEqual(directory.sessionsForRun("relay-create-failure"), []);
		} finally {
			directory.dispose();
		}
	});

	it("unpublishes a created session after prompt failure", async () => {
		const session = new FakeAgentSession(async () => {
			throw new Error("prompt failed");
		});
		installFakeRuntime([session]);
		const directory = new LiveSessionDirectory();

		try {
			const result = await runChildAgent(makeStep({ runId: "relay-prompt-failure" }), makeContext());
			assert.equal(result.state, "failed");
			assert.deepEqual(directory.sessionsForRun("relay-prompt-failure"), []);
		} finally {
			directory.dispose();
		}
	});

	it("awaits prompt and returns complete output assembled from text_delta events", async () => {
		const session = new FakeAgentSession(async (self) => {
			self.emit({ type: "text_delta", delta: "hello " });
			self.emit({ type: "text_delta", delta: "world" });
			self.lastAssistantText = "<output>hello world</output>";
			self.emit({ type: "agent_end" });
		});
		installFakeRuntime([session]);
		const events: unknown[] = [];

		const result = await runChildAgent(
			makeStep(),
			makeContext({
				onEvent: (_stepIndex, event) => events.push(event),
			}),
		);

		assert.equal(result.error, undefined);
		assert.equal(result.state, "complete");
		assert.equal(result.exitCode, 0);
		assert.equal(result.outputText, "hello world");
		assert.equal(session.promptCalls, 1);
		assert.equal(session.disposeCalls, 1);
		assert.deepEqual(session.activeToolNames, ["read", "bash"]);
		assert.equal(events.length, 3);
	});

	it("continues the same session on the next model when the last assistant outcome is rate-limited", async () => {
		const primarySession = new FakeAgentSession(async (self) => {
			for (let index = 0; index < 3; index++) {
				self.emit({ type: "tool_execution_start", toolName: "write" });
				self.emit({ type: "tool_execution_end", toolName: "write" });
			}
			self.emit({
				type: "message_end",
				message: { role: "assistant", usage: { input: 10, output: 2, cost: { total: 0.01 } } },
			});
			self.messages = [
				{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "earlier work" }] },
				{ role: "toolResult", content: [{ type: "text", text: "written" }] },
				{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "more work" }] },
				{
					role: "assistant",
					stopReason: "error",
					errorMessage: "HTTP 429 rate limit exceeded",
					content: [],
				},
			];
			self.lastAssistantText = "";
		});
		const fallbackSession = new FakeAgentSession(async (self) => {
			self.emit({
				type: "message_end",
				message: { role: "assistant", usage: { input: 5, output: 4, cost: { total: 0.02 } } },
			});
			self.messages.push({ role: "assistant", stopReason: "stop", content: [] });
			self.lastAssistantText = "<output>completed on fallback</output>";
		});
		installFakeRuntime([primarySession, fallbackSession]);
		const fallback = { provider: "test", id: "model-b" } as never;

		const result = await runChildAgent(makeStep({ modelCandidates: [fallback] }), makeContext());

		assert.equal(result.error, undefined);
		assert.equal(result.state, "complete");
		assert.equal(result.outputText, "completed on fallback");
		assert.equal(result.model, "test/model-b");
		assert.deepEqual(result.attemptedModels, ["test/model-a", "test/model-b"]);
		assert.equal(result.toolCallCount, 3);
		assert.deepEqual(result.usage, {
			input: 15,
			output: 6,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0.03,
			turns: 2,
		});
		assert.equal(primarySession.promptCalls, 1);
		assert.equal(fallbackSession.promptCalls, 1);
		assert.deepEqual(primarySession.setModelCalls, []);
		assert.deepEqual(fallbackSession.setModelCalls, []);
		assert.equal(primarySession.disposeCalls, 1);
	});

	it("tries fallback models in order and fails with the final provider error when exhausted", async () => {
		const errors = ["hard quota usage limit", "HTTP 503 provider unavailable", "billing account disabled"];
		const sessions = errors.map(
			(error) =>
				new FakeAgentSession(async (self) => {
					self.messages.push({
						role: "assistant",
						stopReason: "error",
						errorMessage: error,
						content: [],
					});
					self.lastAssistantText = "";
				}),
		);
		installFakeRuntime([...sessions]);
		const modelB = { provider: "test", id: "model-b" } as never;
		const modelC = { provider: "test", id: "model-c" } as never;

		const result = await runChildAgent(makeStep({ modelCandidates: [modelB, modelC] }), makeContext());

		assert.equal(result.state, "failed");
		assert.equal(result.error?.message, "billing account disabled");
		assert.deepEqual(
			sessions.map((session) => session.promptCalls),
			[1, 1, 1],
		);
		assert.ok(sessions.every((session) => session.setModelCalls.length === 0));
	});

	it("waits and retries the current model after a transport failure without consuming fallback", async () => {
		const session = new FakeAgentSession(async (self) => {
			if (self.promptCalls <= 8) {
				self.messages.push({
					role: "assistant",
					stopReason: "error",
					errorMessage: "fetch failed: ENOTFOUND api.invalid",
					content: [],
				});
				self.lastAssistantText = "";
				return;
			}
			self.messages.push({ role: "assistant", stopReason: "stop", content: [] });
			self.lastAssistantText = "<output>online again</output>";
		});
		installFakeRuntime([session]);
		const waitDelays: number[] = [];
		restoreFns.push(
			__setChildAgentExecutorDepsForTest({
				waitForNetworkRetry: async (_signal, delayMs) => {
					waitDelays.push(delayMs);
					return false;
				},
			}),
		);
		const fallback = { provider: "test", id: "model-b" } as never;
		const patches: Array<{ phase?: string }> = [];

		const result = await runChildAgent(
			makeStep({ modelCandidates: [fallback] }),
			makeContext({ onStatusUpdate: (patch) => patches.push(patch) }),
		);

		assert.equal(result.state, "complete");
		assert.equal(result.outputText, "online again");
		assert.deepEqual(waitDelays, [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 180_000, 180_000]);
		assert.equal(session.promptCalls, 9);
		assert.deepEqual(session.setModelCalls, []);
		assert.ok(patches.some((patch) => patch.phase === "waiting_network"));
	});

	it("interrupts promptly while waiting for network recovery", async () => {
		const session = new FakeAgentSession(async (self) => {
			self.messages.push({
				role: "assistant",
				stopReason: "error",
				errorMessage: "network error: ENETUNREACH",
				content: [],
			});
		});
		installFakeRuntime([session]);
		const controller = new AbortController();
		let markWaiting!: () => void;
		const waiting = new Promise<void>((resolve) => {
			markWaiting = resolve;
		});

		const resultPromise = runChildAgent(
			makeStep(),
			makeContext({
				abortSignal: controller.signal,
				onStatusUpdate: (patch) => {
					if (patch.phase === "waiting_network") markWaiting();
				},
			}),
		);
		await waiting;
		controller.abort("stop-waiting");
		const result = await resultPromise;

		assert.equal(result.state, "interrupted");
		assert.equal(result.error?.reason, "stop-waiting");
		assert.equal(session.promptCalls, 1);
		assert.deepEqual(session.setModelCalls, []);
	});

	it("keeps overlapping session construction in independent child contexts", async () => {
		let releaseFirst!: () => void;
		let markFirstStarted!: () => void;
		const firstReleased = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const firstStarted = new Promise<void>((resolve) => {
			markFirstStarted = resolve;
		});
		let reloadCount = 0;
		class InterleavedResourceLoader extends FakeResourceLoader {
			override async reload(): Promise<void> {
				assert.equal(isInsideChildSession(), true);
				reloadCount++;
				if (reloadCount === 1) {
					markFirstStarted();
					await firstReleased;
				}
				await super.reload();
			}
		}
		const makeSession = () =>
			new FakeAgentSession(async (self) => {
				self.lastAssistantText = "<output>done</output>";
			});
		const firstStep = makeStep({ runId: "run-child-context-first" });
		const secondStep = makeStep({ runId: "run-child-context-second" });
		installFakeRuntime(
			[makeSession(), makeSession()],
			() => assert.equal(isInsideChildSession(), true),
			(sessionFile) => sessionFile,
			[],
			InterleavedResourceLoader,
		);
		let firstRun: ReturnType<typeof runChildAgent> | undefined;

		try {
			firstRun = runChildAgent(firstStep, makeContext());
			await firstStarted;
			assert.equal(isInsideChildSession(), false);
			const secondResult = await runChildAgent(secondStep, makeContext());
			assert.equal(secondResult.state, "complete");
			assert.equal(isInsideChildSession(), false);
			releaseFirst();
			const firstResult = await firstRun;
			assert.equal(firstResult.state, "complete");
			assert.equal(isInsideChildSession(), false);
		} finally {
			releaseFirst();
			await firstRun?.catch(() => {});
			clearLineage(firstStep.sessionFile, secondStep.sessionFile);
		}
	});

	it("persists the branch-aware live message preview and flushes it at message boundaries", async () => {
		const step = makeStep({ runId: "run-preview-events" });
		const session = new FakeAgentSession(async (self) => {
			self.messages = [{ role: "assistant", content: [{ type: "text", text: "preview text" }] }];
			self.emit({ type: "message_update", message: self.messages[0] });
			assert.equal(readRunTranscriptPreview(step.sessionFile)?.messages.length, 0);
			self.emit({ type: "message_end", message: self.messages[0] });
			assert.equal(readRunTranscriptPreview(step.sessionFile)?.messages[0]?.role, "assistant");
			self.lastAssistantText = "<output>done</output>";
		});
		installFakeRuntime([session]);

		const result = await runChildAgent(step, makeContext());

		assert.equal(result.state, "complete");
		assert.match(JSON.stringify(readRunTranscriptPreview(step.sessionFile)), /preview text/);
	});

	it("increments tool counters on tool_execution_start and tool_execution_end", async () => {
		const session = new FakeAgentSession(async (self) => {
			self.emit({ type: "tool_execution_start", toolName: "read" });
			self.emit({ type: "tool_execution_end", toolName: "read" });
			self.emit({ type: "tool_execution_start", toolName: "bash" });
			self.emit({ type: "tool_execution_end", toolName: "bash", isError: true });
			self.lastAssistantText = "<output>done</output>";
		});
		installFakeRuntime([session]);
		const patches: unknown[] = [];

		const result = await runChildAgent(
			makeStep(),
			makeContext({
				onStatusUpdate: (patch) => patches.push(patch),
			}),
		);

		assert.equal(result.toolCallCount, 2);
		assert.equal(result.toolResultCount, 2);
		assert.equal(result.toolErrorCount, 1);
		assert.equal(patches.filter((patch) => (patch as { toolCallDelta?: number }).toolCallDelta === 1).length, 2);
		assert.equal(
			patches.filter((patch) => (patch as { toolResultDelta?: number }).toolResultDelta === 1).length,
			2,
		);
		assert.equal(patches.filter((patch) => (patch as { toolErrorDelta?: number }).toolErrorDelta === 1).length, 1);
		const completedToolPatch = patches.find(
			(patch) => (patch as { toolResultDelta?: number }).toolResultDelta === 1,
		) as { activity?: { state?: string; toolName?: string; updatedAt?: number }; phase?: string } | undefined;
		assert.equal(completedToolPatch?.phase, "idle");
		assert.deepEqual(completedToolPatch?.activity, {
			state: "running",
			updatedAt: completedToolPatch?.activity?.updatedAt,
		});
	});

	it("persists activity and live text from nested assistant streaming events", async () => {
		const session = new FakeAgentSession(async (self) => {
			self.emit({
				type: "message_update",
				assistantMessageEvent: { type: "thinking_delta", delta: "reasoning" },
			});
			self.emit({
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", delta: "streamed" },
			});
			self.emit({
				type: "message_update",
				assistantMessageEvent: { type: "text_end", content: "streamed output" },
			});
			self.lastAssistantText = "<output>done</output>";
		});
		installFakeRuntime([session]);
		const patches: unknown[] = [];

		await runChildAgent(
			makeStep(),
			makeContext({
				onStatusUpdate: (patch) => patches.push(patch),
			}),
		);

		const thinkingPatch = patches.find((patch) => (patch as { phase?: string }).phase === "thinking") as
			| { activity?: { state?: string } }
			| undefined;
		assert.equal(thinkingPatch?.activity?.state, "running");
		const streamingPatch = patches.find((patch) => (patch as { liveText?: string }).liveText === "streamed") as
			| { activity?: { state?: string; updatedAt?: number }; phase?: string }
			| undefined;
		assert.equal(streamingPatch?.phase, "streaming_text");
		assert.equal(streamingPatch?.activity?.state, "running");
		assert.equal(typeof streamingPatch?.activity?.updatedAt, "number");
		assert.ok(patches.some((patch) => (patch as { liveText?: string }).liveText === "streamed output"));
	});

	it("aborts the session and returns interrupted when abortSignal fires", async () => {
		let markPromptStarted!: () => void;
		const promptStarted = new Promise<void>((resolve) => {
			markPromptStarted = resolve;
		});
		const session = new FakeAgentSession(async () => {
			markPromptStarted();
			await new Promise<void>(() => {});
		});
		installFakeRuntime([session]);
		const controller = new AbortController();
		const directory = new LiveSessionDirectory();
		const promise = runChildAgent(
			makeStep({ runId: "relay-abort" }),
			makeContext({ abortSignal: controller.signal }),
		);

		await promptStarted;
		assert.deepEqual(directory.sessionsForRun("relay-abort"), [session]);
		controller.abort("stop-now");
		const result = await promise;

		assert.equal(session.abortCalls, 1);
		assert.equal(session.disposeCalls, 1);
		assert.equal(result.state, "interrupted");
		assert.equal(result.error?.reason, "stop-now");
		assert.deepEqual(directory.sessionsForRun("relay-abort"), []);
		directory.dispose();
	});

	it("returns interrupted when an acknowledged abort arrives during exportToHtml", async () => {
		let rejectExport!: (error: Error) => void;
		let markExportStarted!: () => void;
		const exportStarted = new Promise<void>((resolve) => {
			markExportStarted = resolve;
		});
		const session = new FakeAgentSession(async (self) => {
			self.lastAssistantText = "<output>done</output>";
		});
		session.exportImpl = () => {
			markExportStarted();
			return new Promise<string>((_resolve, reject) => {
				rejectExport = reject;
			});
		};
		installFakeRuntime([session]);

		const handle = dispatchAsyncChild(
			makeStep({ runId: "run-abort-mid-export", shareEnabled: true }),
			makeContext(),
		);
		await exportStarted;
		const abortDone = handle.abort("stop-mid-export");
		rejectExport(new Error("session aborted during export"));
		await abortDone;
		const result = await handle.completed;

		assert.equal(result.state, "interrupted");
		assert.equal(result.exitCode, 1);
		assert.equal(result.error?.reason, "stop-mid-export");
	});

	it("leaves no abort listeners on a long-lived parent signal after children complete normally", async () => {
		const parent = new AbortController();
		const baseline = getEventListeners(parent.signal, "abort").length;

		for (let index = 0; index < 5; index++) {
			const session = new FakeAgentSession(async (self) => {
				self.lastAssistantText = "<output>done</output>";
			});
			installFakeRuntime([session]);
			const result = await runChildAgent(
				makeStep({ runId: `run-listener-${index}` }),
				makeContext({ abortSignal: parent.signal }),
			);
			assert.equal(result.state, "complete");
		}

		assert.equal(getEventListeners(parent.signal, "abort").length, baseline);
	});

	it("normalizes parent lineage identity before falling back to the step parent identity", async () => {
		const parentSessionId = "session-parent-blank-identity";
		const childSessionId = "session-child-parent-fallback";
		const session = new FakeAgentSession(async (self) => {
			self.lastAssistantText = "<output>done</output>";
		});
		setHostLineage(parentSessionId, "   ");
		installFakeRuntime([session], undefined, childSessionId);

		try {
			await runChildAgent(makeStep({ parentSessionId, parentAgentName: "  fallback-agent  " }), makeContext());

			assert.equal(getLineageForSession(childSessionId)?.parentAgent, "fallback-agent");
		} finally {
			claimPendingChildLineage(childSessionId, { runId: null, agentName: null });
			clearLineage(parentSessionId, childSessionId);
		}
	});

	it("preserves parent lineage when a fork child uses a distinct session id", async () => {
		const parentSessionId = "session-fork-parent";
		const childSessionId = "session-fork-child";
		const forkSource = path.join(tempDir("pi-in-process-fork-source-"), "branched.jsonl");
		fs.writeFileSync(forkSource, '{"type":"session","id":"session-fork-child"}\n');
		const step = makeStep({
			parentSessionId,
			forkReuse: { sessionFile: forkSource, agentName: "fixer" },
		});
		const parentLineage = setHostLineage(parentSessionId, "parent-agent");
		const session = new FakeAgentSession(async (self) => {
			self.lastAssistantText = "<output>done</output>";
		});
		installFakeRuntime([session], undefined, childSessionId);

		try {
			const result = await runChildAgent(step, makeContext());

			assert.equal(result.state, "complete");
			assert.notEqual(childSessionId, parentSessionId);
			assert.equal(getLineageForSession(parentSessionId), parentLineage);
			assert.equal(getLineageForSession(childSessionId)?.parentSessionId, parentSessionId);
		} finally {
			claimPendingChildLineage(childSessionId, { runId: null, agentName: null });
			clearLineage(parentSessionId, childSessionId);
		}
	});

	it("fails a colliding fork child without replacing parent lineage", async () => {
		const parentSessionId = "session-fork-collision-parent";
		const forkSource = path.join(tempDir("pi-in-process-fork-collision-"), "branched.jsonl");
		fs.writeFileSync(forkSource, '{"type":"session","id":"session-fork-collision-parent"}\n');
		const step = makeStep({
			parentSessionId,
			forkReuse: { sessionFile: forkSource, agentName: "fixer" },
		});
		const parentLineage = setHostLineage(parentSessionId, "parent-agent");
		let createCalls = 0;
		installFakeRuntime([], () => createCalls++, parentSessionId);

		try {
			const result = await runChildAgent(step, makeContext());

			assert.equal(result.state, "failed");
			assert.equal(result.error?.message, "Cannot replace an existing session lineage binding.");
			assert.equal(createCalls, 0);
			assert.equal(getLineageForSession(parentSessionId), parentLineage);
		} finally {
			clearLineage(parentSessionId);
		}
	});

	it("cleans failed lineage after model fallback is exhausted when session id is unavailable", async () => {
		const firstFailedSessionId = "session-failed-setup-first";
		const terminalFailedSessionId = "session-failed-setup-terminal";
		const cleanupSessionId = "session-failed-setup-cleanup";
		const attemptSessionIds = [firstFailedSessionId, terminalFailedSessionId];
		const step = makeStep({
			runId: "run-failed-setup",
			modelCandidates: [{ provider: "test", id: "model-b" } as never],
		});
		let createCalls = 0;
		let firstClaim: ReturnType<typeof claimPendingChildLineage> = null;
		let terminalClaim: ReturnType<typeof claimPendingChildLineage> = null;
		installFakeRuntime(
			[],
			() => {
				if (createCalls === 1) assert.equal(getLineageForSession(firstFailedSessionId), null);
				const claimed = claimPendingChildLineage(attemptSessionIds[createCalls]!, {
					runId: null,
					agentName: null,
					sessionFile: step.sessionFile,
				});
				assert.equal(claimed?.runId, step.runId);
				if (createCalls === 0) firstClaim = claimed;
				else terminalClaim = claimed;
				createCalls++;
			},
			undefined,
			[new Error("authentication failed for model-a"), new Error("authentication failed for model-b")],
		);

		try {
			const result = await runChildAgent(step, makeContext());

			assert.equal(result.state, "failed");
			assert.equal(result.model, "test/model-b");
			assert.deepEqual(result.attemptedModels, ["test/model-a", "test/model-b"]);
			assert.equal(createCalls, 2);
			assert.equal(firstClaim, terminalClaim);
			assert.equal(getLineageForSession(firstFailedSessionId), null);
			assert.equal(getLineageForSession(terminalFailedSessionId), null);
			assert.equal(
				claimPendingChildLineage(cleanupSessionId, {
					runId: null,
					agentName: null,
					sessionFile: step.sessionFile,
				}),
				null,
			);
		} finally {
			claimPendingChildLineage(cleanupSessionId, {
				runId: step.runId,
				agentName: null,
				sessionFile: step.sessionFile,
			});
			clearLineage(firstFailedSessionId, terminalFailedSessionId, cleanupSessionId);
		}
	});

	it("cleans an auth-failed attempt binding before fallback succeeds when session id is unavailable", async () => {
		const failedSessionId = "session-auth-fallback-failed-attempt";
		const successfulSessionId = "session-auth-fallback-successful-attempt";
		const cleanupSessionId = "session-auth-fallback-attempt-cleanup";
		const attemptSessionIds = [failedSessionId, successfulSessionId];
		const step = makeStep({
			runId: "run-auth-fallback-attempt-cleanup",
			modelCandidates: [{ provider: "test", id: "model-b" } as never],
		});
		const session = new FakeAgentSession(async (self) => {
			self.lastAssistantText = "<output>done</output>";
		});
		let createCalls = 0;
		let firstClaim: ReturnType<typeof claimPendingChildLineage> = null;
		let successfulClaim: ReturnType<typeof claimPendingChildLineage> = null;
		installFakeRuntime(
			[session],
			() => {
				if (createCalls === 1) assert.equal(getLineageForSession(failedSessionId), null);
				const claimed = claimPendingChildLineage(attemptSessionIds[createCalls]!, {
					runId: null,
					agentName: null,
					sessionFile: step.sessionFile,
				});
				assert.equal(claimed?.runId, step.runId);
				if (createCalls === 0) firstClaim = claimed;
				else successfulClaim = claimed;
				createCalls++;
			},
			undefined,
			[new Error("authentication failed for model-a")],
		);

		try {
			const result = await runChildAgent(step, makeContext());

			assert.equal(result.state, "complete");
			assert.equal(result.model, "test/model-b");
			assert.deepEqual(result.attemptedModels, ["test/model-a", "test/model-b"]);
			assert.equal(createCalls, 2);
			assert.equal(firstClaim, successfulClaim);
			assert.equal(getLineageForSession(failedSessionId), null);
			assert.equal(getLineageForSession(successfulSessionId), successfulClaim);
			assert.equal(getLineageForSession(successfulSessionId)?.runId, step.runId);
			assert.equal(
				claimPendingChildLineage(successfulSessionId, {
					runId: null,
					agentName: null,
					sessionFile: step.sessionFile,
				}),
				successfulClaim,
			);
			assert.equal(
				claimPendingChildLineage(cleanupSessionId, {
					runId: null,
					agentName: null,
					sessionFile: step.sessionFile,
				}),
				null,
			);
		} finally {
			clearLineage(failedSessionId, successfulSessionId, cleanupSessionId);
		}
	});

	it("preserves pending lineage through auth fallback until successful activation can claim it", async () => {
		const activationSessionId = "session-auth-fallback-success";
		const cleanupSessionId = "session-auth-fallback-success-cleanup";
		const step = makeStep({
			runId: "run-auth-fallback-success",
			modelCandidates: [{ provider: "test", id: "model-b" } as never],
		});
		const session = new FakeAgentSession(async (self) => {
			self.lastAssistantText = "<output>done</output>";
		});
		let createCalls = 0;
		installFakeRuntime([session], () => createCalls++, undefined, [new Error("authentication failed for model-a")]);

		try {
			const result = await runChildAgent(step, makeContext());
			const claimed = claimPendingChildLineage(activationSessionId, {
				runId: null,
				agentName: null,
				sessionFile: step.sessionFile,
			});

			assert.equal(result.state, "complete");
			assert.equal(createCalls, 2);
			assert.equal(claimed?.runId, step.runId);
			assert.equal(
				claimPendingChildLineage(cleanupSessionId, {
					runId: null,
					agentName: null,
					sessionFile: step.sessionFile,
				}),
				null,
			);
		} finally {
			clearLineage(activationSessionId, cleanupSessionId);
		}
	});
});

describe("dispatchAsyncChild", () => {
	it("survives an unrelated parent-turn abort when only the registry/local signals can cancel it", async () => {
		// Models the runAsyncPath wiring after decoupling: asyncCtx.abortSignal is a
		// detached controller never tied to the parent turn's signal. The parent turn
		// can ESC freely; the async child keeps running until the registry per-run
		// controller (or its local controller) fires.
		let release!: () => void;
		const promptReleased = new Promise<void>((resolve) => {
			release = resolve;
		});
		const session = new FakeAgentSession(async (self) => {
			await promptReleased;
			self.emit({ type: "text_delta", delta: "ok" });
		});
		installFakeRuntime([session]);

		const parentTurnAbort = new AbortController();
		const asyncDetachedAbort = new AbortController();
		const registry = new ChildAgentRegistry();

		const handle = dispatchAsyncChild(
			makeStep({ runId: "async-survives-esc" }),
			makeContext({ abortSignal: asyncDetachedAbort.signal, registry }),
		);

		await new Promise((resolve) => setImmediate(resolve));
		// Simulate parent turn ESC: aborting an UNRELATED controller must not reach the child.
		parentTurnAbort.abort("parent ESC");
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(session.abortCalls, 0, "unrelated parent-turn abort must not reach async child");

		// Per-run registry controller is the supported kill switch via action:"interrupt".
		await registry.abortRun("async-survives-esc", "interrupt requested");
		release();
		const result = await handle.completed;
		assert.ok(session.abortCalls >= 1, "registry abort must reach the child session");
		assert.equal(result.state, "interrupted");
	});

	it("returns a handle without awaiting", async () => {
		let release!: () => void;
		const promptReleased = new Promise<void>((resolve) => {
			release = resolve;
		});
		const session = new FakeAgentSession(async (self) => {
			await promptReleased;
			self.emit({ type: "text_delta", delta: "done" });
			self.lastAssistantText = "<output>done</output>";
		});
		let createCalls = 0;
		installFakeRuntime([session], () => createCalls++);
		const handle = dispatchAsyncChild(makeStep({ runId: "async-run" }), makeContext());
		assert.equal(handle.runId, "async-run");
		assert.equal(createCalls, 0);
		assert.equal(session.promptCalls, 0);

		release();
		const result = await handle.completed;
		assert.equal(result.state, "complete");
		assert.equal(result.outputText, "done");
	});
});

describe("ChildAgentRegistry", () => {
	function fakeHandle(runId: string, stepIndex: number, aborts: string[]): ChildAgentHandle {
		return {
			runId,
			stepIndex,
			get session() {
				return {} as never;
			},
			completed: Promise.resolve({} as never),
			async abort(reason: string): Promise<void> {
				aborts.push(`${runId}:${reason}`);
			},
		};
	}

	it("registers, gets, lists, deletes, aborts one run, and aborts all runs", async () => {
		const registry = new ChildAgentRegistry();
		const aborts: string[] = [];
		const signalA = registry.signalForRun("a");
		const handleA = fakeHandle("a", 0, aborts);
		const handleB = fakeHandle("b", 1, aborts);

		registry.register(handleA);
		registry.register(handleB);
		assert.equal(registry.get("a"), handleA);
		assert.deepEqual(registry.snapshot(), [
			{ runId: "a", stepIndex: 0 },
			{ runId: "b", stepIndex: 1 },
		]);
		assert.deepEqual(
			registry.list().map((handle) => handle.runId),
			["a", "b"],
		);

		await registry.abortRun("a", "reload");
		assert.equal(signalA.aborted, true);
		assert.deepEqual(aborts, ["a:reload"]);

		registry.delete("a");
		assert.equal(registry.get("a"), undefined);
		assert.deepEqual(
			registry.list().map((handle) => handle.runId),
			["b"],
		);

		await registry.abortAll("shutdown");
		assert.deepEqual(aborts, ["a:reload", "b:shutdown"]);
	});

	it("tracks multiple concurrent steps for one run id", async () => {
		const registry = new ChildAgentRegistry();
		const aborts: string[] = [];
		const handleA = fakeHandle("shared", 0, aborts);
		const handleB = fakeHandle("shared", 1, aborts);

		registry.register(handleA);
		registry.register(handleB);
		assert.deepEqual(registry.snapshot(), [
			{ runId: "shared", stepIndex: 0 },
			{ runId: "shared", stepIndex: 1 },
		]);

		registry.delete("shared", 0);
		assert.deepEqual(registry.snapshot(), [{ runId: "shared", stepIndex: 1 }]);

		await registry.abortRun("shared", "stop");
		assert.deepEqual(aborts, ["shared:stop"]);
	});
});
