/**
 * Integration tests for f8-needs-attention-event-channel.
 *
 * Uses t.mock.timers to drive foreground status ticks and the async-job-tracker
 * poll loop deterministically without real sleeps.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { after, afterEach, describe, it } from "node:test";
import { createAsyncJobTracker } from "../../src/surfaces/async-job-tracker.ts";
import { registerControlNotices } from "../../src/surfaces/control-notices.ts";
import {
	createActivityTicker,
	type ControlNotificationDedupeStore,
	DEFAULT_CONTROL_CONFIG,
} from "../../src/dispatch/subagent-control.ts";
import { appendRunEntry, setRegistryPathForTests } from "../../src/state/runs-registry.ts";
import {
	SUBAGENT_CONTROL_EVENT,
	SUBAGENT_NEEDS_ATTENTION_EVENT,
	type ControlEvent,
	type ResolvedControlConfig,
	type SubagentNeedsAttentionPayload,
	type SubagentState,
} from "../../src/protocol/types.ts";
import type { PersistedRunStatus } from "../../src/protocol/status-types.ts";

let testsRun = 0;
afterEach(() => {
	testsRun++;
});
after(() => {
	process.stdout.write(`# tests ${testsRun}\n`);
});

function makeEventsBus() {
	const calls: Array<{ event: string; payload: unknown }> = [];
	return {
		emit(event: string, payload: unknown) {
			calls.push({ event, payload });
		},
		calls,
		countOf(event: string) {
			return calls.filter((call) => call.event === event).length;
		},
		payloadsFor(event: string) {
			return calls.filter((call) => call.event === event).map((call) => call.payload);
		},
	};
}

type RecorderBus = ReturnType<typeof makeEventsBus>;

function emitForegroundNeedsAttention(bus: RecorderBus, event: ControlEvent): void {
	bus.emit(SUBAGENT_CONTROL_EVENT, {
		event,
		source: "foreground" as const,
		noticeText: event.message,
	});
	bus.emit(SUBAGENT_NEEDS_ATTENTION_EVENT, {
		runId: event.runId,
		agent: event.agent,
		ts: event.ts,
		message: event.message,
		...(event.index !== undefined ? { index: event.index } : {}),
	} satisfies SubagentNeedsAttentionPayload);
}

function writeStatus(asyncDir: string, status: PersistedRunStatus, mtimeMs: number): void {
	mkdirSync(asyncDir, { recursive: true });
	const statusPath = join(asyncDir, "status.json");
	writeFileSync(statusPath, JSON.stringify(status), "utf8");
	const mtime = new Date(mtimeMs);
	utimesSync(statusPath, mtime, mtime);
}

function makeState(asyncDir: string, config: ResolvedControlConfig): SubagentState {
	return {
		baseCwd: process.cwd(),
		currentSessionId: null,
		asyncJobs: new Map([
			[
				"async-r1",
				{
					asyncId: "async-r1",
					asyncDir,
					status: "running",
					displayState: "quiet",
					mode: "single",
					agents: ["worker"],
					currentStep: 0,
					stepsTotal: 1,
					startedAt: 0,
					updatedAt: 0,
					lastActivityAt: 0,
					controlConfig: config,
				},
			],
		]),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
	};
}

function cleanupPoller(state: SubagentState): void {
	if (state.poller) {
		clearInterval(state.poller);
		state.poller = null;
	}
	for (const timer of state.cleanupTimers.values()) clearTimeout(timer);
	state.cleanupTimers.clear();
}

function createControlNoticeHarness(legacyKeys: string[] = []) {
	const sent: Array<{ details?: { event?: ControlEvent } }> = [];
	const globalStore: Record<string, unknown> = {};
	if (legacyKeys.length > 0) globalStore.__piSubagentVisibleControlNotices = new Set(legacyKeys);
	const pi = {
		sendMessage(message: { details?: { event?: ControlEvent } }) {
			sent.push(message);
		},
		registerMessageRenderer() {},
	} as never;
	return {
		globalStore,
		register: () => registerControlNotices({ pi, isChildSession: false, globalStore }),
		sent,
	};
}

describe("needs-attention reaches parent", () => {
	it("suppresses duplicate delivery and retains only the latest stall transition", () => {
		const { globalStore, register, sent } = createControlNoticeHarness();
		const first = register();
		const firstTransition: ControlEvent = {
			type: "needs_attention",
			from: undefined,
			to: "needs_attention",
			ts: 1_000,
			activityAt: 500,
			runId: "recovered-r1",
			agent: "worker",
			index: 0,
			message: "worker needs attention",
		};

		first.controlEventHandler({ event: firstTransition, source: "async" });

		const recovered = register();
		recovered.controlEventHandler({ event: firstTransition, source: "async" });
		recovered.controlEventHandler({ event: { ...firstTransition, ts: 2_000 }, source: "async" });
		recovered.controlEventHandler({
			event: { ...firstTransition, ts: 3_000, activityAt: 2_500 },
			source: "async",
		});

		assert.deepEqual(
			sent.map((message) => message.details?.event?.ts),
			[1_000, 3_000],
		);
		const seen = globalStore.__piSubagentVisibleControlNotices as ControlNotificationDedupeStore;
		assert.equal(seen.byRunId.get("recovered-r1")?.size, 1);
		recovered.controlRunTerminalHandler({ runId: "recovered-r1" });
		assert.equal(seen.byRunId.has("recovered-r1"), false);
	});

	it("suppresses older and equal activity transitions without moving the baseline backward", () => {
		const { globalStore, register, sent } = createControlNoticeHarness(["out-of-order-r1:0:needs_attention:2000"]);
		const notices = register();
		const transition: ControlEvent = {
			type: "needs_attention",
			to: "needs_attention",
			ts: 3_000,
			activityAt: 2_000,
			runId: "out-of-order-r1",
			agent: "worker",
			index: 0,
			message: "worker needs attention",
		};

		notices.controlEventHandler({
			event: { ...transition, activityAt: 1_000 },
			source: "async",
		});
		notices.controlEventHandler({
			event: { ...transition, ts: 4_000 },
			source: "async",
		});
		notices.controlEventHandler({
			event: { ...transition, ts: 5_000, activityAt: 1_500 },
			source: "async",
		});

		const seen = globalStore.__piSubagentVisibleControlNotices as ControlNotificationDedupeStore;
		assert.deepEqual(
			sent.map((message) => message.details?.event?.activityAt),
			[],
		);
		assert.deepEqual([...(seen.byRunId.get("out-of-order-r1")?.values() ?? [])], [2_000]);

		notices.controlEventHandler({
			event: { ...transition, ts: 6_000, activityAt: 3_000 },
			source: "async",
		});
		assert.deepEqual(
			sent.map((message) => message.details?.event?.activityAt),
			[3_000],
		);
	});

	it("migrates a timestamp-keyed continuing stall without redelivery", () => {
		const { globalStore, register, sent } = createControlNoticeHarness(["legacy-r1:0:needs_attention:1000"]);
		const notices = register();
		const transition: ControlEvent = {
			type: "needs_attention",
			to: "needs_attention",
			ts: 2_000,
			activityAt: 500,
			runId: "legacy-r1",
			agent: "worker",
			index: 0,
			message: "worker needs attention",
		};

		notices.controlEventHandler({
			event: transition,
			source: "async",
		});

		assert.equal(sent.length, 0);
		const seen = globalStore.__piSubagentVisibleControlNotices as ControlNotificationDedupeStore;
		assert.equal(seen.byRunId.get("legacy-r1")?.size, 1);
		assert.equal(seen.legacyKeys.size, 0);

		seen.legacyKeys.add("legacy-r1:0:needs_attention");
		notices.controlRunTerminalHandler({ runId: "legacy-r1", agent: "worker", taskIndex: 0 });
		notices.controlEventHandler({
			event: { ...transition, ts: 4_000, activityAt: 3_000 },
			source: "async",
		});
		assert.equal(sent.length, 1);
	});

	it("aggregate terminal events evict every migrated step-scoped key for the run", () => {
		const { globalStore, register } = createControlNoticeHarness([
			"parallel-r1:0:needs_attention",
			"parallel-r1:0:needs_attention:1000",
			"parallel-r1:1:needs_attention:2000",
			"other-r1:0:needs_attention:3000",
		]);
		const notices = register();

		notices.controlRunTerminalHandler({
			id: "parallel-r1",
			runId: "parallel-r1",
			agent: "worker,reviewer",
		});

		const seen = globalStore.__piSubagentVisibleControlNotices as ControlNotificationDedupeStore;
		assert.deepEqual([...seen.legacyKeys], ["other-r1:0:needs_attention:3000"]);
	});

	it("reload rehydration does not redeliver the same continuing stall", (t) => {
		t.mock.timers.enable({ apis: ["Date", "setInterval"] });

		const tmp = mkdtempSync(join(tmpdir(), "needs-attention-reload-"));
		const registryPath = join(tmp, "runs-index.jsonl");
		const runDir = join(tmp, "async-r1");
		const hostSessionId = "host-reload";
		const now = Date.now();
		const activityAt = now - DEFAULT_CONTROL_CONFIG.needsAttentionAfterMs - 1;
		const status: PersistedRunStatus = {
			runId: "async-r1",
			mode: "single",
			state: "running",
			startedAt: activityAt,
			executionStartedAt: activityAt,
			lastActivityAt: activityAt,
			lastUpdate: now,
			runnerHeartbeatAt: now,
			currentStep: 0,
			steps: [{ agent: "worker", status: "running", startedAt: activityAt, lastActivityAt: activityAt }],
		};
		const { globalStore, register, sent } = createControlNoticeHarness();
		const context = {
			hasUI: false,
			sessionManager: { getSessionId: () => hostSessionId },
		} as never;
		const states: SubagentState[] = [];
		try {
			setRegistryPathForTests(registryPath);
			writeStatus(runDir, status, now);
			appendRunEntry({
				runId: "async-r1",
				runRecordDir: runDir,
				mode: "single",
				source: "async",
				agentName: "worker",
				rootSessionId: hostSessionId,
				parentSessionId: hostSessionId,
				cwd: process.cwd(),
				startedAt: activityAt,
			});

			for (let activation = 0; activation < 2; activation++) {
				const bus = makeEventsBus();
				const state = makeState(runDir, DEFAULT_CONTROL_CONFIG);
				state.asyncJobs.clear();
				states.push(state);
				const tracker = createAsyncJobTracker({ events: bus } as never, state, { pollIntervalMs: 5 });
				assert.equal(tracker.rehydrateFromRegistry(context), 1);
				t.mock.timers.tick(5);
				const payload = bus.payloadsFor(SUBAGENT_CONTROL_EVENT).at(-1);
				assert.ok(payload, `activation ${activation + 1} did not emit its reconstructed stall edge`);
				register().controlEventHandler(payload);
				cleanupPoller(state);
			}

			assert.equal(sent.length, 1);
			writeStatus(runDir, { ...status, state: "complete" }, Date.now());
			const terminalState = makeState(runDir, DEFAULT_CONTROL_CONFIG);
			terminalState.asyncJobs.clear();
			states.push(terminalState);
			const notices = register();
			const terminalTracker = createAsyncJobTracker({ events: makeEventsBus() } as never, terminalState, {
				pollIntervalMs: 5,
				onRunTerminal: notices.controlRunTerminalHandler,
			});
			assert.equal(terminalTracker.rehydrateFromRegistry(context), 0);
			const seen = globalStore.__piSubagentVisibleControlNotices as ControlNotificationDedupeStore;
			assert.equal(seen.byRunId.has("async-r1"), false);
		} finally {
			for (const state of states) cleanupPoller(state);
			setRegistryPathForTests(null);
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("foreground-transition-fires-control-event: foreground status tick emits one control event on needs_attention edge", (t) => {
		t.mock.timers.enable({ apis: ["Date"] });

		const bus = makeEventsBus();
		const config = { ...DEFAULT_CONTROL_CONFIG, needsAttentionAfterMs: 10_000 };
		let lastActivityAt: number | undefined = 0;
		const ticker = createActivityTicker({
			runId: "fg-r1",
			agent: "worker",
			index: 0,
			config,
			getStartedAt: () => 0,
			getLastActivityAt: () => lastActivityAt,
			onNeedsAttention: (event) => emitForegroundNeedsAttention(bus, event),
		});

		assert.equal(ticker.tick(), undefined);
		t.mock.timers.tick(10_000);
		assert.equal(ticker.tick(), undefined, "exact threshold is not enough");
		t.mock.timers.tick(1);
		assert.equal(ticker.tick(), "needs_attention");

		assert.equal(bus.countOf(SUBAGENT_CONTROL_EVENT), 1);
		assert.equal(bus.countOf(SUBAGENT_NEEDS_ATTENTION_EVENT), 1);
		const payload = bus.payloadsFor(SUBAGENT_CONTROL_EVENT)[0] as { event: ControlEvent; source: string };
		assert.equal(payload.source, "foreground");
		assert.equal(payload.event.runId, "fg-r1");
		assert.equal(payload.event.agent, "worker");
		assert.equal(payload.event.index, 0);
		assert.equal(payload.event.type, "needs_attention");
		assert.match(payload.event.message, /worker needs attention/);

		lastActivityAt = Date.now();
		ticker.stop();
	});

	it("async-transition-fires-control-event: async poll loop emits one control event on needs_attention edge", (t) => {
		t.mock.timers.enable({ apis: ["Date", "setInterval"] });

		const tmp = mkdtempSync(join(tmpdir(), "needs-attention-"));
		const bus = makeEventsBus();
		const config = { ...DEFAULT_CONTROL_CONFIG, needsAttentionAfterMs: 10_000 };
		const state = makeState(tmp, config);
		try {
			writeStatus(
				tmp,
				{
					runId: "async-r1",
					mode: "single",
					state: "running",
					startedAt: 0,
					lastUpdate: 0,
					lastActivityAt: 0,
					currentStep: 0,
					steps: [{ agent: "worker", status: "running", startedAt: 0, lastActivityAt: 0 }],
				},
				0,
			);
			const tracker = createAsyncJobTracker({ events: bus } as never, state, { pollIntervalMs: 5_000 });
			tracker.ensurePoller();

			t.mock.timers.tick(10_000);
			assert.equal(bus.countOf(SUBAGENT_CONTROL_EVENT), 0, "no emit before threshold is exceeded");

			t.mock.timers.tick(5_000);
			assert.equal(bus.countOf(SUBAGENT_CONTROL_EVENT), 1);
			assert.equal(bus.countOf(SUBAGENT_NEEDS_ATTENTION_EVENT), 1);

			t.mock.timers.tick(10_000);
			assert.equal(
				bus.countOf(SUBAGENT_CONTROL_EVENT),
				1,
				"same needs_attention state is deduped by edge detection",
			);

			const payload = bus.payloadsFor(SUBAGENT_CONTROL_EVENT)[0] as { event: ControlEvent; source: string };
			assert.equal(payload.source, "async");
			assert.equal(payload.event.runId, "async-r1");
			assert.equal(payload.event.agent, "worker");
			assert.equal(payload.event.type, "needs_attention");
		} finally {
			cleanupPoller(state);
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("no-real-sleeps-uses-fake-timers: fake time crosses the threshold in under 100ms wall-clock", (t) => {
		const wallStart = performance.now();
		t.mock.timers.enable({ apis: ["Date"] });

		const events: ControlEvent[] = [];
		const ticker = createActivityTicker({
			runId: "fg-fast",
			agent: "worker",
			config: { ...DEFAULT_CONTROL_CONFIG, needsAttentionAfterMs: 60_000 },
			getStartedAt: () => 0,
			getLastActivityAt: () => 0,
			onNeedsAttention: (event) => events.push(event),
		});

		t.mock.timers.tick(60_001);
		ticker.tick();

		assert.equal(events.length, 1);
		assert.ok(performance.now() - wallStart < 100, "test must not wait for real time");
		ticker.stop();
	});

	it("dedup-on-same-state: consecutive needs_attention ticks emit only once", (t) => {
		t.mock.timers.enable({ apis: ["Date"] });

		const events: ControlEvent[] = [];
		const ticker = createActivityTicker({
			runId: "fg-dedupe",
			agent: "worker",
			config: { ...DEFAULT_CONTROL_CONFIG, needsAttentionAfterMs: 5_000 },
			getStartedAt: () => 0,
			getLastActivityAt: () => 0,
			onNeedsAttention: (event) => events.push(event),
		});

		t.mock.timers.tick(5_001);
		ticker.tick();
		ticker.tick();
		t.mock.timers.tick(10_000);
		ticker.tick();

		assert.equal(events.length, 1);
		ticker.stop();
	});

	it("re-entry-fires-again: needs_attention → idle → needs_attention emits twice", (t) => {
		t.mock.timers.enable({ apis: ["Date"] });

		const events: ControlEvent[] = [];
		let lastActivityAt = 0;
		const ticker = createActivityTicker({
			runId: "fg-reentry",
			agent: "worker",
			config: { ...DEFAULT_CONTROL_CONFIG, needsAttentionAfterMs: 5_000 },
			getStartedAt: () => 0,
			getLastActivityAt: () => lastActivityAt,
			onNeedsAttention: (event) => events.push(event),
		});

		t.mock.timers.tick(5_001);
		ticker.tick();
		lastActivityAt = Date.now();
		assert.equal(ticker.tick(), undefined, "activity resets the latch");
		t.mock.timers.tick(5_001);
		ticker.tick();

		assert.equal(events.length, 2);
		ticker.stop();
	});
});
