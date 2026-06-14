import type { SubmitResultEnvelope } from "./submit-result.ts";
import type { ActivityState, ModelAttempt, RunDisplayState, TokenUsage, Usage } from "./types.ts";

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

/**
 * Slim live-progress snapshot stamped onto a running step in status.json so the
 * widget poller (async-job-tracker) can render the same color/sparkline/history UI
 * that inline rendering gets from AgentProgress.
 *
 * Unified shape: carries BOTH the foreground/sync writer fields (outputText,
 * toolCallCount/toolResultCount/toolErrorCount) and the async runner fields
 * (currentToolArgs, recentTools, tokenSamples, lastToolEndAt, toolCount, tokens).
 * All optional, so neither writer changes the bytes it writes.
 */
export interface LiveStepProgress {
	color?: string;
	thinking?: string;
	/** Current execution phase for this step, persisted additively by status-writer. */
	phase?: RunPhase;
	/** Milliseconds since epoch when this step's current phase was entered. */
	phaseStartedAt?: number;
	/** Live output text written by the foreground/sync status path. */
	outputText?: string;
	toolCallCount?: number;
	toolResultCount?: number;
	toolErrorCount?: number;
	currentToolArgs?: string;
	recentTools?: Array<{ tool: string; args?: string; rawArgs?: Record<string, unknown>; endMs: number; durationMs?: number }>;
	tokenSamples?: Array<{ ts: number; tokens: number }>;
	lastToolEndAt?: number;
	toolCount?: number;
	tokens?: number;
}

/**
 * One persisted step within {@link PersistedRunStatus}. Unified union of the
 * fields the async runner writes and the fields the foreground/sync writer
 * writes; every divergent field is optional so neither writer's bytes change.
 */
export interface PersistedRunStep {
	agent?: string;
	label?: string;
	status: string;
	activityState?: ActivityState;
	displayState?: RunDisplayState;
	lastActivityAt?: number;
	currentTool?: string;
	currentToolStartedAt?: number;
	startedAt?: number;
	endedAt?: number;
	durationMs?: number;
	tokens?: TokenUsage;
	skills?: string[];
	model?: string;
	attemptedModels?: string[];
	modelAttempts?: ModelAttempt[];
	error?: string;
	live?: LiveStepProgress;
	sessionFile?: string;
}

/**
 * Canonical persisted shape of a run's status.json. The single writer
 * (StatusWriter) writes it and the single reader (shared/utils.ts readStatus,
 * state/async-status.ts statusToSummary) reads it. Unifies the former
 * AsyncStatus (protocol/types.ts) and StatusPayload (state/status-writer.ts):
 * every field present in only one of the two is optional here, so the union
 * widens the type without changing the bytes either writer emits.
 */
export interface PersistedRunStatus {
	/** Schema version stamped by the writer (STATUS_JSON_VERSION). */
	version?: number;
	runId: string;
	// charter nested-subagent-display: persisted parent link for hierarchy rendering.
	parentRunId?: string;
	mode: "single" | "parallel";
	/** Run-level caller-provided summary; populated for single runs and uniform-label parallel runs. */
	label?: string;
	state: "queued" | "running" | "complete" | "failed" | "paused" | "lost" | "interrupted" | "skipped";
	activityState?: ActivityState;
	displayState?: RunDisplayState;
	lastActivityAt?: number;
	currentTool?: string;
	currentToolStartedAt?: number;
	startedAt: number;
	endedAt?: number;
	lastUpdate?: number;
	runnerHeartbeatAt?: number;
	resumedAt?: number;
	resumeCount?: number;
	/** Current execution phase, written by status-writer on every patch. */
	phase?: RunPhase;
	/** Milliseconds since epoch when the current phase was entered. */
	phaseStartedAt?: number;
	cwd?: string;
	currentStep?: number;
	steps?: PersistedRunStep[];
	sessionDir?: string;
	outputFile?: string;
	/** Final/last output text; written by the foreground/sync status path. */
	outputText?: string;
	/** Terminal error message; written by the foreground/sync status path. */
	error?: string;
	totalTokens?: TokenUsage;
	/**
	 * Canonical run-level usage aggregate. Populated on terminal status writes.
	 * Mirrors Details.totalUsage shape and is surfaced on
	 * SUBAGENT_ASYNC_COMPLETE_EVENT for live consumers.
	 */
	totalUsage?: Usage;
	sessionFile?: string;
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
