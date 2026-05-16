import * as fs from "node:fs";
import type { ActivityState, RunDisplayState } from "./types.ts";

export const RUNNER_HEARTBEAT_STALE_MS = 15_000;
export const RUNNER_WORKING_RECENT_MS = 5_000;

export interface RunDisplayStateInput {
	state: "queued" | "running" | "complete" | "failed" | "paused" | string;
	activityState?: ActivityState;
	currentTool?: string;
	lastActivityAt?: number;
	lastUpdate?: number;
	runnerHeartbeatAt?: number;
	pid?: number;
	resultPath?: string;
	now?: number;
	heartbeatStaleMs?: number;
	workingRecentMs?: number;
}

export function isPidAlive(pid: number | undefined): boolean | undefined {
	if (pid === undefined) return undefined;
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return code === "EPERM" ? true : false;
	}
}

function fileExists(filePath: string | undefined): boolean {
	if (!filePath) return false;
	try {
		return fs.existsSync(filePath);
	} catch {
		return false;
	}
}

export function deriveRunDisplayState(input: RunDisplayStateInput): RunDisplayState | undefined {
	if (input.state === "queued") return "quiet";
	if (input.state !== "running") return undefined;

	const now = input.now ?? Date.now();
	const heartbeatAt = input.runnerHeartbeatAt ?? input.lastUpdate;
	const heartbeatAge = heartbeatAt !== undefined ? now - heartbeatAt : undefined;
	const heartbeatStaleMs = input.heartbeatStaleMs ?? RUNNER_HEARTBEAT_STALE_MS;
	const pidAlive = isPidAlive(input.pid);
	if (
		heartbeatAge !== undefined
		&& heartbeatAge > heartbeatStaleMs
		&& pidAlive === false
		&& !fileExists(input.resultPath)
	) {
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
