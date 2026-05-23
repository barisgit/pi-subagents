import type { RunPhase } from "./run-phase.ts";
import type { ActivityState, RunDisplayState } from "./types.ts";

export const RUNNER_HEARTBEAT_STALE_MS = 15_000;
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
	workingRecentMs?: number;
}

export function deriveRunDisplayState(input: RunDisplayStateInput): RunDisplayState | undefined {
	if (input.state === "queued") return "quiet";
	if (input.state !== "running") return undefined;

	const now = input.now ?? Date.now();
	const heartbeatAt = input.runnerHeartbeatAt ?? input.lastUpdate;
	const heartbeatAge = heartbeatAt !== undefined ? now - heartbeatAt : undefined;
	const heartbeatStaleMs = input.heartbeatStaleMs ?? RUNNER_HEARTBEAT_STALE_MS;
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
