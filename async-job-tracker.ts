import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { renderWidget } from "./render.ts";
import { deriveRunDisplayState, displayStatePriority } from "./run-liveness.ts";
import {
	DEFAULT_CONTROL_CONFIG,
	buildControlEvent,
	deriveActivityState,
	formatControlNoticeMessage,
	shouldEmitControlEvent,
	shouldNotifyControlEvent,
} from "./subagent-control.ts";
import {
	type ActivityState,
	type AsyncJobState,
	type ControlEvent,
	type ResolvedControlConfig,
	type SubagentState,
	POLL_INTERVAL_MS,
	SUBAGENT_CONTROL_EVENT,
	SUBAGENT_NEEDS_ATTENTION_EVENT,
	type SubagentNeedsAttentionPayload,
} from "./types.ts";
import type { IdleTracker } from "./idle-tracker.ts";
import { readStatus } from "./utils.ts";
import { readAllEntries } from "./runs-registry.ts";
import { readWorkflowGroupState } from "./workflow-group-state.ts";
import { logger } from "./logger.ts";

interface AsyncJobTrackerOptions {
	completionRetentionMs?: number;
	pollIntervalMs?: number;
	idleTracker?: IdleTracker;
}

// Widen to string: the on-disk status.json can carry terminal exit states
// ('interrupted'/'skipped') that the narrow AsyncJobState['status'] union does
// not model, but which reclaim/cleanup must still treat as terminal.
type AsyncJobLifecycleStatus = AsyncJobState["status"] | string;

function isTerminalAsyncStatus(status: AsyncJobLifecycleStatus): boolean {
	// 'interrupted'/'skipped' are genuine terminal exit states (in-process-executor
	// ChildAgentExitState). Omitting them let reclaim re-attach a finished run on
	// every reload (and re-fire its stale needs-attention alarm). Keep this in sync
	// with the terminal sets in async-status.ts and subagent-executor.ts.
	return (
		status === "complete" ||
		status === "failed" ||
		status === "interrupted" ||
		status === "skipped" ||
		status === "paused" ||
		status === "lost"
	);
}

function asyncAgentName(job: AsyncJobState): string {
	return job.currentAgent ?? job.agents?.[job.currentStep ?? 0] ?? job.agents?.[0] ?? "unknown";
}

function deriveAsyncJobActivityState(job: AsyncJobState, config: ResolvedControlConfig, now = Date.now()): ActivityState | undefined {
	if (isTerminalAsyncStatus(job.status)) return undefined;
	return deriveActivityState({
		config,
		startedAt: job.startedAt ?? now,
		lastActivityAt: job.lastActivityAt,
		phase: job.phase,
		now,
	});
}

function emitAsyncControlNotification(pi: Pick<ExtensionAPI, "events">, config: ResolvedControlConfig, event: ControlEvent): void {
	if (!shouldNotifyControlEvent(config, event)) return;
	const payload = {
		event,
		source: "async" as const,
		noticeText: formatControlNoticeMessage(event),
	};
	if (config.notifyChannels.includes("event")) {
		pi.events.emit(SUBAGENT_CONTROL_EVENT, payload);
		if (event.type === "needs_attention") {
			pi.events.emit(SUBAGENT_NEEDS_ATTENTION_EVENT, {
				runId: event.runId,
				agent: event.agent,
				ts: event.ts,
				message: event.message,
				...(event.index !== undefined ? { index: event.index } : {}),
			} satisfies SubagentNeedsAttentionPayload);
		}
	}
}

export function createAsyncJobTracker(pi: Pick<ExtensionAPI, "events">, state: SubagentState, options: AsyncJobTrackerOptions = {}): {
	ensurePoller: () => void;
	handleStarted: (data: unknown) => void;
	handleComplete: (data: unknown) => void;
	resetJobs: (ctx?: ExtensionContext) => void;
	rehydrateFromRegistry: (ctx?: ExtensionContext) => number;
	handleDelivered: (data: unknown) => void;
} {
	const completionRetentionMs = options.completionRetentionMs ?? 10000;
	const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
	const idleTracker = options.idleTracker;
	const lastActivityStateByRunId = new Map<string, ActivityState | undefined>();
	// Runs whose completion notification already reached the host turn. Guards
	// the delivered-before-complete listener-order race: notify may emit the
	// delivered event before this tracker's own complete handler runs.
	const deliveredRunIds = new Set<string>();
	const rerenderWidget = (ctx: ExtensionContext, jobs = Array.from(state.asyncJobs.values())) => {
		renderWidget(ctx, jobs);
		// TODO(sdk-0.75-shape): ExtensionUIContext no longer exposes requestRender;
		// renderWidget now captures TUI.requestRender for animation ticks.
	};
	const scheduleCleanup = (asyncId: string) => {
		const existingTimer = state.cleanupTimers.get(asyncId);
		if (existingTimer) clearTimeout(existingTimer);
		const timer = setTimeout(() => {
			state.cleanupTimers.delete(asyncId);
			state.asyncJobs.delete(asyncId);
			lastActivityStateByRunId.delete(asyncId);
			deliveredRunIds.delete(asyncId);
			if (state.lastUiContext) {
				rerenderWidget(state.lastUiContext);
			}
		}, completionRetentionMs);
		timer.unref?.();
		state.cleanupTimers.set(asyncId, timer);
	};
	const updateActivityState = (job: AsyncJobState): ActivityState | undefined => {
		const config = job.controlConfig ?? DEFAULT_CONTROL_CONFIG;
		const previous = lastActivityStateByRunId.get(job.asyncId);
		const current = deriveAsyncJobActivityState(job, config);
		job.activityState = current;
		if (shouldEmitControlEvent(config, previous, current) && current) {
			emitAsyncControlNotification(pi, config, buildControlEvent({
				from: previous,
				to: current,
				runId: job.asyncId,
				agent: asyncAgentName(job),
				index: job.currentStep,
				lastActivityAt: job.lastActivityAt,
			}));
		}
		if (current === undefined) lastActivityStateByRunId.delete(job.asyncId);
		else lastActivityStateByRunId.set(job.asyncId, current);
		return current;
	};
	const ensurePoller = () => {
		if (state.poller) return;
		state.poller = setInterval(() => {
			if (state.asyncJobs.size === 0) {
				if (state.lastUiContext?.hasUI) rerenderWidget(state.lastUiContext, []);
				if (state.poller) {
					clearInterval(state.poller);
					state.poller = null;
				}
				return;
			}

			for (const job of state.asyncJobs.values()) {
				try {
					const previousStatus = job.status;
					const previousStatusWasTerminal = isTerminalAsyncStatus(previousStatus);
					// Workflow groups are statusless containers (no status.json): without
					// this branch the generic fallback below would see a never-updating
					// heartbeat and mark the group 'lost' while its children run fine.
					// Synthesize the row from the lifecycle marker + child jobs instead.
					if (job.kind === "workflow") {
						if (previousStatusWasTerminal) continue;
						const lifecycle = readWorkflowGroupState(job.asyncDir);
						const children = [...state.asyncJobs.values()].filter((child) => child.parentRunId === job.asyncId);
						if (lifecycle === "complete" || lifecycle === "failed") {
							job.status = lifecycle;
							job.displayState = undefined;
							job.updatedAt = Date.now();
							// A workflow notifies once on finish; keep the row until the
							// delivered event confirms that notification reached the host.
							if (!deliveredRunIds.has(job.asyncId)) {
								job.pendingDelivery = true;
							} else {
								job.pendingDelivery = false;
								scheduleCleanup(job.asyncId);
							}
							continue;
						}
						job.status = "running";
						const done = children.filter((child) => isTerminalAsyncStatus(child.status)).length;
						job.currentStep = done;
						job.stepsTotal = Math.max(job.stepsTotal ?? 0, children.length);
						// Surface the current phase: the most recently started non-terminal
						// child carries a 'Phase N: title' label from the workflow dispatcher.
						const active = children.filter((child) => !isTerminalAsyncStatus(child.status));
						const latest = (active.length > 0 ? active : children).reduce<AsyncJobState | undefined>(
							(best, child) => ((child.startedAt ?? 0) >= (best?.startedAt ?? 0) ? child : best),
							undefined,
						);
						if (latest?.label) job.label = latest.label;
						for (const child of children) {
							job.updatedAt = Math.max(job.updatedAt ?? 0, child.updatedAt ?? 0);
							job.runnerHeartbeatAt = Math.max(job.runnerHeartbeatAt ?? 0, child.runnerHeartbeatAt ?? 0);
						}
						// Liveliest child wins the group's display state.
						job.displayState = children.reduce<AsyncJobState["displayState"]>(
							(best, child) => (displayStatePriority(child.displayState) < displayStatePriority(best) ? child.displayState : best),
							undefined,
						);
						continue;
					}
					const status = readStatus(job.asyncDir);
					if (status) {
						const currentStepRecord = status.steps?.[status.currentStep ?? 0];
						if (!previousStatusWasTerminal || isTerminalAsyncStatus(status.state)) {
							job.status = status.state;
						}
						job.lastActivityAt = status.lastActivityAt ?? currentStepRecord?.lastActivityAt ?? currentStepRecord?.startedAt ?? job.lastActivityAt;
						job.currentTool = isTerminalAsyncStatus(job.status) ? undefined : (status.currentTool ?? job.currentTool);
						job.currentToolStartedAt = isTerminalAsyncStatus(job.status) ? undefined : (status.currentToolStartedAt ?? job.currentToolStartedAt);
						job.mode = status.mode;
						// charter nested-subagent-display: mirror parent id for widget hierarchy.
						job.parentRunId = status.parentRunId;
						if (status.label !== undefined) job.label = status.label;
						job.currentStep = status.currentStep ?? job.currentStep;
						job.stepsTotal = status.steps?.length ?? job.stepsTotal;
						job.startedAt = status.startedAt ?? job.startedAt;
						job.updatedAt = status.lastUpdate ?? Date.now();
						job.runnerHeartbeatAt = status.runnerHeartbeatAt ?? job.runnerHeartbeatAt;
						job.resumedAt = status.resumedAt;
						job.resumeCount = status.resumeCount ?? 0;
						if (status.phase !== undefined) job.phase = status.phase;
						if (status.phaseStartedAt !== undefined) job.phaseStartedAt = status.phaseStartedAt;
						const activityState = updateActivityState(job);
						job.displayState = deriveRunDisplayState({
							state: job.status,
							activityState,
							currentTool: job.currentTool,
							phase: job.phase,
							phaseStartedAt: job.phaseStartedAt,
							lastActivityAt: job.lastActivityAt,
							lastUpdate: status.lastUpdate,
							runnerHeartbeatAt: status.runnerHeartbeatAt,
						});
						if (status.steps?.length) {
							job.agents = status.steps.map((step) => step.agent ?? "");
							// Mirror per-step colors so widget/dashboard can tint each sibling in a
							// parallel run with its own color. Undefined slots stay undefined.
							job.agentColors = status.steps.map((step) => step.live?.color ?? "");
							job.agentLabels = status.steps.map((step) => step.label ?? "");
							job.stepStatuses = status.steps.map((step) => step.status);
						}
						job.sessionDir = status.sessionDir ?? job.sessionDir;
						job.outputFile = status.outputFile ?? job.outputFile;
						job.totalTokens = status.totalTokens ?? job.totalTokens;
						job.sessionFile = status.sessionFile ?? job.sessionFile;
						// Mirror LiveStepProgress from currentStep onto flat job fields so the widget
						// can render color/sparkline/recent-tools without re-reading status.json shape.
						const live = currentStepRecord?.live;
						const terminal = isTerminalAsyncStatus(job.status);
						if (live) {
							job.currentAgent = currentStepRecord?.agent ?? job.currentAgent;
							// agentColor and tokenSamples persist past terminal so the widget can keep
							// the tint and freeze the sparkline at its last sample.
							if (live.color !== undefined) job.agentColor = live.color;
							if (live.tokenSamples) job.tokenSamples = live.tokenSamples;
							if (terminal) {
								job.thinking = undefined;
								job.currentToolArgs = undefined;
								job.recentTools = undefined;
								job.lastToolEndAt = undefined;
							} else {
								job.thinking = live.thinking;
								job.currentToolArgs = live.currentToolArgs;
								job.recentTools = live.recentTools;
								job.lastToolEndAt = live.lastToolEndAt;
							}
						} else if (terminal) {
							job.thinking = undefined;
							job.currentToolArgs = undefined;
							job.recentTools = undefined;
							job.lastToolEndAt = undefined;
						}
						if (isTerminalAsyncStatus(job.status)) {
							if (previousStatus !== job.status) {
								// complete/failed runs notify the host; keep the row (pending
								// delivery) until notify confirms the notification landed. An
								// interrupted/skipped run never notifies - retire it as before.
								const notifies = job.status === "complete" || job.status === "failed";
								if (notifies && !deliveredRunIds.has(job.asyncId)) {
									job.pendingDelivery = true;
								} else {
									job.pendingDelivery = false;
									scheduleCleanup(job.asyncId);
								}
							}
							continue;
						}
						continue;
					}
					if (isTerminalAsyncStatus(job.status)) continue;
					job.status = job.status === "queued" ? "running" : job.status;
					const activityState = updateActivityState(job);
					job.displayState = deriveRunDisplayState({
						state: job.status,
						activityState,
						currentTool: job.currentTool,
						phase: job.phase,
						phaseStartedAt: job.phaseStartedAt,
						lastActivityAt: job.lastActivityAt,
						lastUpdate: job.updatedAt,
						runnerHeartbeatAt: job.runnerHeartbeatAt,
					});
				} catch (error) {
					logger.error("Failed to read async status", error instanceof Error ? error : undefined, {
						asyncDir: job.asyncDir,
						error: error instanceof Error ? undefined : String(error),
					});
					job.status = "failed";
					job.displayState = undefined;
					job.updatedAt = Date.now();
				}
			}

			if (state.lastUiContext?.hasUI) rerenderWidget(state.lastUiContext);
		}, pollIntervalMs);
		state.poller.unref?.();
	};

	const handleStarted = (data: unknown) => {
		const info = data as {
			id?: string;
			asyncDir?: string;
			agent?: string;
			parentRunId?: string;
			kind?: string;
			controlConfig?: ResolvedControlConfig;
		};
		logger.info("handleStarted: FIRED", { id: info.id, agent: info.agent, hasUi: !!state.lastUiContext });
		if (!info.id) return;
		const now = Date.now();
		const asyncDir = info.asyncDir ?? readAllEntries({ limit: 1 }).find((entry) => entry.runId === info.id)?.runRecordDir;
		if (!asyncDir) {
			logger.warn("handleStarted: no asyncDir for runId", { id: info.id });
			return;
		}
		const agents = info.agent ? [info.agent] : undefined;
		const mode = info.parentRunId ? "parallel" : "single";
		const status = readStatus(asyncDir);
		idleTracker?.onAsyncStarted(info.id);
		state.asyncJobs.set(info.id, {
			asyncId: info.id,
			asyncDir,
			status: "queued",
			displayState: "quiet",
			mode,
			kind: info.kind === "workflow" ? "workflow" : undefined,
			parentRunId: info.parentRunId,
			agents,
			stepsTotal: agents?.length,
			startedAt: status?.startedAt ?? now,
			updatedAt: status?.lastUpdate ?? now,
			resumedAt: status?.resumedAt,
			resumeCount: status?.resumeCount ?? 0,
			controlConfig: info.controlConfig,
		});
		ensurePoller();
		if (state.lastUiContext) {
			rerenderWidget(state.lastUiContext);
		}
	};

	const handleComplete = (data: unknown) => {
		const result = data as { id?: string; success?: boolean; asyncDir?: string };
		const asyncId = result.id;
		logger.info("handleComplete: FIRED", { id: asyncId, success: result.success, inMap: asyncId ? state.asyncJobs.has(asyncId) : false, hasUi: !!state.lastUiContext });
		if (!asyncId) return;
		const job = state.asyncJobs.get(asyncId);
		if (job) {
			job.status = result.success ? "complete" : "failed";
			job.displayState = undefined;
			job.activityState = undefined;
			job.updatedAt = Date.now();
			if (result.asyncDir) job.asyncDir = result.asyncDir;
		}
		lastActivityStateByRunId.delete(asyncId);
		if (job && !deliveredRunIds.has(asyncId)) {
			// Hold the row until notify confirms the completion notification
			// actually reached the host turn (rollups can hold children open for
			// a while; interrupts can drop delivery entirely).
			job.pendingDelivery = true;
		} else {
			if (job) job.pendingDelivery = false;
			scheduleCleanup(asyncId);
		}
		if (state.lastUiContext) {
			rerenderWidget(state.lastUiContext);
		}
		idleTracker?.onAsyncFinished(asyncId);
	};

	const handleDelivered = (data: unknown) => {
		const info = data as { runIds?: unknown };
		const runIds = Array.isArray(info?.runIds) ? info.runIds.filter((id): id is string => typeof id === "string") : [];
		if (runIds.length === 0) return;
		let changed = false;
		for (const runId of runIds) {
			deliveredRunIds.add(runId);
			const job = state.asyncJobs.get(runId);
			if (!job) continue;
			if (job.pendingDelivery) {
				job.pendingDelivery = false;
				changed = true;
			}
			if (isTerminalAsyncStatus(job.status)) scheduleCleanup(runId);
		}
		if (changed && state.lastUiContext) {
			rerenderWidget(state.lastUiContext);
		}
	};

	const resetJobs = (ctx?: ExtensionContext) => {
		for (const timer of state.cleanupTimers.values()) {
			clearTimeout(timer);
		}
		state.cleanupTimers.clear();
		state.asyncJobs.clear();
		lastActivityStateByRunId.clear();
		deliveredRunIds.clear();
		state.foregroundControls?.clear();
		state.lastForegroundControlId = null;
		if (ctx?.hasUI) {
			state.lastUiContext = ctx;
			rerenderWidget(ctx, []);
		}
	};

	const rehydrateFromRegistry = (ctx?: ExtensionContext): number => {
		const hostSessionId = ctx?.sessionManager?.getSessionId?.();
		if (!hostSessionId) return 0;
		let added = 0;
		for (const entry of readAllEntries()) {
			if ((entry.rootSessionId ?? entry.parentSessionId) !== hostSessionId) continue;
			// The async widget renders state.asyncJobs, so only ASYNC runs may enter it.
			// A non-terminal sync (foreground) run lives in state.foregroundControls and
			// renders inline; reclaiming it here would leak it into the async widget.
			if (entry.source !== "async") continue;
			if (state.asyncJobs.has(entry.runId)) continue;
			// Workflow groups are statusless; their liveness comes from the
			// lifecycle marker. Reclaim still-running groups so the widget keeps
			// its single workflow row across a host reload.
			if (entry.kind === "workflow") {
				if (readWorkflowGroupState(entry.runRecordDir) !== "running") continue;
				state.asyncJobs.set(entry.runId, {
					asyncId: entry.runId,
					asyncDir: entry.runRecordDir,
					status: "running",
					displayState: "quiet",
					kind: "workflow",
					agents: ["workflow"],
					startedAt: entry.startedAt,
					updatedAt: Date.now(),
					resumeCount: 0,
					controlConfig: undefined,
				});
				added++;
				continue;
			}
			const status = readStatus(entry.runRecordDir);
			if (!status || isTerminalAsyncStatus(status.state)) continue;
			const agents = entry.agentNames ?? (entry.agentName ? [entry.agentName] : undefined);
			state.asyncJobs.set(entry.runId, {
				asyncId: entry.runId,
				asyncDir: entry.runRecordDir,
				status: status.state === "running" ? "running" : "queued",
				displayState: "quiet",
				mode: entry.mode,
				parentRunId: entry.parentRunId ?? status.parentRunId,
				agents,
				stepsTotal: entry.agentNames?.length ?? status.steps?.length,
				startedAt: status.startedAt ?? entry.startedAt,
				updatedAt: status.lastUpdate ?? Date.now(),
				runnerHeartbeatAt: status.runnerHeartbeatAt,
				resumedAt: status.resumedAt,
				resumeCount: status.resumeCount ?? 0,
				controlConfig: undefined,
			});
			added++;
		}
		if (added > 0) {
			ensurePoller();
			if (ctx?.hasUI) rerenderWidget(ctx);
		}
		return added;
	};

	return { ensurePoller, handleStarted, handleComplete, resetJobs, rehydrateFromRegistry, handleDelivered };
}
