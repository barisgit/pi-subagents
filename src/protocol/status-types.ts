import type { SubmitResultEnvelope } from "./submit-result.ts";

/** Observable execution phase for a child agent run. */
export type RunPhase =
	| "idle"
	| "waiting_model"
	| "thinking"
	| "streaming_text"
	| "finishing"
	| "tool_running"
	| "tool_streaming"
	| "retrying"
	| "queued_follow_up"
	| "paused";

export type ChildAgentExitState = "complete" | "failed" | "interrupted";

export interface ChildUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

export interface ChildAgentResult {
	runId: string;
	stepIndex: number;
	state: ChildAgentExitState;
	exitCode: 0 | 1;
	outputText: string;
	toolCallCount: number;
	toolResultCount: number;
	toolErrorCount: number;
	durationMs: number;
	startedAt: number;
	endedAt: number;
	sessionFile: string;
	shareUrl?: string;
	error?: { message: string; reason?: string };
	/**
	 * Aggregate token + cost usage for this child run.
	 *
	 * Accumulated inside the in-process executor by watching assistant
	 * `message_end` events on the child's AgentSession AND by reading nested
	 * `details.totalUsage` off any `subagent` tool_execution_end results.
	 * Equals the full descendant tree, not just direct turns.
	 */
	usage?: ChildUsage;
	structuredResult?: SubmitResultEnvelope;
}

export interface StatusPatch {
	runId: string;
	stepIndex: number;
	state?: ChildAgentExitState | "running" | "queued";
	activity?: { state: string; toolName?: string; updatedAt: number };
	liveText?: string;
	toolCallDelta?: number;
	toolResultDelta?: number;
	toolErrorDelta?: number;
	endedAt?: number;
	outputText?: string;
	phase?: RunPhase;
	phaseStartedAt?: number;
	runnerHeartbeatAt?: number;
	toolName?: string;
	tokens?: { input: number; output: number; cacheRead?: number; cacheWrite?: number; total: number };
}
