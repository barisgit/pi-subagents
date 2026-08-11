import type { SubmitResultEnvelope } from "./output-contract.ts";
import type { ActivityState, ModelAttempt, RunDisplayState, TokenUsage, Usage } from "./types.ts";

/** Observable execution phase for a child agent run. */
export type RunPhase =
	| "idle"
	| "waiting_model"
	| "waiting_network"
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
	model?: string;
	attemptedModels?: string[];
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
interface LiveStepProgress {
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
	recentTools?: Array<{
		tool: string;
		args?: string;
		rawArgs?: Record<string, unknown>;
		endMs: number;
		durationMs?: number;
	}>;
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
 * state/async-status.ts statusToRunView) reads it. Unifies the former
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
	/**
	 * Milliseconds since epoch when the child ACTUALLY began executing (the
	 * queued->running transition), as distinct from startedAt (dispatch/queue
	 * time). Optional and additive: records written before this field existed
	 * omit it, and consumers fall back to startedAt.
	 */
	executionStartedAt?: number;
	endedAt?: number;
	lastUpdate?: number;
	runnerHeartbeatAt?: number;
	/**
	 * Identity of the in-process runner that owns this record: the host process
	 * pid and a per-process random token (survives extension reload, not process
	 * restart). Liveness checks use these to detect a dead runner IMMEDIATELY
	 * instead of waiting out the heartbeat ceiling. Optional and additive: old
	 * records omit them and consumers fall back to heartbeat-age behavior.
	 */
	runnerPid?: number;
	runnerToken?: string;
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

export type PersistedRunStatusParseResult =
	| { ok: true; value: PersistedRunStatus }
	| { ok: false; reason: "invalid-json" | "invalid-shape" };

/**
 * Validate a raw status.json string at the disk boundary. The single reader
 * (shared/utils.ts readStatus) routes through this instead of casting
 * JSON.parse output, so malformed or partial files are rejected in one place
 * rather than trusted downstream.
 */
export function parsePersistedRunStatus(raw: string): PersistedRunStatusParseResult {
	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch {
		return { ok: false, reason: "invalid-json" };
	}
	if (data === null || typeof data !== "object") return { ok: false, reason: "invalid-shape" };
	const o = data as Record<string, unknown>;
	if (typeof o.runId !== "string") return { ok: false, reason: "invalid-shape" };
	if (o.mode !== "single" && o.mode !== "parallel" && o.mode !== "chain")
		return { ok: false, reason: "invalid-shape" };
	const validStates = ["queued", "running", "complete", "failed", "paused", "lost", "interrupted", "skipped"];
	if (typeof o.state !== "string" || !validStates.includes(o.state)) return { ok: false, reason: "invalid-shape" };
	if (typeof o.startedAt !== "number" || !Number.isFinite(o.startedAt)) return { ok: false, reason: "invalid-shape" };
	// executionStartedAt is optional and additive: absent is valid (old records),
	// but a present non-number is a malformed file and fails closed.
	if (o.executionStartedAt !== undefined && !isFiniteNumber(o.executionStartedAt))
		return { ok: false, reason: "invalid-shape" };
	// runnerPid/runnerToken are optional and additive (old records omit them);
	// a present wrong-typed value is a malformed file and fails closed.
	if (o.runnerPid !== undefined && !isFiniteNumber(o.runnerPid)) return { ok: false, reason: "invalid-shape" };
	if (o.runnerToken !== undefined && typeof o.runnerToken !== "string") return { ok: false, reason: "invalid-shape" };
	if (
		o.steps !== undefined &&
		(!Array.isArray(o.steps) ||
			o.steps.some((step) => step === null || typeof step !== "object" || typeof step.status !== "string"))
	)
		return { ok: false, reason: "invalid-shape" };
	if (o.mode === "chain") o.mode = "parallel";
	// Liveness/progress timestamps drive stale + hard-dead arithmetic in
	// run-liveness.ts; a malformed value would make every comparison NaN-false
	// and freeze a dead run as "quiet" forever. Fail closed by STRIPPING the
	// malformed optional field instead of rejecting the record: rejection hides
	// the run entirely (readStatus -> null), while absence keeps it visible and
	// lets the existing fallbacks and staleness reaping recover it. Non-finite
	// values (JSON 1e400 parses to Infinity) are equally poisonous and stripped.
	for (const field of OPTIONAL_LIVENESS_NUMBER_FIELDS) {
		if (o[field] !== undefined && !isFiniteNumber(o[field])) delete o[field];
	}
	return { ok: true, value: data as PersistedRunStatus };
}

const OPTIONAL_LIVENESS_NUMBER_FIELDS = [
	"lastActivityAt",
	"currentToolStartedAt",
	"endedAt",
	"lastUpdate",
	"runnerHeartbeatAt",
	"resumedAt",
	"resumeCount",
	"phaseStartedAt",
] as const;

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
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
	/** Optional run aggregate for resume patches whose step tokens include prior attempts. */
	totalTokens?: TokenUsage;
}
