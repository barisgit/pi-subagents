import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../shared/agents.ts";
import {
	type AgentProgress,
	type ControlEvent,
	type Details,
	type ResolvedControlConfig,
	type SingleResult,
	type SubagentMetadata,
	type SubagentNeedsAttentionPayload,
	type Usage,
	SUBAGENT_CONTROL_EVENT,
	SUBAGENT_CONTROL_INTERCOM_EVENT,
	SUBAGENT_NEEDS_ATTENTION_EVENT,
} from "../protocol/types.ts";
import type { ExecutionContextData, ExecutorDeps, ForegroundControlRef, InternalSubagentParams } from "./executor-types.ts";
import { resolveSubagentIntercomTarget, type IntercomBridgeState } from "./intercom-bridge.ts";
import { formatControlInterruptReason, formatControlIntercomMessage, formatControlNoticeMessage, shouldNotifyControlEvent } from "./subagent-control.ts";
import { createSubmitResultTool, SUBMIT_RESULT_TOOL_NAME } from "../protocol/submit-result.ts";
import { ASYNC_NO_POLL_GUIDANCE, formatAsyncStatusHint } from "../surfaces/async-guidance.ts";
import type { RunMode } from "../state/run-shape.ts";
import { tokenUsageFromUsage } from "../state/usage-totals.ts";
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
export function resolveDispatchParentRunId(ctx: { sessionManager?: { getSessionId?: () => string | undefined } }): string | undefined {
	const sid = ctx.sessionManager?.getSessionId?.();
	if (sid) {
		const lineage = getLineageForSession(sid);
		if (lineage?.runId) return lineage.runId;
	}
	return process.env.PI_SUBAGENT_PARENT_RUN_ID;
}
export function resolveDispatchRootRunId(ctx: { sessionManager?: { getSessionId?: () => string | undefined } }, runId: string): string {
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
	anchor: { runId: string; rootRunId: string; mode: RunMode; source: "sync" | "async"; parentRunId: string | undefined },
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
): void {
	writer?.mergePatch({
		currentStep,
		lastActivityAt: firstProgress?.lastActivityAt,
		currentTool: firstProgress?.currentTool,
		currentToolStartedAt: firstProgress?.currentToolStartedAt,
		phase: firstProgress?.phase,
		phaseStartedAt: firstProgress?.phaseStartedAt,
		steps: steps as never,
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
	if (input.controlConfig.notifyChannels.includes("intercom") && input.intercomBridge.active && input.intercomBridge.orchestratorTarget) {
		input.pi.events.emit(SUBAGENT_CONTROL_INTERCOM_EVENT, {
			...payload,
			to: input.intercomBridge.orchestratorTarget,
			message: formatControlIntercomMessage(input.event, childIntercomTarget),
		});
	}
}

export function createForegroundControlNotifier(data: Pick<ExecutionContextData, "controlConfig" | "intercomBridge">, deps: Pick<ExecutorDeps, "pi">): (event: ControlEvent) => void {
	return (event) => emitControlNotification({
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
		content: [{ type: "text", text: `${input.text}\nState: running\n${formatAsyncStatusHint(input.runId)}\n${ASYNC_NO_POLL_GUIDANCE}` }],
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

export function tokenUsageFromResult(result: SingleResult): { input: number; output: number; cacheRead?: number; cacheWrite?: number; total: number } | undefined {
	return tokenUsageFromUsage(result.usage);
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

export function resolveChildTools(agentConfig: AgentConfig, pi: ExtensionAPI): { activeToolNames: string[] | undefined; customTools: ToolDefinition[] } {
	// Semantics:
	//   tools frontmatter absent (undefined)  -> no allowlist => session sees ALL tools
	//   tools frontmatter explicit list       -> allowlist exactly those names
	//   tools: []                              -> explicit empty allowlist (zero tools)
	// Globs/negations were already expanded at registration time via
	// resolveAgentToolPatterns(discoverAgents(...)) in index.ts, so by the time
	// we reach here agentConfig.tools is either undefined or a concrete name list.
	const expanded = agentConfig.tools === undefined
		? undefined
		: [...new Set([...agentConfig.tools, SUBMIT_RESULT_TOOL_NAME])];
	// A non-delegating agent must never reach a delegation tool, even if its allowlist
	// (e.g. `*`) expanded to include one. `workflow` spawns child agents exactly like
	// `subagent`, so both are stripped whenever canDelegate is explicitly false. This is
	// the process-independent gate for in-process children (the env-based
	// checkNestedDelegationGuard only covers separate-process dispatch).
	const activeToolNames = agentConfig.canDelegate === false && expanded !== undefined
		? expanded.filter((name) => name !== "subagent" && name !== "workflow")
		: expanded;
	const customToolNames = new Set(agentConfig.mcpDirectTools ?? []);
	const customTools = [
		...pi.getAllTools().filter((tool) => customToolNames.has(tool.name)),
		createSubmitResultTool(),
	] as ToolDefinition[];
	return { activeToolNames, customTools };
}

export function buildParallelWorktreeTaskCwdError(
	tasks: ReadonlyArray<{ agent: string; cwd?: string }>,
	sharedCwd: string,
): string | undefined {
	const conflict = findWorktreeTaskCwdConflict(tasks, sharedCwd);
	if (!conflict) return undefined;
	return formatWorktreeTaskCwdConflict(conflict, sharedCwd);
}
