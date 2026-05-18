import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { renderWidget } from "./render.ts";
import { deriveRunDisplayState } from "./run-liveness.ts";
import { formatControlNoticeMessage } from "./subagent-control.ts";
import {
	type AsyncJobState,
	type ControlEvent,
	type SubagentState,
	POLL_INTERVAL_MS,
	RESULTS_DIR,
	SUBAGENT_CONTROL_EVENT,
	SUBAGENT_CONTROL_INTERCOM_EVENT,
} from "./types.ts";
import { readStatus } from "./utils.ts";

interface AsyncJobTrackerOptions {
	completionRetentionMs?: number;
	pollIntervalMs?: number;
}

type AsyncJobLifecycleStatus = AsyncJobState["status"];

function isTerminalAsyncStatus(status: AsyncJobLifecycleStatus): boolean {
	return status === "complete" || status === "failed" || status === "paused" || status === "lost";
}

export function createAsyncJobTracker(pi: Pick<ExtensionAPI, "events">, state: SubagentState, asyncDirRoot: string, options: AsyncJobTrackerOptions = {}): {
	ensurePoller: () => void;
	handleStarted: (data: unknown) => void;
	handleComplete: (data: unknown) => void;
	resetJobs: (ctx?: ExtensionContext) => void;
} {
	const completionRetentionMs = options.completionRetentionMs ?? 10000;
	const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
	const rerenderWidget = (ctx: ExtensionContext, jobs = Array.from(state.asyncJobs.values())) => {
		renderWidget(ctx, jobs);
		ctx.ui.requestRender?.();
	};
	const scheduleCleanup = (asyncId: string) => {
		const existingTimer = state.cleanupTimers.get(asyncId);
		if (existingTimer) clearTimeout(existingTimer);
		const timer = setTimeout(() => {
			state.cleanupTimers.delete(asyncId);
			state.asyncJobs.delete(asyncId);
			if (state.lastUiContext) {
				rerenderWidget(state.lastUiContext);
			}
		}, completionRetentionMs);
		timer.unref?.();
		state.cleanupTimers.set(asyncId, timer);
	};
	const emitNewControlEvents = (job: AsyncJobState) => {
		const eventsPath = path.join(job.asyncDir, "events.jsonl");
		let fd: number;
		try {
			fd = fs.openSync(eventsPath, "r");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			console.error(`Failed to open async control events for '${job.asyncDir}':`, error);
			return;
		}
		try {
			const stat = fs.fstatSync(fd);
			const cursor = stat.size < (job.controlEventCursor ?? 0) ? 0 : (job.controlEventCursor ?? 0);
			if (stat.size <= cursor) return;
			const buffer = Buffer.alloc(stat.size - cursor);
			fs.readSync(fd, buffer, 0, buffer.length, cursor);
			const lastNewline = buffer.lastIndexOf(0x0a);
			if (lastNewline === -1) return;
			job.controlEventCursor = cursor + lastNewline + 1;
			for (const line of buffer.subarray(0, lastNewline).toString("utf-8").split("\n")) {
				if (!line.trim()) continue;
				let parsed: unknown;
				try {
					parsed = JSON.parse(line);
				} catch {
					// Ignore malformed completed records but keep the poller alive for later events.
					continue;
				}
				if (!parsed || typeof parsed !== "object" || (parsed as { type?: unknown }).type !== "subagent.control") continue;
				const record = parsed as { event?: ControlEvent; channels?: string[]; childIntercomTarget?: string; noticeText?: string; intercom?: { to?: string; message?: string } };
				if (!record.event || !Array.isArray(record.channels)) continue;
				const payload = {
					event: record.event,
					source: "async" as const,
					asyncDir: job.asyncDir,
					childIntercomTarget: record.childIntercomTarget,
					noticeText: record.noticeText ?? formatControlNoticeMessage(record.event, record.childIntercomTarget),
				};
				if (record.channels.includes("event")) {
					pi.events.emit(SUBAGENT_CONTROL_EVENT, payload);
				}
				if (record.channels.includes("intercom") && record.intercom?.to && record.intercom.message) {
					pi.events.emit(SUBAGENT_CONTROL_INTERCOM_EVENT, {
						...payload,
						to: record.intercom.to,
						message: record.intercom.message,
					});
				}
			}
		} catch (error) {
			console.error(`Failed to read async control events for '${job.asyncDir}':`, error);
		} finally {
			fs.closeSync(fd);
		}
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
					const status = readStatus(job.asyncDir);
					if (status) {
						if (!previousStatusWasTerminal || isTerminalAsyncStatus(status.state)) {
							job.status = status.state;
						}
						job.activityState = isTerminalAsyncStatus(job.status) ? undefined : status.activityState;
						job.lastActivityAt = status.lastActivityAt ?? job.lastActivityAt;
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
						job.pid = status.pid ?? job.pid;
						job.displayState = deriveRunDisplayState({
							state: job.status,
							activityState: job.activityState,
							currentTool: job.currentTool,
							lastActivityAt: job.lastActivityAt,
							lastUpdate: status.lastUpdate,
							runnerHeartbeatAt: status.runnerHeartbeatAt,
							pid: status.pid,
							resultPath: path.join(RESULTS_DIR, `${status.runId || job.asyncId}.json`),
						});
						if (status.steps?.length) {
							job.agents = status.steps.map((step) => step.agent);
							// Mirror per-step colors so widget/dashboard can tint each sibling in a
							// parallel run with its own color. Undefined slots stay undefined.
							job.agentColors = status.steps.map((step) => step.live?.color);
							job.agentLabels = status.steps.map((step) => step.label);
							job.stepStatuses = status.steps.map((step) => step.status);
						}
						job.sessionDir = status.sessionDir ?? job.sessionDir;
						job.outputFile = status.outputFile ?? job.outputFile;
						job.totalTokens = status.totalTokens ?? job.totalTokens;
						job.sessionFile = status.sessionFile ?? job.sessionFile;
						// Mirror LiveStepProgress from currentStep onto flat job fields so the widget
						// can render color/sparkline/recent-tools without re-reading status.json shape.
						const currentStepRecord = status.steps?.[status.currentStep ?? 0];
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
							if (previousStatus !== job.status) scheduleCleanup(job.asyncId);
							continue;
						}
						emitNewControlEvents(job);
						continue;
					}
					if (isTerminalAsyncStatus(job.status)) continue;
					emitNewControlEvents(job);
					job.status = job.status === "queued" ? "running" : job.status;
					job.displayState = deriveRunDisplayState({
						state: job.status,
						activityState: job.activityState,
						currentTool: job.currentTool,
						lastActivityAt: job.lastActivityAt,
						lastUpdate: job.updatedAt,
						runnerHeartbeatAt: job.runnerHeartbeatAt,
						pid: job.pid,
						resultPath: path.join(RESULTS_DIR, `${job.asyncId}.json`),
					});
				} catch (error) {
					console.error(`Failed to read async status for '${job.asyncDir}':`, error);
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
			chain?: string[];
		};
		if (!info.id) return;
		const now = Date.now();
		const asyncDir = info.asyncDir ?? path.join(asyncDirRoot, info.id);
		const agents = info.chain && info.chain.length > 0 ? info.chain : info.agent ? [info.agent] : undefined;
		state.asyncJobs.set(info.id, {
			asyncId: info.id,
			asyncDir,
			status: "queued",
			displayState: "quiet",
			mode: info.chain ? "chain" : "single",
			agents,
			stepsTotal: agents?.length,
			startedAt: now,
			updatedAt: now,
		});
		ensurePoller();
		if (state.lastUiContext) {
			rerenderWidget(state.lastUiContext);
		}
	};

	const handleComplete = (data: unknown) => {
		const result = data as { id?: string; success?: boolean; asyncDir?: string };
		const asyncId = result.id;
		if (!asyncId) return;
		const job = state.asyncJobs.get(asyncId);
		if (job) {
			job.status = result.success ? "complete" : "failed";
			job.displayState = undefined;
			job.updatedAt = Date.now();
			if (result.asyncDir) job.asyncDir = result.asyncDir;
		}
		if (state.lastUiContext) {
			rerenderWidget(state.lastUiContext);
		}
		scheduleCleanup(asyncId);
	};

	const resetJobs = (ctx?: ExtensionContext) => {
		for (const timer of state.cleanupTimers.values()) {
			clearTimeout(timer);
		}
		state.cleanupTimers.clear();
		state.asyncJobs.clear();
		state.foregroundControls?.clear();
		state.lastForegroundControlId = null;
		state.resultFileCoalescer.clear();
		if (ctx?.hasUI) {
			state.lastUiContext = ctx;
			rerenderWidget(ctx, []);
		}
	};

	return { ensurePoller, handleStarted, handleComplete, resetJobs };
}
