import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { renderWidget } from "./render-widget.ts";
import { deriveRunDisplayState, displayStatePriority, isRunnerHardDead } from "../state/run-liveness.ts";
import { reconcileRunToTerminalOnDisk } from "../state/status-writer.ts";
import {
	DEFAULT_CONTROL_CONFIG,
	buildControlEvent,
	deriveActivityState,
	formatControlNoticeMessage,
	shouldEmitControlEvent,
	shouldNotifyControlEvent,
} from "../dispatch/subagent-control.ts";
import {
	type ActivityState,
	type AsyncJobState,
	type ControlEvent,
	type ResolvedControlConfig,
	type SubagentState,
	POLL_INTERVAL_MS,
	SUBAGENT_ASYNC_STARTED_EVENT,
	SUBAGENT_CONTROL_EVENT,
	SUBAGENT_NEEDS_ATTENTION_EVENT,
	type SubagentNeedsAttentionPayload,
} from "../protocol/types.ts";
import type { IdleTracker } from "./idle-tracker.ts";
import { readStatus } from "../shared/utils.ts";
import { readAllEntries } from "../state/runs-registry.ts";
import { readLeafRunViewCached } from "../state/async-status.ts";
import { readWorkflowGroupState, writeWorkflowGroupState } from "../workflow/workflow-group-state.ts";
import { computeGroupStatus } from "../state/group-status.ts";
import { logger } from "../shared/logger.ts";
import type { UtilsClient } from "pi-extension-utils";

interface AsyncJobTrackerOptions {
	completionRetentionMs?: number;
	pollIntervalMs?: number;
	idleTracker?: IdleTracker;
	getWidgetClient?: (ctx: ExtensionContext) => UtilsClient | undefined;
	onRunTerminal?: (payload: unknown) => void;
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

// Durable done/running/queued tally for a workflow group. The runs registry
// holds EVERY child (append-only by parentRunId) and survives the 10s live-map
// cleanup, so it is the authoritative denominator-free source. Live children
// (passed in) carry fresher status for the ones still in the map; a registry
// child absent from the live map is necessarily terminal (only terminal jobs
// are cleaned), so it counts as done. Terminal child reads are mtime-cached.
function countWorkflowChildren(
	groupRunId: string,
	liveChildren: AsyncJobState[],
): { done: number; running: number; queued: number } {
	const liveById = new Map(liveChildren.map((child) => [child.asyncId, child]));
	const counts = { done: 0, running: 0, queued: 0 };
	const seen = new Set<string>();
	const bucket = (status: AsyncJobLifecycleStatus) => {
		if (isTerminalAsyncStatus(status)) counts.done++;
		else if (status === "queued") counts.queued++;
		else counts.running++;
	};
	for (const entry of readAllEntries()) {
		if (entry.parentRunId !== groupRunId || seen.has(entry.runId)) continue;
		seen.add(entry.runId);
		const live = liveById.get(entry.runId);
		if (live) {
			bucket(live.status);
			continue;
		}
		// Cleaned from the live map -> resolve its terminal state from disk; a
		// readable status.json gives the precise terminal kind, else treat the
		// vanished-but-registered child as done (it was cleaned, hence terminal).
		const summary = readLeafRunViewCached(entry.runRecordDir);
		bucket((summary?.state as AsyncJobLifecycleStatus) ?? "complete");
	}
	// Registry write can lag the live childStarted; never report fewer than the
	// live map already knows about.
	for (const child of liveChildren) {
		if (!seen.has(child.asyncId)) bucket(child.status);
	}
	return counts;
}

function deriveAsyncJobActivityState(
	job: AsyncJobState,
	config: ResolvedControlConfig,
	now = Date.now(),
): ActivityState | undefined {
	if (isTerminalAsyncStatus(job.status)) return undefined;
	return deriveActivityState({
		config,
		startedAt: job.startedAt ?? now,
		lastActivityAt: job.lastActivityAt,
		executionStartedAt: job.executionStartedAt,
		// A queued job is blocked on a leaf permit, not stalled: suppress the stall
		// timer so the poll loop never fires needs_attention for mere queue-wait.
		queued: job.status === "queued",
		phase: job.phase,
		now,
	});
}

function emitAsyncControlNotification(
	pi: Pick<ExtensionAPI, "events">,
	config: ResolvedControlConfig,
	event: ControlEvent,
): void {
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

export function createAsyncJobTracker(
	pi: Pick<ExtensionAPI, "events">,
	state: SubagentState,
	options: AsyncJobTrackerOptions = {},
): {
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
	const getWidgetClient = options.getWidgetClient;
	const onRunTerminal = options.onRunTerminal;
	const lastActivityStateByRunId = new Map<string, ActivityState | undefined>();
	// Runs whose completion notification already reached the host turn. Guards
	// the delivered-before-complete listener-order race: notify may emit the
	// delivered event before this tracker's own complete handler runs.
	const deliveredRunIds = new Set<string>();
	const rerenderWidget = (ctx: ExtensionContext, jobs = Array.from(state.asyncJobs.values())) => {
		// renderWidget captures TUI.requestRender for animation ticks; the SDK's
		// ExtensionUIContext exposes no repaint API of its own.
		renderWidget(ctx, jobs, getWidgetClient?.(ctx));
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
			emitAsyncControlNotification(
				pi,
				config,
				buildControlEvent({
					from: previous,
					to: current,
					runId: job.asyncId,
					agent: asyncAgentName(job),
					index: job.currentStep,
					lastActivityAt: job.lastActivityAt,
					activityAt: job.lastActivityAt ?? job.executionStartedAt ?? job.startedAt,
				}),
			);
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
						const children = [...state.asyncJobs.values()].filter(
							(child) => child.parentRunId === job.asyncId,
						);
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
						// Durable child tally from the runs registry (children by parentRunId,
						// resolved via status.json). The live asyncJobs map is NOT a reliable
						// source: completed children are cleaned out after completionRetentionMs,
						// so a live-only "done" collapses toward 0 while the run is still going.
						job.childCounts = countWorkflowChildren(job.asyncId, children);
						// Keep currentStep as the durable done count for activity-notice indexing;
						// drop the meaningless stepsTotal fraction (N is unknowable for workflows).
						job.currentStep = job.childCounts.done;
						job.stepsTotal = undefined;
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
							(best, child) =>
								displayStatePriority(child.displayState) < displayStatePriority(best)
									? child.displayState
									: best,
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
						job.lastActivityAt =
							status.lastActivityAt ??
							currentStepRecord?.lastActivityAt ??
							currentStepRecord?.startedAt ??
							job.lastActivityAt;
						job.currentTool = isTerminalAsyncStatus(job.status)
							? undefined
							: (status.currentTool ?? job.currentTool);
						job.currentToolStartedAt = isTerminalAsyncStatus(job.status)
							? undefined
							: (status.currentToolStartedAt ?? job.currentToolStartedAt);
						job.mode = status.mode;
						// charter nested-subagent-display: mirror parent id for widget hierarchy.
						job.parentRunId = status.parentRunId;
						if (status.label !== undefined) job.label = status.label;
						job.currentStep = status.currentStep ?? job.currentStep;
						job.stepsTotal = status.steps?.length ?? job.stepsTotal;
						job.startedAt = status.startedAt ?? job.startedAt;
						job.executionStartedAt = status.executionStartedAt ?? job.executionStartedAt;
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
							runnerPid: status.runnerPid,
							runnerToken: status.runnerToken,
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
		const asyncDir =
			info.asyncDir ?? readAllEntries({ limit: 1 }).find((entry) => entry.runId === info.id)?.runRecordDir;
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
			...(status?.executionStartedAt !== undefined ? { executionStartedAt: status.executionStartedAt } : {}),
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
		logger.info("handleComplete: FIRED", {
			id: asyncId,
			success: result.success,
			inMap: asyncId ? state.asyncJobs.has(asyncId) : false,
			hasUi: !!state.lastUiContext,
		});
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
		const runIds = Array.isArray(info?.runIds)
			? info.runIds.filter((id): id is string => typeof id === "string")
			: [];
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

	// Reclaimed runs must be re-announced on the bus: cross-extension listeners
	// (e.g. pi-charter's Ralph loop) track running subagents via async-started/
	// complete events and lose that state on host reload. Only the idle tracker
	// and the bus are notified; state.asyncJobs is still populated by the caller
	// (this tracker's own handleStarted listener tolerates the self-emitted
	// event — it overwrites the same runId key and the poller corrects status).
	const announceReclaimed = (runId: string, asyncDir: string, agent?: string, parentRunId?: string): void => {
		idleTracker?.onAsyncStarted(runId);
		try {
			pi.events.emit(SUBAGENT_ASYNC_STARTED_EVENT, {
				id: runId,
				runId,
				asyncDir,
				reclaimed: true,
				...(agent ? { agent } : {}),
				...(parentRunId ? { parentRunId } : {}),
			});
		} catch {
			// Bus listeners must not break session rehydration.
		}
	};

	const rehydrateFromRegistry = (ctx?: ExtensionContext): number => {
		const hostSessionId = ctx?.sessionManager?.getSessionId?.();
		if (!hostSessionId) return 0;
		let added = 0;
		for (const entry of readAllEntries()) {
			if ((entry.rootSessionId ?? entry.parentSessionId) !== hostSessionId) continue;
			// Persist a stale orphan (sync OR async) whose owning activation died, BEFORE
			// the async-only reclaim guard so sync foreground singles get reaped too. The
			// read path (readStatus) derives a non-terminal record untouched past the mtime
			// ceiling to `lost` read-only; a derived-lost state therefore means the on-disk
			// file is still non-terminal (queued/running) and must be written through the
			// funnel so it stops re-deriving on every read and becomes resumable. The funnel
			// re-checks the same mtime/codec discriminant, so a live registry-owned run
			// (fresh mtime, still holding/awaiting a permit) is never written. This persists
			// only; sync orphans stay out of the async widget via the guard just below.
			try {
				if (readStatus(entry.runRecordDir)?.state === "lost") {
					reconcileRunToTerminalOnDisk(entry.runRecordDir, "lost");
				}
			} catch {
				// Swallow fs read/write failures (ENOSPC/EROFS/EACCES) so one bad entry can't
				// abort the whole sweep; the next sweep retries. (readStatus throws on
				// non-ENOENT stat/read errors; the funnel can throw on write.)
			}
			// The async widget renders state.asyncJobs, so only ASYNC runs may enter it.
			// A non-terminal sync (foreground) run lives in state.foregroundControls and
			// renders inline; reclaiming it here would leak it into the async widget.
			if (entry.source !== "async") continue;
			if (state.asyncJobs.has(entry.runId)) continue;
			// Workflow groups are statusless; their liveness comes from the
			// lifecycle marker. A reclaimed group's orchestrator ran in-process and
			// has no resume path, so reaching this sweep means it died: its
			// "running" marker is permanently stale. Finalize it from the children
			// (the same computeGroupStatus the dashboard uses) and persist the
			// terminal marker so it stops re-deriving as a zombie on every reload —
			// the symmetric counterpart to the hard-dead leaf finalize below.
			if (entry.kind === "workflow") {
				if (readWorkflowGroupState(entry.runRecordDir) !== "running") continue;
				const childStates = readAllEntries()
					.filter((child) => child.parentRunId === entry.runId)
					.map((child) => readLeafRunViewCached(child.runRecordDir)?.state ?? "complete");
				writeWorkflowGroupState(entry.runRecordDir, computeGroupStatus(childStates));
				continue;
			}
			const status = readStatus(entry.runRecordDir);
			if (!status) continue;
			if (isTerminalAsyncStatus(status.state)) {
				const stepIndex = status.currentStep;
				const agent = status.steps?.[stepIndex ?? 0]?.agent;
				onRunTerminal?.({
					runId: entry.runId,
					...(agent ? { agent } : {}),
					...(stepIndex !== undefined ? { taskIndex: stepIndex } : {}),
				});
				continue;
			}
			// An ungracefully killed runner (SIGKILL/session crash) leaves status.json
			// frozen at 'running' with a stale heartbeat. Finalize it to terminal-lost
			// on disk so it becomes resumable, and skip the live-reclaim branch. The
			// write is best-effort: a recovery sweep must never break session rehydration.
			if (status.state === "running" && isRunnerHardDead(status)) {
				try {
					reconcileRunToTerminalOnDisk(entry.runRecordDir, "lost");
				} catch {
					// Swallow fs write failures (ENOSPC/EROFS/EACCES); the next sweep retries.
				}
				continue;
			}
			const agents = entry.agentNames ?? (entry.agentName ? [entry.agentName] : undefined);
			announceReclaimed(entry.runId, entry.runRecordDir, agents?.[0], entry.parentRunId ?? status.parentRunId);
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
				...(status.executionStartedAt !== undefined ? { executionStartedAt: status.executionStartedAt } : {}),
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
