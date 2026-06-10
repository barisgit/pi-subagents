import type { RunPhase } from "./run-phase.ts";
import type { ActivityState, RunDisplayState } from "../protocol/types.ts";

export const RUNNER_HEARTBEAT_STALE_MS = 15_000;
export const RUNNER_HARD_DEAD_MS = 30_000;
export const RUNNER_WORKING_RECENT_MS = 5_000;

export interface RunDisplayStateInput {
	state: "queued" | "running" | "complete" | "failed" | "paused" | string;
	activityState?: ActivityState;
	currentTool?: string;
	phase?: RunPhase;
	phaseStartedAt?: number;
	lastActivityAt?: number;
	lastUpdate?: number;
	runnerHeartbeatAt?: number;
	now?: number;
	heartbeatStaleMs?: number;
	hardDeadMs?: number;
	workingRecentMs?: number;
}

export function deriveRunDisplayState(input: RunDisplayStateInput): RunDisplayState | undefined {
	if (input.state === "queued") return "quiet";
	if (input.state !== "running") return undefined;

	const now = input.now ?? Date.now();
	const heartbeatAt = input.runnerHeartbeatAt ?? input.lastUpdate;
	const heartbeatAge = heartbeatAt !== undefined ? now - heartbeatAt : undefined;
	const heartbeatStaleMs = input.heartbeatStaleMs ?? RUNNER_HEARTBEAT_STALE_MS;
	const hardDeadMs = input.hardDeadMs ?? RUNNER_HARD_DEAD_MS;
	if (heartbeatAge !== undefined && heartbeatAge > hardDeadMs) {
		return "lost";
	}
	const phaseCanBeLost = input.phase === undefined || input.phase === "idle";
	if (phaseCanBeLost && heartbeatAge !== undefined && heartbeatAge > heartbeatStaleMs) {
		return "lost";
	}

	if (input.currentTool) return "tool_running";
	if (input.activityState === "needs_attention") return "needs_attention";
	const recentMs = input.workingRecentMs ?? RUNNER_WORKING_RECENT_MS;
	const recentAt = Math.max(input.lastActivityAt ?? 0, heartbeatAt ?? 0);
	return recentAt > 0 && now - recentAt <= recentMs ? "working" : "quiet";
}

export function displayStatePriority(state: RunDisplayState | undefined): number {
	switch (state) {
		case "lost": return 0;
		case "needs_attention": return 1;
		case "tool_running": return 2;
		case "working": return 3;
		case "quiet": return 4;
		default: return 5;
	}
}

export interface RunDisplaySortProjection {
	displayState?: RunDisplayState;
	activityState?: ActivityState;
	startedAt?: number;
	endedAt?: number;
	updatedAt?: number;
	state?: "queued" | "running" | "complete" | "failed" | "paused" | "lost" | string;
}

function activeDisplayBucket(run: RunDisplaySortProjection): boolean {
	return run.state === "queued" || run.state === "running" || run.displayState !== undefined;
}

function terminalDisplayKey(run: RunDisplaySortProjection): number {
	return run.endedAt ?? run.updatedAt ?? run.startedAt ?? 0;
}

export function compareRunsForDisplay(a: RunDisplaySortProjection, b: RunDisplaySortProjection): number {
	const displayA = displayStatePriority(a.displayState ?? (a.activityState === "needs_attention" ? "needs_attention" : undefined));
	const displayB = displayStatePriority(b.displayState ?? (b.activityState === "needs_attention" ? "needs_attention" : undefined));
	if (displayA !== displayB) return displayA - displayB;
	const activeA = activeDisplayBucket(a);
	const activeB = activeDisplayBucket(b);
	if (activeA || activeB) return (b.startedAt ?? 0) - (a.startedAt ?? 0);
	return terminalDisplayKey(b) - terminalDisplayKey(a);
}
