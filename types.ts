/**
 * Type definitions for the subagent extension
 */

import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RunPhase } from "./run-phase.ts";

// ============================================================================
// Basic Types
// ============================================================================

export interface MaxOutputConfig {
	bytes?: number;
	lines?: number;
}

export interface TruncationResult {
	text: string;
	truncated: boolean;
	originalBytes?: number;
	originalLines?: number;
	artifactPath?: string;
}

export interface Usage {
	input: number;
	output: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: number;
	turns?: number;
}

export interface TokenUsage {
	input: number;
	output: number;
	total: number;
}

export type ActivityState = "needs_attention";
export type RunDisplayState = "working" | "tool_running" | "quiet" | "needs_attention" | "lost";
export type ControlEventType = "needs_attention";
export type ControlNotificationChannel = "event" | "async" | "intercom";

export interface ControlConfig {
	enabled?: boolean;
	needsAttentionAfterMs?: number;
	notifyOn?: ControlEventType[];
	notifyChannels?: ControlNotificationChannel[];
}

export interface ResolvedControlConfig {
	enabled: boolean;
	needsAttentionAfterMs: number;
	notifyOn: ControlEventType[];
	notifyChannels: ControlNotificationChannel[];
}

export interface ControlEvent {
	type: ControlEventType;
	from?: ActivityState;
	to: ActivityState;
	ts: number;
	agent: string;
	index?: number;
	runId: string;
	message: string;
}

// ============================================================================
// Progress Tracking
// ============================================================================

export interface AgentProgress {
	index?: number;
	agent: string;
	status: "pending" | "running" | "completed" | "failed" | "detached";
	activityState?: ActivityState;
	task: string;
	skills?: string[];
	lastActivityAt?: number;
	currentTool?: string;
	currentToolArgs?: string;
	currentToolRawArgs?: Record<string, unknown>;
	currentToolStartedAt?: number;
	lastToolEndAt?: number;
	recentTools: Array<{ tool: string; args: string; rawArgs?: Record<string, unknown>; endMs: number; durationMs?: number }>;
	recentOutput: string[];
	tokenSamples?: Array<{ ts: number; tokens: number }>;
	thinking?: string;
	/**
	 * Theme color token used to tint the agent name in compact rendering.
	 * Stamped from AgentConfig.color (frontmatter override) or defaultAgentColor()
	 * at progress init. Undefined = falls back to toolTitle in the renderer.
	 */
	color?: string;
	toolCount: number;
	tokens: number;
	durationMs: number;
	error?: string;
	failedTool?: string;
}

export interface ToolCallSummary {
	text: string;
	expandedText: string;
}

export interface ProgressSummary extends Partial<Pick<AgentProgress, "status" | "index" | "skills" | "currentTool" | "currentToolStartedAt" | "currentToolArgs" | "lastActivityAt" | "activityState" | "recentTools" | "recentOutput">> {
	toolCount: number;
	tokens: number;
	durationMs: number;
}

export type SubagentMetadata = Record<string, unknown>;

export interface SpawnRawInput {
	systemPrompt: string;
	prompt: string;
	tools?: string[];
	model?: string;
	thinking?: "off" | "low" | "medium" | "high";
	systemPromptMode?: "replace" | "append";
	inheritProjectContext?: boolean;
	inheritSkills?: boolean | string[];
	defaultReads?: string[];
	defaultProgress?: boolean;
	metadata?: SubagentMetadata;
	async?: boolean;
	cwd?: string;
}

export interface SpawnResult {
	content: Array<{ type: "text"; text: string }>;
	details: Details;
	isError?: boolean;
}

export interface PersonaInfo {
	name: string;
	description: string;
	source?: string;
	surface?: AgentSurface;
}

/**
 * Identity + ancestry of the AgentSession this API publication belongs to.
 *
 * Published per-session: the host session sees `{ role: "host", currentAgent:
 * "main", ... }` and each in-process child session sees its own child shape.
 * Other extensions loaded inside a child session (e.g. pi-charter) read this
 * to attribute work to the correct agent/run without polling env vars.
 */
export interface SubagentLineage {
	role: "host" | "child";
	currentAgent: string;
	parentAgent: string | null;
	parentSessionId: string | null;
	rootSessionId: string | null;
	depth: number;
	runId: string | null;
}

export interface SubagentExposedAPI {
	spawnRaw(input: SpawnRawInput): Promise<SpawnResult>;
	list(options?: { includeInternal?: boolean }): PersonaInfo[];
	/**
	 * Identity + lineage for the session this API publication belongs to.
	 * - Host session: `{ role: "host", currentAgent: "main", depth: 0, ... }`.
	 * - Child session: lineage carried from the dispatch (parent agent/session,
	 *   root session, depth, runId).
	 * Returns `null` only if the publication races ahead of session_start.
	 */
	lineage(): SubagentLineage | null;
}

export interface RegisterPersonaDirPayload {
	extensionId: string;
	path: string;
	scope: "internal";
}

export interface UnregisterPersonaDirPayload {
	extensionId: string;
}

export interface PersonaDirErrorPayload {
	extensionId: string;
	conflictingExtensionId: string;
	personaName: string;
	message: string;
}

// ============================================================================
// Results
// ============================================================================

export interface ModelAttempt {
	model: string;
	success: boolean;
	exitCode?: number | null;
	error?: string;
	usage?: Usage;
}

export interface SingleResult {
	agent: string;
	task: string;
	/** Caller-provided short label (5-10 words) describing this step. Optional. */
	label?: string;
	exitCode: number;
	detached?: boolean;
	detachedReason?: string;
	interrupted?: boolean;
	messages?: Message[];
	usage: Usage;
	model?: string;
	attemptedModels?: string[];
	modelAttempts?: ModelAttempt[];
	controlEvents?: ControlEvent[];
	error?: string;
	sessionFile?: string;
	skills?: string[];
	skillsWarning?: string;
	progress?: AgentProgress;
	progressSummary?: ProgressSummary;
	toolCalls?: ToolCallSummary[];
	artifactPaths?: ArtifactPaths;
	truncation?: TruncationResult;
	finalOutput?: string;
	savedOutputPath?: string;
	outputSaveError?: string;
	shareUrl?: string;
}

export interface Details {
	mode: "single" | "parallel" | "chain" | "management";
	context?: "fresh" | "fork";
	/** Run-level caller-provided label; populated for single runs and uniform-label parallel runs. */
	label?: string;
	results: SingleResult[];
	/**
	 * Canonical run-level usage aggregate. Sum of `results[].usage` across every
	 * step of this dispatch, INCLUDING usage bubbled up from nested sub-subagent
	 * calls (each child run aggregates its own descendants into its `usage`).
	 * Consumers like pi-bar should read this instead of re-summing `results[]`.
	 * For async dispatches the synchronous return has empty `results: []` and a
	 * zero `totalUsage`; the final aggregate lives in status.json.totalUsage and
	 * is published via SUBAGENT_ASYNC_COMPLETE_EVENT.totalUsage at completion.
	 */
	totalUsage?: Usage;
	controlEvents?: ControlEvent[];
	asyncId?: string;
	asyncDir?: string;
	progress?: AgentProgress[];
	progressSummary?: ProgressSummary;
	artifacts?: {
		dir: string;
		files: ArtifactPaths[];
	};
	truncation?: {
		truncated: boolean;
		originalBytes?: number;
		originalLines?: number;
		artifactPath?: string;
	};
	// Chain metadata for observability
	chainAgents?: string[];      // Agent names in order, e.g., ["scout", "planner"]
	totalSteps?: number;         // Total steps in chain
	currentStepIndex?: number;   // 0-indexed current step (for running chains)
	/** Internal foreground run id used to resolve nested on-disk child runs for inline live rendering. */
	runId?: string;
}

// ============================================================================
// Artifacts
// ============================================================================

export interface ArtifactPaths {
	inputPath: string;
	outputPath: string;
	jsonlPath: string;
	metadataPath: string;
}

export interface ArtifactConfig {
	enabled: boolean;
	includeInput: boolean;
	includeOutput: boolean;
	includeJsonl: boolean;
	includeMetadata: boolean;
	cleanupDays: number;
}

// ============================================================================
// Async Execution
// ============================================================================

/**
 * Slim live-progress snapshot stamped onto a running async step by the runner so
 * the widget poller (async-job-tracker) can render the same color/sparkline/history
 * UI that inline (renderSingleCompact/renderMultiCompact) gets from AgentProgress.
 *
 * Persisted into status.json. Capped buffers keep the JSON small and writes cheap:
 * we coalesce writes at ~2Hz and prune tokenSamples to a 240s+margin window.
 */
export interface LiveStepProgress {
	color?: string;
	thinking?: string;
	/** Current execution phase for this step, persisted additively by status-writer. */
	phase?: RunPhase;
	/** Milliseconds since epoch when this step's current phase was entered. */
	phaseStartedAt?: number;
	currentToolArgs?: string;
	recentTools?: Array<{ tool: string; args?: string; rawArgs?: Record<string, unknown>; endMs: number; durationMs?: number }>;
	tokenSamples?: Array<{ ts: number; tokens: number }>;
	lastToolEndAt?: number;
	toolCount?: number;
	tokens?: number;
}

export interface AsyncStatus {
	runId: string;
	// charter nested-subagent-display: persisted parent link for hierarchy rendering.
	parentRunId?: string;
	// 'parallel' is used when the runner is invoked with a single parallel-only step;
	// distinguishes top-level parallel from a real multi-step chain for display.
	mode: "single" | "chain" | "parallel";
	/** Run-level caller-provided summary; populated for single runs and uniform-label parallel runs. */
	label?: string;
	state: "queued" | "running" | "complete" | "failed" | "paused" | "lost";
	activityState?: ActivityState;
	displayState?: RunDisplayState;
	lastActivityAt?: number;
	currentTool?: string;
	currentToolStartedAt?: number;
	startedAt: number;
	endedAt?: number;
	lastUpdate?: number;
	runnerHeartbeatAt?: number;
	/** Current execution phase, written by status-writer on every patch. */
	phase?: RunPhase;
	/** Milliseconds since epoch when the current phase was entered. */
	phaseStartedAt?: number;
	cwd?: string;
	currentStep?: number;
	steps?: Array<{
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
	}>;
	sessionDir?: string;
	outputFile?: string;
	totalTokens?: TokenUsage;
	/**
	 * Canonical run-level usage aggregate for async runs. Populated on terminal
	 * status writes (complete/failed/lost). Mirrors Details.totalUsage shape and
	 * is also surfaced on SUBAGENT_ASYNC_COMPLETE_EVENT for live consumers.
	 */
	totalUsage?: Usage;
	sessionFile?: string;
}

export interface AsyncJobState {
	asyncId: string;
	asyncDir: string;
	// charter nested-subagent-display: widget reads this from status.json for nesting.
	parentRunId?: string;
	status: "queued" | "running" | "complete" | "failed" | "paused" | "lost";
	activityState?: ActivityState;
	displayState?: RunDisplayState;
	lastActivityAt?: number;
	currentTool?: string;
	currentToolStartedAt?: number;
	mode?: "single" | "chain" | "parallel";
	agents?: string[];
	/** Run-level caller-provided summary; populated for single runs and uniform-label parallel runs. */
	label?: string;
	/** Per-step caller-provided labels aligned by index with `agents[]`. */
	agentLabels?: string[];
	/** Per-step lifecycle statuses aligned by index with `agents[]`. */
	stepStatuses?: string[];
	currentStep?: number;
	stepsTotal?: number;
	startedAt?: number;
	updatedAt?: number;
	runnerHeartbeatAt?: number;
	/** Current execution phase, mirrored from status.json per-patch. */
	phase?: RunPhase;
	/** Milliseconds since epoch when the current phase was entered. */
	phaseStartedAt?: number;
	sessionDir?: string;
	outputFile?: string;
	totalTokens?: TokenUsage;
	sessionFile?: string;
	/**
	 * Live progress mirrored from status.json's running step (LiveStepProgress).
	 * Drives the widget's per-job color/sparkline/current/history rendering --
	 * inline parity. Cleared on terminal lifecycle states except color/tokenSamples,
	 * which persist so the sparkline freezes at last sample and the name stays tinted
	 * after completion (mirroring the inline compactForegroundResult slim contract).
	 */
	currentAgent?: string;
	agentColor?: string;
	// Per-step colors aligned by index with `agents[]`. Used for parallel runs where
	// each sibling has its own theme color. Populated from status.steps[i].live.color.
	agentColors?: string[];
	thinking?: string;
	currentToolArgs?: string;
	recentTools?: Array<{ tool: string; args?: string; rawArgs?: Record<string, unknown>; endMs: number; durationMs?: number }>;
	tokenSamples?: Array<{ ts: number; tokens: number }>;
	lastToolEndAt?: number;
}

export interface SubagentState {
	baseCwd: string;
	currentSessionId: string | null;
	asyncJobs: Map<string, AsyncJobState>;
	foregroundControls: Map<string, {
		runId: string;
		asyncDir?: string;
		// charter nested-subagent-display: sync rows carry hierarchy before disk handoff.
		parentRunId?: string;
		mode: "single" | "parallel" | "chain";
		startedAt: number;
		updatedAt: number;
		/** Run-level caller-provided label; populated for single runs and uniform-label parallel runs. */
		label?: string;
		/** Per-step caller-provided labels aligned by index. */
		agentLabels?: string[];
		currentAgent?: string;
		/**
		 * Theme color token used to tint the sync agent name in /subagents-status
		 * left pane. Populated from AgentProgress.color (resolveAgentColor()).
		 */
		currentAgentColor?: string;
		currentIndex?: number;
		currentActivityState?: ActivityState;
		lastActivityAt?: number;
		currentTool?: string;
		currentToolStartedAt?: number;
		lastToolEndAt?: number;
		recentTools?: Array<{ tool: string; args?: string; endMs?: number; durationMs?: number }>;
		recentOutput?: string[];
		finalOutput?: string;
		interrupt?: () => boolean;
	}>;
	lastForegroundControlId: string | null;
	cleanupTimers: Map<string, ReturnType<typeof setTimeout>>;
	lastUiContext: ExtensionContext | null;
	poller: NodeJS.Timeout | null;
}

// ============================================================================
// Display
// ============================================================================

export type DisplayItem = 
	| { type: "text"; text: string } 
	| { type: "tool"; name: string; args: Record<string, unknown> };

// ============================================================================
// Error Handling
// ============================================================================

export interface ErrorInfo {
	hasError: boolean;
	exitCode?: number;
	errorType?: string;
	details?: string;
}

export interface IntercomEventBus {
	on(channel: string, handler: (data: unknown) => void): () => void;
	emit(channel: string, data: unknown): void;
}

export const INTERCOM_DETACH_REQUEST_EVENT = "pi-intercom:detach-request";
export const INTERCOM_DETACH_RESPONSE_EVENT = "pi-intercom:detach-response";
export const SUBAGENT_EXPOSE_API_EVENT = "subagent:expose-api";
/**
 * Push-style lineage notification carrying a `SubagentLineage` payload.
 *
 * Fires when the host or child session resolves its identity on
 * `session_start`. Consumers that only need lineage (and not the spawnRaw
 * surface) can subscribe to this channel and skip the full expose-api event.
 */
export const SUBAGENT_LINEAGE_EVENT = "subagent:lineage";
/**
 * Fires when THIS session goes fully idle: the main agent is not mid-turn
 * AND no async subagents are in flight. Sync subagent calls are subsumed
 * by the turn cycle (they run between turn_start and turn_end). Emits on
 * the busy → idle transition only after at least one busy period since
 * the last idle. Payload: `{ ts: number }`.
 *
 * Each session (host + each child) tracks idleness independently. Use this
 * to know "this agent + all its background subagents are done".
 */
export const SUBAGENT_ALL_IDLE_EVENT = "subagent:all-idle";
export const SUBAGENT_REGISTER_PERSONA_DIR_EVENT = "subagent:register-persona-dir";
export const SUBAGENT_UNREGISTER_PERSONA_DIR_EVENT = "subagent:unregister-persona-dir";
export const SUBAGENT_REGISTER_PERSONA_DIR_ERROR_EVENT = "subagent:register-persona-dir-error";
export const SUBAGENT_ASYNC_STARTED_EVENT = "subagent:async-started";
export const SUBAGENT_ASYNC_COMPLETE_EVENT = "subagent:async-complete";
export const SUBAGENT_SPAWN_STARTED_EVENT = "subagent:spawn_started";
export const SUBAGENT_COMPLETED_EVENT = "subagent:completed";
export const SUBAGENT_FAILED_EVENT = "subagent:failed";
export const SUBAGENT_PHASE_CHANGE_EVENT = "subagent:phase-change";
export const SUBAGENT_CONTROL_EVENT = "subagent:control-event";
export const SUBAGENT_CONTROL_INTERCOM_EVENT = "subagent:control-intercom";

export interface SubagentPhaseChangePayload {
	runId: string;
	stepIndex: number;
	phase: RunPhase;
	previousPhase?: RunPhase;
	toolName?: string;
	ts: number;
}

// ============================================================================
// Execution Options
// ============================================================================

export interface ForkReuseConfig {
	agentName: string;
	sessionId: string;
}

export type IntercomBridgeMode = "off" | "fork-only" | "always";

export interface IntercomBridgeConfig {
	mode?: IntercomBridgeMode;
	instructionFile?: string;
}

export interface TopLevelParallelConfig {
	maxTasks?: number;
	concurrency?: number;
	maxConcurrency?: number;
}

export type AgentSurface = "main" | "subagent" | "both" | "internal";

export interface AgentPresetOverlay {
	model?: string | false;
	fallbackModels?: string[] | false;
	thinking?: string | false;
	tools?: string[] | false;
	mcpDirectTools?: string[] | false;
	extensions?: string[] | false;
	skills?: string[] | false;
	output?: string | false;
	defaultReads?: string[] | false;
	defaultProgress?: boolean;
	interactive?: boolean;
	maxSubagentDepth?: number | false;
	systemPromptMode?: "append" | "replace";
	inheritProjectContext?: boolean;
	inheritSkills?: boolean;
	systemPrompt?: string | false;
	disabled?: boolean;
	surface?: AgentSurface;
	/** Alias for surface in preset/subagent.json role-topology config. */
	scope?: AgentSurface;
	canDelegate?: boolean;
	allowedDelegateAgents?: string[] | false;
}

export interface PresetConfig {
	description?: string;
	defaultRole?: string;
	strictAgents?: boolean;
	agents?: Record<string, AgentPresetOverlay>;
	agentOverrides?: Record<string, AgentPresetOverlay>;
}

export type PresetSource = "param" | "PI_PRESET" | "OH_MY_OPENCODE_SLIM_PRESET" | "config.defaultPreset";

export interface DiscoveryPresetInfo {
	requested?: string;
	applied?: string;
	source?: PresetSource;
	defaultRole?: string;
	warnings: string[];
}

export interface StripXmlTagsConfig {
	/** Enable stripping of XML metadata tags from subagent output. Default: true */
	enabled?: boolean;
	/** Tag names (without angle brackets) to strip. Default: ["dcp-id", "dcp-owner", "dcp-system-reminder"] */
	tags?: string[];
}

export interface ExtensionConfig {
	asyncByDefault?: boolean;
	forceTopLevelAsync?: boolean;
	defaultSessionDir?: string;
	maxSubagentDepth?: number;
	control?: ControlConfig;
	parallel?: TopLevelParallelConfig;
	worktreeSetupHook?: string;
	worktreeSetupHookTimeoutMs?: number;
	intercomBridge?: IntercomBridgeConfig;
	defaultPreset?: string;
	presets?: Record<string, PresetConfig>;
	/** Configure stripping of XML metadata tags from subagent output display. */
	stripXmlTags?: StripXmlTagsConfig | boolean;
}

// ============================================================================
// Constants
// ============================================================================

export const DEFAULT_MAX_OUTPUT: Required<MaxOutputConfig> = {
	bytes: 200 * 1024,
	lines: 5000,
};

export const DEFAULT_ARTIFACT_CONFIG: ArtifactConfig = {
	enabled: true,
	includeInput: true,
	includeOutput: true,
	includeJsonl: false,
	includeMetadata: true,
	cleanupDays: 7,
};

function sanitizeTempScopeSegment(value: string): string {
	const sanitized = value
		.trim()
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return sanitized || "unknown";
}

export function resolveTempScopeId(options?: {
	env?: NodeJS.ProcessEnv;
	getuid?: (() => number) | undefined;
	userInfo?: (() => { username?: string | null }) | undefined;
	homedir?: (() => string) | undefined;
}): string {
	const env = options?.env ?? process.env;
	const getuid = options && Object.hasOwn(options, "getuid")
		? options.getuid
		: process.getuid?.bind(process);
	if (typeof getuid === "function") {
		return `uid-${getuid()}`;
	}

	for (const key of ["USERNAME", "USER", "LOGNAME"] as const) {
		const value = env[key];
		if (value) return `user-${sanitizeTempScopeSegment(value)}`;
	}

	const userInfo = options && Object.hasOwn(options, "userInfo")
		? options.userInfo
		: os.userInfo;
	try {
		const username = userInfo?.().username;
		if (username) return `user-${sanitizeTempScopeSegment(username)}`;
	} catch {
		// Fall through to home-directory-based scoping.
	}

	const homedir = env.USERPROFILE ?? env.HOME;
	if (homedir) return `home-${sanitizeTempScopeSegment(homedir)}`;

	const resolveHomedir = options && Object.hasOwn(options, "homedir")
		? options.homedir
		: os.homedir;
	try {
		const fallbackHomedir = resolveHomedir?.();
		if (fallbackHomedir) return `home-${sanitizeTempScopeSegment(fallbackHomedir)}`;
	} catch {
		// Fall through to the last-resort shared scope.
	}

	return "shared";
}

export const MAX_PARALLEL = 8;
export const MAX_CONCURRENCY = 4;
export const BASE_TEMP_DIR = path.join(os.tmpdir(), `pi-subagents-${resolveTempScopeId()}`);
export const RUNS_DIR = path.join(BASE_TEMP_DIR, "async-subagent-runs");
export const CHAIN_RUNS_DIR = path.join(BASE_TEMP_DIR, "chain-runs");
export const TEMP_ARTIFACTS_DIR = path.join(BASE_TEMP_DIR, "artifacts");
export const WIDGET_KEY = "subagent-async";
export const SLASH_RESULT_TYPE = "subagent-slash-result";
export const SLASH_SUBAGENT_REQUEST_EVENT = "subagent:slash:request";
export const SLASH_SUBAGENT_STARTED_EVENT = "subagent:slash:started";
export const SLASH_SUBAGENT_RESPONSE_EVENT = "subagent:slash:response";
export const SLASH_SUBAGENT_UPDATE_EVENT = "subagent:slash:update";
export const SLASH_SUBAGENT_CANCEL_EVENT = "subagent:slash:cancel";
export const POLL_INTERVAL_MS = 250;
export const MAX_WIDGET_JOBS = 4;
export const DEFAULT_SUBAGENT_MAX_DEPTH = 2;

export const DEFAULT_FORK_PREAMBLE =
	"You are a delegated subagent running from a fork of the parent session. " +
	"Treat the inherited conversation as reference-only context, not a live thread to continue. " +
	"Do not continue or answer prior messages as if they are waiting for a reply. " +
	"Your sole job is to execute the task below and return a focused result for that task using your tools.";

function normalizeTopLevelParallelValue(value: unknown): number | undefined {
	const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
	if (!Number.isInteger(parsed) || parsed < 1) return undefined;
	return parsed;
}

export function resolveTopLevelParallelMaxTasks(value: unknown): number {
	return normalizeTopLevelParallelValue(value) ?? MAX_PARALLEL;
}

export function resolveTopLevelParallelConcurrency(
	override: unknown,
	configValue: unknown,
	maxValue?: unknown,
): number {
	const requested = normalizeTopLevelParallelValue(override)
		?? normalizeTopLevelParallelValue(configValue)
		?? MAX_CONCURRENCY;
	const max = normalizeTopLevelParallelValue(maxValue);
	return max === undefined ? requested : Math.min(requested, max);
}

export function wrapForkTask(task: string, preamble?: string | false): string {
	if (preamble === false) return task;
	const effectivePreamble = preamble ?? DEFAULT_FORK_PREAMBLE;
	const wrappedPrefix = `${effectivePreamble}\n\nTask:\n`;
	if (task.startsWith(wrappedPrefix)) return task;
	return `${wrappedPrefix}${task}`;
}

// ============================================================================
// Recursion Depth Guard
// ============================================================================

export function normalizeMaxSubagentDepth(value: unknown): number | undefined {
	const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
	if (!Number.isInteger(parsed) || parsed < 0) return undefined;
	return parsed;
}

export function resolveCurrentMaxSubagentDepth(configMaxDepth?: number): number {
	return normalizeMaxSubagentDepth(process.env.PI_SUBAGENT_MAX_DEPTH)
		?? normalizeMaxSubagentDepth(configMaxDepth)
		?? DEFAULT_SUBAGENT_MAX_DEPTH;
}

export function resolveChildMaxSubagentDepth(parentMaxDepth: number, agentMaxDepth?: number): number {
	const normalizedParent = normalizeMaxSubagentDepth(parentMaxDepth) ?? DEFAULT_SUBAGENT_MAX_DEPTH;
	const normalizedAgent = normalizeMaxSubagentDepth(agentMaxDepth);
	return normalizedAgent === undefined ? normalizedParent : Math.min(normalizedParent, normalizedAgent);
}

export function checkSubagentDepth(configMaxDepth?: number): { blocked: boolean; depth: number; maxDepth: number } {
	const depth = Number(process.env.PI_SUBAGENT_DEPTH ?? "0");
	const maxDepth = resolveCurrentMaxSubagentDepth(configMaxDepth);
	const blocked = Number.isFinite(depth) && depth >= maxDepth;
	return { blocked, depth, maxDepth };
}

/**
 * Async dispatch is only allowed from the host session. Child (in-process) sessions
 * have no UI to surface async runs, no notify wake target separate from the host, and
 * no lifecycle owner to await descendants. The guard returns true when the current
 * activate-time globalThis flag indicates we are inside a child session.
 */
export const CHILD_SESSION_FLAG_KEY = "__piSubagentInsideChildSession";

export function isInsideChildSession(): boolean {
	return (globalThis as Record<string, unknown>)[CHILD_SESSION_FLAG_KEY] === true;
}

export function getSubagentDepthEnv(maxDepth?: number): Record<string, string> {
	const parentDepth = Number(process.env.PI_SUBAGENT_DEPTH ?? "0");
	const nextDepth = Number.isFinite(parentDepth) ? parentDepth + 1 : 1;
	return {
		PI_SUBAGENT_DEPTH: String(nextDepth),
		PI_SUBAGENT_MAX_DEPTH: String(normalizeMaxSubagentDepth(maxDepth) ?? resolveCurrentMaxSubagentDepth()),
	};
}

function normalizeAgentIdentity(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim().toLowerCase();
	return trimmed || undefined;
}

function normalizeAgentList(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const normalized = value
		.map((item) => normalizeAgentIdentity(item))
		.filter((item): item is string => Boolean(item));
	return normalized.length > 0 ? normalized : undefined;
}

function parseEnvBoolean(value: string | undefined): boolean | undefined {
	if (!value) return undefined;
	const normalized = value.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(normalized)) return true;
	if (["0", "false", "no", "off"].includes(normalized)) return false;
	return undefined;
}

function parseEnvAgentList(value: string | undefined): string[] | undefined {
	if (!value) return undefined;
	const normalized = value
		.split(",")
		.map((item) => normalizeAgentIdentity(item))
		.filter((item): item is string => Boolean(item));
	return normalized.length > 0 ? normalized : undefined;
}

const LEGACY_NESTED_DELEGATOR_AGENT_NAMES = new Set(["orchestrator", "delegate"]);
const LEGACY_ALLOWED_NESTED_CHILD_AGENT_NAMES = new Set(["explorer", "librarian", "oracle", "designer", "fixer"]);

export function isNestedOrchestratorAgent(name: unknown): boolean {
	const normalized = normalizeAgentIdentity(name);
	return normalized !== undefined && LEGACY_NESTED_DELEGATOR_AGENT_NAMES.has(normalized);
}

export function isAllowedNestedOrchestratorChild(name: unknown): boolean {
	const normalized = normalizeAgentIdentity(name);
	return normalized !== undefined && LEGACY_ALLOWED_NESTED_CHILD_AGENT_NAMES.has(normalized);
}

export function getSubagentIdentityEnv(
	currentAgentName: string,
	parentAgentName?: string | null,
	options?: { canDelegate?: boolean; allowedDelegateAgents?: string[]; parentRunId?: string; parentSessionId?: string; rootSessionId?: string },
): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = {
		PI_SUBAGENT_CURRENT_AGENT: currentAgentName,
	};
	const normalizedParent = typeof parentAgentName === "string" ? parentAgentName.trim() : "";
	if (normalizedParent) env.PI_SUBAGENT_PARENT_AGENT = normalizedParent;
	if (options?.parentSessionId) env.PI_SUBAGENT_PARENT_SESSION_ID = options.parentSessionId;
	if (options?.rootSessionId) env.PI_SUBAGENT_ROOT_SESSION_ID = options.rootSessionId;
	// charter nested-subagent-display: expose parent run id to child Pi processes.
	if (options?.parentRunId) env.PI_SUBAGENT_PARENT_RUN_ID = options.parentRunId;
	if (options?.canDelegate !== undefined) env.PI_SUBAGENT_CAN_DELEGATE = options.canDelegate ? "1" : "0";
	const allowedDelegateAgents = normalizeAgentList(options?.allowedDelegateAgents);
	if (allowedDelegateAgents) env.PI_SUBAGENT_ALLOWED_DELEGATE_AGENTS = allowedDelegateAgents.join(",");
	return env;
}

export function checkNestedDelegationGuard(requestedAgents: string[]): {
	blocked: boolean;
	currentAgent?: string;
	parentAgent?: string;
	reason?: string;
} {
	const currentAgent = normalizeAgentIdentity(process.env.PI_SUBAGENT_CURRENT_AGENT);
	const parentAgent = normalizeAgentIdentity(process.env.PI_SUBAGENT_PARENT_AGENT);
	if (!currentAgent) return { blocked: false };

	const explicitCanDelegate = parseEnvBoolean(process.env.PI_SUBAGENT_CAN_DELEGATE);
	const canDelegate = explicitCanDelegate ?? isNestedOrchestratorAgent(currentAgent);
	if (!canDelegate) {
		return {
			blocked: true,
			currentAgent,
			parentAgent,
			reason:
				`Nested subagent call blocked: '${process.env.PI_SUBAGENT_CURRENT_AGENT}' is not allowed to delegate. ` +
				"Only agents marked canDelegate may make nested subagent calls.",
		};
	}

	const targets = [...new Set(requestedAgents.map((agent) => normalizeAgentIdentity(agent)).filter((agent): agent is string => Boolean(agent)))];
	const explicitAllowedTargets = parseEnvAgentList(process.env.PI_SUBAGENT_ALLOWED_DELEGATE_AGENTS);
	const allowedTargets = explicitAllowedTargets
		?? (isNestedOrchestratorAgent(currentAgent) ? [...LEGACY_ALLOWED_NESTED_CHILD_AGENT_NAMES] : undefined);
	if (allowedTargets && allowedTargets.length > 0) {
		const allowedTargetSet = new Set(allowedTargets);
		const disallowedTargets = targets.filter((agent) => !allowedTargetSet.has(agent));
		if (disallowedTargets.length > 0) {
			return {
				blocked: true,
				currentAgent,
				parentAgent,
				reason:
					`Nested subagent call blocked: agent '${process.env.PI_SUBAGENT_CURRENT_AGENT}' may only delegate to ` +
					`${allowedTargets.join(", ")}. Requested: ${disallowedTargets.join(", ")}.`,
			};
		}
	}

	return { blocked: false, currentAgent, parentAgent };
}

// ============================================================================
// Utility Functions
// ============================================================================

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function truncateOutput(
	output: string,
	config: Required<MaxOutputConfig>,
	artifactPath?: string,
): TruncationResult {
	const lines = output.split("\n");
	const bytes = Buffer.byteLength(output, "utf-8");

	if (bytes <= config.bytes && lines.length <= config.lines) {
		return { text: output, truncated: false };
	}

	let truncatedLines = lines;
	if (lines.length > config.lines) {
		truncatedLines = lines.slice(0, config.lines);
	}

	let result = truncatedLines.join("\n");
	if (Buffer.byteLength(result, "utf-8") > config.bytes) {
		let low = 0;
		let high = result.length;
		while (low < high) {
			const mid = Math.floor((low + high + 1) / 2);
			if (Buffer.byteLength(result.slice(0, mid), "utf-8") <= config.bytes) {
				low = mid;
			} else {
				high = mid - 1;
			}
		}
		result = result.slice(0, low);
	}

	const keptLines = result.split("\n").length;
	const marker = `[TRUNCATED: showing first ${keptLines} of ${lines.length} lines, ${formatBytes(Buffer.byteLength(result))} of ${formatBytes(bytes)}${artifactPath ? ` - full output at ${artifactPath}` : ""}]\n`;

	return {
		text: marker + result,
		truncated: true,
		originalBytes: bytes,
		originalLines: lines.length,
		artifactPath,
	};
}
