/**
 * Type definitions for the subagent extension
 */

import type { Message } from "@earendil-works/pi-ai";
import type { SubmitResultEnvelope } from "./output-contract.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RunPhase } from "./status-types.ts";
export type { SubagentToolInput, Step, Task } from "./schemas.ts";

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
	/** Prompt-cache tokens read/reused by the provider. Included in total. */
	cacheRead?: number;
	/** Prompt-cache tokens written by the provider. Included in total. */
	cacheWrite?: number;
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
	/** Stable activity baseline identifying this stall episode across extension reloads. */
	activityAt?: number;
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
	/** Current execution phase for live inline/status rendering. */
	phase?: RunPhase;
	/** Milliseconds since epoch when the current phase was entered. */
	phaseStartedAt?: number;
	lastToolEndAt?: number;
	recentTools: Array<{
		tool: string;
		args: string;
		rawArgs?: Record<string, unknown>;
		endMs: number;
		durationMs?: number;
	}>;
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

export interface ProgressSummary extends Partial<
	Pick<
		AgentProgress,
		| "status"
		| "index"
		| "skills"
		| "currentTool"
		| "currentToolStartedAt"
		| "currentToolArgs"
		| "phase"
		| "phaseStartedAt"
		| "lastActivityAt"
		| "activityState"
		| "recentTools"
		| "recentOutput"
	>
> {
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
 * <active root role>, ... }` and each in-process child session sees its own child shape.
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
	rootRunId?: string | null;
	canDelegate?: boolean;
	allowedDelegateAgents?: string[];
	maxSubagentDepth?: number;
}

export interface SubagentUsageRecord {
	runId: string;
	rootRunId?: string;
	parentRunId?: string;
	rootSessionId?: string;
	mode: "single" | "parallel" | "workflow";
	source: "sync" | "async";
	totalUsage: Usage;
	timestamp: number;
}

export interface SubagentUsageSnapshot {
	records: SubagentUsageRecord[];
	totalUsage: Usage;
	updatedAt?: number;
}

export interface SubagentExposedAPI {
	spawnRaw(input: SpawnRawInput): Promise<SpawnResult>;
	list(options?: { includeInternal?: boolean }): PersonaInfo[];
	/** Current-session subagent usage, sourced from stable subagent_usage records. */
	usageSnapshot(): SubagentUsageSnapshot;
	/**
	 * Identity + lineage for the session this API publication belongs to.
	 * - Host session: `{ role: "host", currentAgent: <active root role>, depth: 0, ... }`.
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

export interface PipelineMetadata {
	id: string;
	itemIndex: number;
	stageIndex: number;
	itemLabel?: string;
}

export interface SingleResult {
	agent: string;
	task: string;
	pipeline?: PipelineMetadata;
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
	toolCallCount?: number;
	toolResultCount?: number;
	toolErrorCount?: number;
	toolCalls?: ToolCallSummary[];
	artifactPaths?: ArtifactPaths;
	truncation?: TruncationResult;
	finalOutput?: string;
	structuredResult?: SubmitResultEnvelope;
	savedOutputPath?: string;
	outputSaveError?: string;
	shareUrl?: string;
}

export interface Details {
	mode: "single" | "parallel" | "management";
	context?: "fresh" | "fork";
	/** Run-level caller-provided label; populated for single runs and uniform-label parallel runs. */
	label?: string;
	/** Workflow Details keep mode:"parallel" for canonical rendering shape but relabel as workflow in UI. */
	workflow?: boolean;
	/** Workflow step labels retained for workflow rendering. */
	agentGroups?: string[];
	totalSteps?: number;
	currentStepIndex?: number;
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
	children?: Array<{ runId: string; agent: string; label?: string; stepIndex: number }>;
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
	/**
	 * Running-frame denominator override for parallel/workflow headers. A workflow
	 * parallel() group registers its members one at a time (each suspends at its
	 * own dispatch), so results[] under-counts a fan-out until every sibling has
	 * started — producing a transient "agent 1/1" for a 2-agent group. The emitter
	 * sets this to (registered + not-yet-registered group members) while any agent
	 * is running so the header reads "1/2" from the first frame; it is omitted once
	 * nothing is running, so the final frame falls back to results.length.
	 */
	expectedAgents?: number;
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

export interface AsyncJobState {
	asyncId: string;
	asyncDir: string;
	// charter nested-subagent-display: widget reads this from status.json for nesting.
	parentRunId?: string;
	status: "queued" | "running" | "complete" | "failed" | "paused" | "lost" | "interrupted" | "skipped";
	// Terminal but its completion notification has not reached the host turn
	// yet (rollup still open, or delivery raced/never fired). Widget keeps the
	// row and renders an accent glyph until the delivered event arrives.
	pendingDelivery?: boolean;
	// Workflow groups render as ONE widget row; their children are tracked for
	// aggregation (progress, liveness) but hidden from the widget list.
	kind?: "workflow";
	// Durable child tally for workflow groups: counted from the runs registry
	// (children by parentRunId, resolved via status.json) so the widget shows
	// "X done · Y running · Z queued" instead of a "done/total" fraction that
	// collapses as completed children are cleaned out of the live job map. N is
	// unknowable up front (workflows fan out at runtime), so there is no total.
	childCounts?: { done: number; running: number; queued: number };
	activityState?: ActivityState;
	displayState?: RunDisplayState;
	lastActivityAt?: number;
	currentTool?: string;
	currentToolStartedAt?: number;
	mode?: "single" | "parallel";
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
	/** Wall time the run actually began executing (queued->running flip); falls back to startedAt when absent. */
	executionStartedAt?: number;
	updatedAt?: number;
	runnerHeartbeatAt?: number;
	resumedAt?: number;
	resumeCount?: number;
	/** Control notification settings captured at async dispatch start. */
	controlConfig?: ResolvedControlConfig;
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
	recentTools?: Array<{
		tool: string;
		args?: string;
		rawArgs?: Record<string, unknown>;
		endMs: number;
		durationMs?: number;
	}>;
	tokenSamples?: Array<{ ts: number; tokens: number }>;
	lastToolEndAt?: number;
}

export interface SubagentState {
	baseCwd: string;
	currentSessionId: string | null;
	asyncJobs: Map<string, AsyncJobState>;
	foregroundControls: Map<
		string,
		{
			runId: string;
			asyncDir?: string;
			// charter nested-subagent-display: sync rows carry hierarchy before disk handoff.
			parentRunId?: string;
			mode: "single" | "parallel";
			startedAt: number;
			/** Wall time the run actually began executing (queued->running flip); set once alongside started. */
			executionStartedAt?: number;
			updatedAt: number;
			/**
			 * False until the run produces its first progress (i.e. a child acquired a
			 * leaf permit and began executing). A foreground run is opened before it
			 * acquires a permit, so the live dashboard view must render it "queued"
			 * until then — not "running" — or a permit-blocked run looks active.
			 */
			started?: boolean;
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
			/** Current execution phase for live status rendering. */
			phase?: RunPhase;
			/** Milliseconds since epoch when the current phase was entered. */
			phaseStartedAt?: number;
			lastToolEndAt?: number;
			recentTools?: Array<{ tool: string; args?: string; endMs?: number; durationMs?: number }>;
			recentOutput?: string[];
			finalOutput?: string;
			interrupt?: (reason?: string) => boolean;
		}
	>;
	lastForegroundControlId: string | null;
	usageByRun?: Map<string, SubagentUsageRecord>;
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
export const SUBAGENT_REQUEST_API_EVENT = "subagent:request-api";
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
export const SUBAGENT_ASYNC_RUN_COMPLETE_EVENT = "subagent:async-run-complete";
/** Carries a terminal SubagentUsageRecord for consumers that need token totals. */
export const SUBAGENT_USAGE_EVENT = "subagent:usage";
// Emitted by notify.ts when a completion notification has actually been
// delivered to the host turn (or was deduped as already delivered). Carries
// every runId the notification covered so the widget can retire those rows.
export const SUBAGENT_NOTIFY_DELIVERED_EVENT = "subagent:notify-delivered";
export const SUBAGENT_SPAWN_STARTED_EVENT = "subagent:spawn_started";
export const SUBAGENT_COMPLETED_EVENT = "subagent:completed";
export const SUBAGENT_FAILED_EVENT = "subagent:failed";
export const SUBAGENT_PHASE_CHANGE_EVENT = "subagent:phase-change";
export const SUBAGENT_STUCK_EVENT = "subagent:stuck";
export const SUBAGENT_CONTROL_EVENT = "subagent:control-event";
export const SUBAGENT_CONTROL_INTERCOM_EVENT = "subagent:control-intercom";
export const SUBAGENT_NEEDS_ATTENTION_EVENT = "subagent:needs-attention";

export interface SubagentPhaseChangePayload {
	runId: string;
	stepIndex: number;
	phase: RunPhase;
	previousPhase?: RunPhase;
	toolName?: string;
	ts: number;
}

export interface SubagentStuckPayload {
	runId: string;
	stepIndex: number;
	phase: RunPhase;
	sinceMs: number;
	toolName?: string;
}

export interface SubagentNeedsAttentionPayload {
	runId: string;
	agent: string;
	ts: number;
	message: string;
	index?: number;
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
	/**
	 * Per-process ceiling on concurrently executing leaf agents across ALL
	 * dispatch paths (sync, async, parallel, workflow). This is the single
	 * concurrency knob; there are no per-invocation or per-batch settings.
	 * Parents awaiting their own children do not occupy a slot. Default 4.
	 */
	maxConcurrentAgents?: number;
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

export const MAX_PARALLEL = 8;
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

export function resolveChildMaxSubagentDepth(parentMaxDepth: number, agentMaxDepth?: number): number {
	const normalizedParent = normalizeMaxSubagentDepth(parentMaxDepth) ?? DEFAULT_SUBAGENT_MAX_DEPTH;
	const normalizedAgent = normalizeMaxSubagentDepth(agentMaxDepth);
	return normalizedAgent === undefined ? normalizedParent : Math.min(normalizedParent, normalizedAgent);
}

export function normalizeAgentIdentity(value: unknown): string | undefined {
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

const LEGACY_NESTED_DELEGATOR_AGENT_NAMES = new Set(["orchestrator", "delegate"]);
export const LEGACY_ALLOWED_NESTED_CHILD_AGENT_NAMES = new Set([
	"explorer",
	"librarian",
	"oracle",
	"designer",
	"fixer",
]);

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
	options?: {
		canDelegate?: boolean;
		allowedDelegateAgents?: string[];
		parentRunId?: string;
		rootRunId?: string;
		parentSessionId?: string;
		rootSessionId?: string;
	},
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
	if (options?.rootRunId) env.PI_SUBAGENT_ROOT_RUN_ID = options.rootRunId;
	if (options?.canDelegate !== undefined) env.PI_SUBAGENT_CAN_DELEGATE = options.canDelegate ? "1" : "0";
	const allowedDelegateAgents = normalizeAgentList(options?.allowedDelegateAgents);
	if (allowedDelegateAgents) env.PI_SUBAGENT_ALLOWED_DELEGATE_AGENTS = allowedDelegateAgents.join(",");
	return env;
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
