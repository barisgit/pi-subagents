import { randomUUID } from "node:crypto";
import type { RunPhase } from "./run-phase.ts";
import type { ActivityState, RunDisplayState } from "../protocol/types.ts";
import { processGlobal } from "../shared/process-global.ts";

export const RUNNER_HEARTBEAT_STALE_MS = 15_000;
export const RUNNER_HARD_DEAD_MS = 30_000;
const RUNNER_WORKING_RECENT_MS = 5_000;

/**
 * Per-PROCESS runner identity token. Lives on globalThis (processGlobal) so it
 * survives an extension reload (same process, re-imported modules) but NOT a
 * process restart. Stamped into status.json next to runnerPid so liveness
 * checks can tell "reloaded but alive" apart from "killed and restarted"
 * without waiting out the heartbeat ceiling.
 */
export function currentRunnerToken(): string {
	return processGlobal("pi.subagents.runnerToken", () => randomUUID());
}

/**
 * Definitive dead-runner detection from persisted runner identity. Returns
 * true ONLY when the record's owning process provably no longer runs:
 * - runnerPid is stamped and that pid no longer exists (ESRCH), or
 * - runnerPid equals OUR pid while runnerToken is someone else's — pids are
 *   unique among live processes, so the record's true owner died and the OS
 *   reused its pid for us.
 * A matching runnerToken means the record is ours (possibly written before an
 * in-process reload) and is never identity-dead. Absent fields (records
 * written by older versions) yield false — callers fall back to the
 * heartbeat-ceiling behavior unchanged. A live foreign pid (another host
 * process legitimately owning the run) also yields false; EPERM on the probe
 * means the pid exists.
 */
export function isRunnerIdentityDead(input: { runnerPid?: number; runnerToken?: string }): boolean {
	if (input.runnerToken !== undefined && input.runnerToken === currentRunnerToken()) return false;
	if (input.runnerPid === undefined) return false;
	if (input.runnerPid === process.pid) return input.runnerToken !== undefined;
	try {
		process.kill(input.runnerPid, 0);
		return false;
	} catch (error) {
		// EPERM: pid exists but is not signalable by us => alive. Anything else
		// (ESRCH/ERANGE) => no such process => dead.
		return (error as NodeJS.ErrnoException).code !== "EPERM";
	}
}

export interface RunDisplayStateInput {
	state: "queued" | "running" | "complete" | "failed" | "paused" | string;
	activityState?: ActivityState;
	currentTool?: string;
	phase?: RunPhase;
	phaseStartedAt?: number;
	lastActivityAt?: number;
	lastUpdate?: number;
	runnerHeartbeatAt?: number;
	runnerPid?: number;
	runnerToken?: string;
	now?: number;
	heartbeatStaleMs?: number;
	hardDeadMs?: number;
	workingRecentMs?: number;
}

export function deriveRunDisplayState(input: RunDisplayStateInput): RunDisplayState | undefined {
	if (input.state === "queued") return "quiet";
	if (input.state !== "running") return undefined;

	// Identity check first: a provably dead runner is lost IMMEDIATELY, no
	// heartbeat-age wait (kill + quick restart leaves a fresh heartbeat behind).
	if (isRunnerIdentityDead(input)) return "lost";

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
	const recentAt =
		input.lastActivityAt === undefined
			? heartbeatAt
			: heartbeatAt === undefined
				? input.lastActivityAt
				: Math.max(input.lastActivityAt, heartbeatAt);
	return recentAt !== undefined && now - recentAt <= recentMs ? "working" : "quiet";
}

/**
 * True for a 'running' record whose runner is provably dead: either its runner
 * identity (pid/token) fails {@link isRunnerIdentityDead} — immediate, no
 * heartbeat wait — or its newest liveness timestamp (runnerHeartbeatAt,
 * falling back to lastUpdate) is older than the hard-dead ceiling. The
 * heartbeat path remains for records written by older versions (no identity
 * fields) and for a same-process wedged executor. Reuses the same
 * heartbeat-vs-hardDead read as deriveRunDisplayState.
 */
export function isRunnerHardDead(input: {
	state: string;
	runnerHeartbeatAt?: number;
	lastUpdate?: number;
	runnerPid?: number;
	runnerToken?: string;
	now?: number;
	hardDeadMs?: number;
}): boolean {
	if (input.state !== "running") return false;
	if (isRunnerIdentityDead(input)) return true;
	const now = input.now ?? Date.now();
	const last = input.runnerHeartbeatAt ?? input.lastUpdate;
	if (last === undefined) return false;
	const hardDeadMs = input.hardDeadMs ?? RUNNER_HARD_DEAD_MS;
	return now - last > hardDeadMs;
}

export function displayStatePriority(state: RunDisplayState | undefined): number {
	switch (state) {
		case "lost":
			return 0;
		case "needs_attention":
			return 1;
		case "tool_running":
			return 2;
		case "working":
			return 3;
		case "quiet":
			return 4;
		default:
			return 5;
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
	const displayA = displayStatePriority(
		a.displayState ?? (a.activityState === "needs_attention" ? "needs_attention" : undefined),
	);
	const displayB = displayStatePriority(
		b.displayState ?? (b.activityState === "needs_attention" ? "needs_attention" : undefined),
	);
	if (displayA !== displayB) return displayA - displayB;
	const activeA = activeDisplayBucket(a);
	const activeB = activeDisplayBucket(b);
	if (activeA || activeB) return (b.startedAt ?? 0) - (a.startedAt ?? 0);
	return terminalDisplayKey(b) - terminalDisplayKey(a);
}
