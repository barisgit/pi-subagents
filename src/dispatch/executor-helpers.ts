import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../shared/agents.ts";
import {
	type AgentProgress,
	type ArtifactPaths,
	type ControlEvent,
	type Details,
	type ResolvedControlConfig,
	type SingleResult,
	type SubagentMetadata,
	type SubagentNeedsAttentionPayload,
	type SubagentState,
	type SubagentUsageRecord,
	type TokenUsage,
	type Usage,
	SUBAGENT_CONTROL_EVENT,
	SUBAGENT_CONTROL_INTERCOM_EVENT,
	SUBAGENT_NEEDS_ATTENTION_EVENT,
	SUBAGENT_USAGE_EVENT,
} from "../protocol/types.ts";
import type {
	ExecutionContextData,
	ExecutorDeps,
	ForegroundControlRef,
	InternalSubagentParams,
} from "./executor-types.ts";
import type { ChildAgentResult, PersistedRunStep } from "../protocol/status-types.ts";
import { compactForegroundDetails, getSingleResultOutput } from "../shared/utils.ts";
import { finalizeSingleOutput } from "../surfaces/single-output.ts";
import { resolveSubagentIntercomTarget, type IntercomBridgeState } from "./intercom-bridge.ts";
import {
	formatControlInterruptReason,
	formatControlIntercomMessage,
	formatControlNoticeMessage,
	shouldNotifyControlEvent,
} from "./subagent-control.ts";
import { ASYNC_NO_POLL_GUIDANCE, formatAsyncStatusHint } from "../surfaces/async-guidance.ts";
import type { RunMode } from "../state/run-shape.ts";
import { tokenUsageFromUsage, totalUsageTokens } from "../state/usage-totals.ts";
import type { StatusWriter } from "../state/status-writer.ts";
import { getLineageForSession, resolveRootSessionIdForSession } from "../state/lineage.ts";
import { getCurrentPi } from "../shared/current-pi.ts";
import { logger } from "../shared/logger.ts";
import { findWorktreeTaskCwdConflict, formatWorktreeTaskCwdConflict } from "./worktree.ts";

/**
 * Resolve the parent runId for a dispatch happening NOW. The dispatching
 * session's lineage tells us our own runId; that becomes the parent for any
 * runs we spawn from this turn. Falls back to PI_SUBAGENT_PARENT_RUN_ID for
 * legacy/out-of-process callers, but the in-process executor doesn't set env
 * so lineage is the canonical source.
 */
export function resolveDispatchParentRunId(ctx: {
	sessionManager?: { getSessionId?: () => string | undefined };
}): string | undefined {
	const sid = ctx.sessionManager?.getSessionId?.();
	if (sid) {
		const lineage = getLineageForSession(sid);
		if (lineage?.runId) return lineage.runId;
	}
	return process.env.PI_SUBAGENT_PARENT_RUN_ID;
}
export function resolveDispatchRootRunId(
	ctx: { sessionManager?: { getSessionId?: () => string | undefined } },
	runId: string,
): string {
	const sid = ctx.sessionManager?.getSessionId?.();
	if (sid) {
		const lineage = getLineageForSession(sid);
		if (lineage?.rootRunId) return lineage.rootRunId;
	}
	return process.env.PI_SUBAGENT_ROOT_RUN_ID || runId;
}

export function resolveDispatchRootSessionId(
	ctx: { sessionManager?: { getSessionId?: () => string | undefined } },
	fallbackSessionId?: string,
): string | undefined {
	return resolveRootSessionIdForSession(ctx.sessionManager?.getSessionId?.() ?? fallbackSessionId);
}

/**
 * Append an invisible branch anchor to the HOST session tree for a TOP-LEVEL
 * dispatch. The overlay reads these via getBranch() to scope its top-level rows
 * to the current /tree branch (a revert moves the leaf, dropping abandoned
 * anchors). NESTED dispatches (parentRunId defined) are never anchored — the
 * shard already expands them under their parent. The runId passed MUST equal
 * the runId that appears as the overlay's top-level row for this dispatch (for
 * parallel/workflow that is the openGroup CONTAINER runId, not an inner run).
 * appendEntry is display:false + non-LLM; the try/catch guards a disposed pi
 * during session replacement (mirrors safeEmit).
 */
export function emitRunAnchor(
	pi: ExtensionAPI,
	anchor: {
		runId: string;
		rootRunId: string;
		mode: RunMode;
		source: "sync" | "async";
		parentRunId: string | undefined;
	},
): void {
	if (anchor.parentRunId !== undefined) return;
	try {
		pi.appendEntry("subagent_run", {
			runId: anchor.runId,
			rootRunId: anchor.rootRunId,
			mode: anchor.mode,
			source: anchor.source,
		});
	} catch {
		// disposed pi during session replacement — drop the anchor rather than crash
	}
}

export function publishSubagentUsage(
	pi: ExtensionAPI,
	state: Pick<SubagentState, "usageByRun">,
	record: SubagentUsageRecord,
): void {
	state.usageByRun ??= new Map();
	state.usageByRun.set(record.runId, record);
	try {
		pi.events.emit(SUBAGENT_USAGE_EVENT, record);
	} catch {
		// Usage events are observational; never fail a completed run on listener errors.
	}
	try {
		pi.appendEntry("subagent_usage", record);
	} catch {
		// Session replacement may dispose the pi while async completion is publishing.
	}
}

/**
 * Emit a subagent lifecycle event on the host pi.events bus, resolving the
 * CURRENT pi at emit time. The SDK invalidates captured pi on session
 * replacement (newSession/fork/switchSession/reload); resolving fresh avoids
 * emitting into a disposed bus. The try/catch protects against the brief
 * window where the previous pi is disposed but the new activate hasn't fired
 * yet — we drop those (rare) emits rather than crash the executor.
 */
export function safeEmit(channel: string, data: unknown): void {
	try {
		const pi = getCurrentPi();
		logger.info("safeEmit", { channel, hasPi: !!pi });
		pi?.events.emit(channel, data);
	} catch (err) {
		logger.warn("safeEmit: threw", { channel, err: err instanceof Error ? err.message : String(err) });
		// Ignore: stale pi during reload window. Listeners on the next activate
		// will be re-attached and pick up future events.
	}
}

export function batchToNotifyPolicy(batch: boolean | undefined): "rollup" | "each" {
	return batch === true ? "rollup" : "each";
}

/**
 * Copy a runner progress snapshot onto the in-memory foreground control. This
 * field-copy is identical at all three foreground dispatch sites (resume,
 * parallel-inline, single); only `agent` and `index` diverge per site so the
 * caller resolves them. Background runs never reach this (they have no
 * in-memory control -- the owned-progress vs poll-disk fork).
 */
export function applyForegroundProgress(
	control: ForegroundControlRef,
	agent: string,
	index: number,
	firstProgress: AgentProgress | undefined,
	finalOutput: string | undefined,
): void {
	control.currentAgent = agent;
	control.currentAgentColor = firstProgress?.color;
	control.currentIndex = index;
	control.currentActivityState = firstProgress?.activityState;
	control.lastActivityAt = firstProgress?.lastActivityAt;
	control.currentTool = firstProgress?.currentTool;
	control.currentToolStartedAt = firstProgress?.currentToolStartedAt;
	control.phase = firstProgress?.phase;
	control.phaseStartedAt = firstProgress?.phaseStartedAt;
	control.lastToolEndAt = firstProgress?.lastToolEndAt;
	control.recentTools = firstProgress?.recentTools;
	control.recentOutput = firstProgress?.recentOutput;
	control.finalOutput = finalOutput;
	control.updatedAt = Date.now();
}

/**
 * Mirror a runner progress snapshot into the sync status.json run-level fields.
 * Shared by the single + resume foreground sites; the `steps` array stays
 * caller-built (resume echoes siblings and finalizes only the resumed step;
 * single builds a 1-element array) -- an essential fork. The parallel site does
 * NOT use this: a parallel child persists via StatusWriter.enqueue.
 */
export function mirrorForegroundProgressToStatus(
	writer: StatusWriter | undefined,
	firstProgress: AgentProgress | undefined,
	currentStep: number,
	steps: unknown,
	executionStartedAt?: number,
	totalTokens?: TokenUsage,
): void {
	// A foreground run record opens "queued" (it may be blocked on a leaf permit).
	// This mirror fires only once the child has actually begun executing, so it is
	// the seam that flips the run-level state to "running". Terminal finalize
	// (finalizeTerminal) remains authoritative for complete/failed.
	// mergePatch bypasses applyPatchToStatus, so the queued->running execution
	// stamp must be carried here explicitly (the control supplies a stable value).
	writer?.mergePatch({
		state: "running",
		currentStep,
		...(executionStartedAt !== undefined ? { executionStartedAt } : {}),
		lastActivityAt: firstProgress?.lastActivityAt,
		currentTool: firstProgress?.currentTool,
		currentToolStartedAt: firstProgress?.currentToolStartedAt,
		phase: firstProgress?.phase,
		phaseStartedAt: firstProgress?.phaseStartedAt,
		steps: steps as never,
		...(totalTokens ? { totalTokens } : {}),
	});
}

export function validationError(message: string): AgentToolResult<Details> {
	return {
		content: [{ type: "text", text: message }],
		isError: true,
		details: { mode: "management" as const, results: [] },
	};
}

function emitControlNotification(input: {
	pi: ExtensionAPI;
	controlConfig: ResolvedControlConfig;
	intercomBridge: IntercomBridgeState;
	event: ControlEvent;
}): void {
	if (!shouldNotifyControlEvent(input.controlConfig, input.event)) return;
	const childIntercomTarget = input.intercomBridge.active
		? resolveSubagentIntercomTarget(input.event.runId, input.event.agent, input.event.index)
		: undefined;
	const payload = {
		event: input.event,
		source: "foreground" as const,
		childIntercomTarget,
		noticeText: formatControlNoticeMessage(input.event, childIntercomTarget),
	};
	if (input.controlConfig.notifyChannels.includes("event")) {
		input.pi.events.emit(SUBAGENT_CONTROL_EVENT, payload);
		if (input.event.type === "needs_attention") {
			input.pi.events.emit(SUBAGENT_NEEDS_ATTENTION_EVENT, {
				runId: input.event.runId,
				agent: input.event.agent,
				ts: input.event.ts,
				message: input.event.message,
				...(input.event.index !== undefined ? { index: input.event.index } : {}),
			} satisfies SubagentNeedsAttentionPayload);
		}
	}
	if (
		input.controlConfig.notifyChannels.includes("intercom") &&
		input.intercomBridge.active &&
		input.intercomBridge.orchestratorTarget
	) {
		input.pi.events.emit(SUBAGENT_CONTROL_INTERCOM_EVENT, {
			...payload,
			to: input.intercomBridge.orchestratorTarget,
			message: formatControlIntercomMessage(input.event, childIntercomTarget),
		});
	}
}

export function createForegroundControlNotifier(
	data: Pick<ExecutionContextData, "controlConfig" | "intercomBridge">,
	deps: Pick<ExecutorDeps, "pi">,
): (event: ControlEvent) => void {
	return (event) =>
		emitControlNotification({
			pi: deps.pi,
			controlConfig: data.controlConfig,
			intercomBridge: data.intercomBridge,
			event,
		});
}

export function interruptForegroundOnNeedsAttention(
	event: ControlEvent,
	interruptController: AbortController,
	foregroundControl?: ForegroundControlRef,
): boolean {
	if (event.type !== "needs_attention" || interruptController.signal.aborted) return false;
	interruptController.abort(formatControlInterruptReason(event));
	if (foregroundControl) {
		foregroundControl.currentActivityState = undefined;
		foregroundControl.updatedAt = Date.now();
	}
	return true;
}

export function getRequestedModeLabel(params: InternalSubagentParams): Details["mode"] {
	if ((params.tasks?.length ?? 0) > 0) return "parallel";
	if (params.agent) return "single";
	return "single";
}

export function asyncStartedResult(input: {
	mode: "single" | "parallel";
	runId: string;
	asyncDir: string;
	text: string;
	children?: Array<{ runId: string; agent: string; label?: string; stepIndex: number }>;
}): AgentToolResult<Details> {
	return {
		content: [
			{
				type: "text",
				text: `${input.text}\nState: running\n${formatAsyncStatusHint(input.runId)}\n${ASYNC_NO_POLL_GUIDANCE}`,
			},
		],
		details: {
			mode: input.mode,
			results: [],
			runId: input.runId,
			asyncId: input.runId,
			asyncDir: input.asyncDir,
			...(input.children ? { children: input.children } : {}),
		},
	};
}

export function buildParallelModeError(message: string): AgentToolResult<Details> {
	return {
		content: [{ type: "text", text: message }],
		isError: true,
		details: { mode: "parallel" as const, results: [] },
	};
}

export function tokenUsageFromResult(
	result: SingleResult,
): { input: number; output: number; cacheRead?: number; cacheWrite?: number; total: number } | undefined {
	return tokenUsageFromUsage(result.usage);
}

export function terminalStatusStepFromResult(result: SingleResult): Partial<PersistedRunStep> {
	const toolCallCount = result.toolCallCount ?? result.progressSummary?.toolCount ?? 0;
	return {
		status: result.interrupted ? "interrupted" : result.exitCode === 0 ? "complete" : "failed",
		tokens: tokenUsageFromResult(result),
		durationMs: result.progressSummary?.durationMs,
		error: result.error,
		live: {
			outputText: getSingleResultOutput(result),
			toolCallCount,
			toolResultCount: result.toolResultCount ?? 0,
			toolErrorCount: result.toolErrorCount ?? 0,
			toolCount: toolCallCount,
			tokens: totalUsageTokens(result.usage),
		},
	};
}

export function emitSyncLifecycleEvent(
	pi: ExtensionAPI,
	event: string,
	payload: {
		runId: string;
		agent: string;
		task?: string;
		cwd?: string;
		exitCode?: number;
		error?: string;
		metadata?: SubagentMetadata;
	},
): void {
	pi.events.emit(event, payload);
}

export function emptyUsage(): Usage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

/**
 * Add `addend` into `base` in place and return `base`.
 * Treats missing fields as 0. Preserves explicit zeroes on the optional fields.
 */
export function addUsageInto(base: Usage, addend: Usage | undefined): Usage {
	if (!addend) return base;
	base.input += addend.input || 0;
	base.output += addend.output || 0;
	base.cacheRead = (base.cacheRead ?? 0) + (addend.cacheRead || 0);
	base.cacheWrite = (base.cacheWrite ?? 0) + (addend.cacheWrite || 0);
	base.cost = (base.cost ?? 0) + (addend.cost || 0);
	base.turns = (base.turns ?? 0) + (addend.turns || 0);
	return base;
}

/** Sum any number of usages into a fresh accumulator. */
export function sumUsages(...usages: (Usage | undefined)[]): Usage {
	const total = emptyUsage();
	for (const u of usages) addUsageInto(total, u);
	return total;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function usageFromValue(value: unknown): Usage | undefined {
	if (!isRecord(value)) return undefined;
	const usage = emptyUsage();
	let found = false;
	const addNumber = (key: keyof Usage): void => {
		const n = value[key];
		if (typeof n !== "number" || !Number.isFinite(n)) return;
		usage[key] = n;
		found = true;
	};
	addNumber("input");
	addNumber("output");
	addNumber("cacheRead");
	addNumber("cacheWrite");
	addNumber("cost");
	addNumber("turns");
	return found ? usage : undefined;
}

function subagentUsageFromToolResult(result: unknown): Usage | undefined {
	if (!isRecord(result) || !isRecord(result.details)) return undefined;
	return usageFromValue(result.details.totalUsage);
}

function subagentUsageFromRunEnvelope(envelope: unknown): Usage | undefined {
	if (!isRecord(envelope) || !Array.isArray(envelope.timeline)) return undefined;
	const total = emptyUsage();
	let found = false;
	for (const event of envelope.timeline) {
		if (!isRecord(event)) continue;
		const toolName = typeof event.toolName === "string" ? event.toolName : undefined;
		if (toolName !== "subagent") continue;
		const usage = subagentUsageFromToolResult(event.result);
		if (!usage) continue;
		addUsageInto(total, usage);
		found = true;
	}
	return found ? total : undefined;
}

/**
 * Extract descendant usage from a completed tool event.
 *
 * Normal Pi sessions emit a `subagent` tool result directly. fo routes all
 * extension calls through `run`, so the same subagent result sits inside the
 * sandbox envelope timeline instead. Treat both shapes identically so nested
 * delegation keeps bubbling usage into its parent run.
 */
export function nestedSubagentUsageFromToolEvent(record: Record<string, unknown>): Usage | undefined {
	if (record.type !== "tool_execution_end") return undefined;
	const toolName = typeof record.toolName === "string" ? record.toolName : undefined;
	if (toolName === "subagent") return subagentUsageFromToolResult(record.result);
	if (toolName !== "run" || !isRecord(record.result)) return undefined;
	return subagentUsageFromRunEnvelope(record.result.details);
}

export function resolveChildTools(agentConfig: AgentConfig): { activeToolNames: string[] | undefined } {
	// Semantics:
	//   tools frontmatter absent (undefined)  -> no allowlist => session sees ALL tools
	//   tools frontmatter explicit list       -> allowlist exactly those names
	//   tools: []                              -> explicit empty allowlist (zero tools)
	// Globs/negations were already expanded at registration time via
	// resolveAgentToolPatterns(discoverAgents(...)) in index.ts, so by the time
	// we reach here agentConfig.tools is either undefined or a concrete name list.
	const expanded = agentConfig.tools === undefined ? undefined : [...new Set(agentConfig.tools)];
	// A non-delegating agent must never reach a delegation tool, even if its allowlist
	// (e.g. `*`) expanded to include one. `workflow` spawns child agents exactly like
	// `subagent`, so both are stripped whenever canDelegate is explicitly false. This is
	// the process-independent gate for in-process children (the env-based
	// checkNestedDelegationGuard only covers separate-process dispatch).
	const baseAllow =
		agentConfig.canDelegate === false && expanded !== undefined
			? expanded.filter((name) => name !== "subagent" && name !== "workflow")
			: expanded;
	const mcpDirect = agentConfig.mcpDirectTools ?? [];
	// With no allowlist, the child sees all tools including mcpDirectTools. With an
	// explicit allowlist, include mcpDirectTools by name so the child's own executable
	// tool definition is enabled; host getAllTools() metadata stubs lack execute and
	// would clobber the child's real registered tool if passed as customTools.
	const activeToolNames = baseAllow === undefined ? undefined : [...new Set([...baseAllow, ...mcpDirect])];
	return { activeToolNames };
}

export function buildParallelWorktreeTaskCwdError(
	tasks: ReadonlyArray<{ agent: string; cwd?: string }>,
	sharedCwd: string,
): string | undefined {
	const conflict = findWorktreeTaskCwdConflict(tasks, sharedCwd);
	if (!conflict) return undefined;
	return formatWorktreeTaskCwdConflict(conflict, sharedCwd);
}

export function buildAsyncAggregateCompletePayload(params: {
	id: string;
	runId: string;
	parentRunId?: string;
	rootRunId: string;
	notifyPolicy: "rollup" | "each";
	success: boolean;
	agent: string;
	summary: string;
	state: string | undefined;
	results: unknown[];
	children: unknown[];
	total: number;
	completed: number;
	asyncDir: string;
	metadata: SubagentMetadata | undefined;
	/** Present only for the A/B aggregate (parallel-group / non-layer0 async) shape. */
	syncFields?: {
		exitCode: number | undefined;
		durationMs: number | undefined;
		sessionFile: string | undefined;
		shareUrl: string | undefined;
		result: unknown;
		totalUsage: unknown;
		batch: boolean;
		batchId: string;
	};
	/** Present only for the C (workflow) shape. */
	workflowFields?: {
		kind: "workflow";
		agents: string;
	};
}): Record<string, unknown> {
	const sync = params.syncFields;
	const workflow = params.workflowFields;
	return {
		id: params.id,
		runId: params.runId,
		...(params.parentRunId ? { parentRunId: params.parentRunId } : {}),
		rootRunId: params.rootRunId,
		notifyPolicy: params.notifyPolicy,
		...(workflow ? { kind: workflow.kind, agents: workflow.agents } : {}),
		success: params.success,
		agent: params.agent,
		summary: params.summary,
		...(sync
			? {
					exitCode: sync.exitCode,
					durationMs: sync.durationMs,
					sessionFile: sync.sessionFile,
					shareUrl: sync.shareUrl,
				}
			: {}),
		state: params.state,
		timestamp: Date.now(),
		...(sync ? { result: sync.result } : {}),
		results: params.results,
		children: params.children,
		...(sync
			? {
					batch: sync.batch,
					...(sync.batch ? { batchId: sync.batchId } : {}),
				}
			: {}),
		total: params.total,
		completed: params.completed,
		...(sync ? { totalUsage: sync.totalUsage } : {}),
		asyncDir: params.asyncDir,
		metadata: params.metadata,
	};
}

export function singleResultToChildAgentResult(
	result: SingleResult,
	prepared: { runId: string; sessionFile: string; stepIndex?: number },
): ChildAgentResult {
	return {
		runId: prepared.runId,
		stepIndex: prepared.stepIndex ?? 0,
		state: result.interrupted ? "interrupted" : result.exitCode === 0 ? "complete" : "failed",
		exitCode: result.exitCode === 0 ? 0 : 1,
		outputText: getSingleResultOutput(result),
		toolCallCount: result.toolCallCount ?? result.progressSummary?.toolCount ?? 0,
		toolResultCount: result.toolResultCount ?? 0,
		toolErrorCount: result.toolErrorCount ?? 0,
		durationMs: result.progressSummary?.durationMs ?? 0,
		startedAt: Date.now() - (result.progressSummary?.durationMs ?? 0),
		endedAt: Date.now(),
		sessionFile: result.sessionFile ?? prepared.sessionFile,
		...(result.shareUrl ? { shareUrl: result.shareUrl } : {}),
		...(result.error ? { error: { message: result.error } } : {}),
		usage: {
			input: result.usage.input,
			output: result.usage.output,
			cacheRead: result.usage.cacheRead ?? 0,
			cacheWrite: result.usage.cacheWrite ?? 0,
			cost: result.usage.cost ?? 0,
			turns: result.usage.turns ?? 0,
		},
	};
}

/**
 * Shape a finished sync single-step SingleResult into the tool result the
 * parent sees. Single source of truth for the foreground single result shape:
 * the sync single dispatch tail AND sync resume both route through here, so
 * the two cannot drift (detached/interrupted/failed/success branches, display
 * output finalization, compact single-mode details).
 */
export function shapeSingleForegroundResult(args: {
	r: SingleResult;
	runId: string;
	agent: string;
	outputPath?: string;
	progress?: AgentProgress[];
	artifacts?: { dir: string; files: ArtifactPaths[] };
}): AgentToolResult<Details> {
	const { r, runId, agent } = args;
	const fullOutput = getSingleResultOutput(r);
	const finalizedOutput = finalizeSingleOutput({
		fullOutput,
		truncatedOutput: r.truncation?.text,
		outputPath: args.outputPath,
		exitCode: r.exitCode,
		savedPath: r.savedOutputPath,
		saveError: r.outputSaveError,
	});
	const details = compactForegroundDetails({
		mode: "single",
		runId,
		results: [r],
		progress: args.progress,
		artifacts: args.artifacts,
		truncation: r.truncation,
	});
	if (r.detached) {
		return {
			content: [{ type: "text", text: `Detached for intercom coordination: ${agent}` }],
			details,
		};
	}
	if (r.interrupted) {
		return {
			content: [
				{
					type: "text",
					text: `Run ${runId} paused after interrupt. Resume with subagent({ action: "resume", id: "${runId}", message: "Continue the interrupted work." }).`,
				},
			],
			details,
		};
	}
	if (r.exitCode !== 0)
		return {
			content: [{ type: "text", text: r.error || "Failed" }],
			details,
			isError: true,
		};
	return {
		content: [{ type: "text", text: finalizedOutput.displayOutput || "(no output)" }],
		details,
	};
}
