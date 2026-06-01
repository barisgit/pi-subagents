import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ToolDefinition, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { type AgentConfig, type AgentScope, resolveAgentColor } from "./agents.ts";
import { ensureArtifactsDir, getArtifactPaths, getArtifactsDir, writeArtifact, writeMetadata } from "./artifacts.ts";
import { ChainClarifyComponent, type ChainClarifyResult, type ModelInfo } from "./chain-clarify.ts";
import { executeChain } from "./chain-execution.ts";
import { resolveExecutionAgentScope } from "./agent-scope.ts";
import { handleManagementAction } from "./agent-management.ts";
import { buildModelCandidates, resolveModelCandidate } from "./model-fallback.ts";
import { aggregateParallelOutputs } from "./parallel-utils.ts";
import { recordRun } from "./run-history.ts";
import {
	getStepAgents,
	isParallelStep,
	resolveStepBehavior,
	type ChainStep,
	type SequentialStep,
} from "./settings.ts";
import { buildSkillInjection, discoverAvailableSkills, normalizeSkillInput, resolveSkillsWithFallback } from "./skills.ts";
import { createForkContextResolver } from "./fork-context.ts";
import { type ChildAgentHandle, type ChildAgentResult, type ChildAgentStep, type StatusPatch, ChildAgentRegistry, dispatchAsyncChild, runChildAgent } from "./in-process-executor.ts";
import { applyIntercomBridgeToAgent, resolveIntercomBridge, resolveIntercomSessionTarget, resolveSubagentIntercomTarget, type IntercomBridgeState } from "./intercom-bridge.ts";
import { createActivityTicker, formatControlIntercomMessage, formatControlInterruptReason, formatControlNoticeMessage, resolveControlConfig, shouldNotifyControlEvent } from "./subagent-control.ts";
import { captureSingleOutputSnapshot, finalizeSingleOutput, injectSingleOutputInstruction, resolveSingleOutput, resolveSingleOutputPath } from "./single-output.ts";
import { createSubmitResultTool, injectSubmitResultInstruction, SUBMIT_RESULT_TOOL_NAME } from "./submit-result.ts";
import { resolveChildSessionFile } from "./session-paths.ts";
import { StatusWriter } from "./status-writer.ts";
import { ASYNC_NO_POLL_GUIDANCE, formatAsyncStatusHint } from "./async-guidance.ts";
import { formatRunHandle } from "./run-shape.ts";
import { compactForegroundDetails, extractTextFromContent, getFinalOutput, getSingleResultOutput, mapConcurrent, readStatus, resolveChildCwd } from "./utils.ts";
import { tokenUsageFromUsage, totalUsageTokens } from "./usage-totals.ts";
import { inspectSubagentStatus } from "./run-status.ts";
import { applyForceTopLevelAsyncOverride } from "./top-level-async.ts";
import {
	writeSyncRunStatusEnd,
	writeSyncRunStatusStart,
	writeSyncRunStatusUpdate,
	type SyncRunStepInit,
} from "./sync-run-persistence.ts";
import { appendRunEntry, readAllEntries, type RunsRegistryEntry } from "./runs-registry.ts";
import { evictCompletionDedupeForRunId } from "./completion-dedupe.ts";
import { interruptRun, spawnRun, openGroup, awaitRun } from "./layer0-runs.ts";
import { logger } from "./logger.ts";
import { getCurrentPi } from "./current-pi.ts";
import { getLineageForSession, resolveRootSessionIdForSession } from "./lineage.ts";
import type { SubagentToolInput, Step, Task } from "./schemas.ts";
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
 * Emit a subagent lifecycle event on the host pi.events bus, resolving the
 * CURRENT pi at emit time. The SDK invalidates captured pi on session
 * replacement (newSession/fork/switchSession/reload); resolving fresh avoids
 * emitting into a disposed bus. The try/catch protects against the brief
 * window where the previous pi is disposed but the new activate hasn't fired
 * yet — we drop those (rare) emits rather than crash the executor.
 */
function safeEmit(channel: string, data: unknown): void {
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
import {
	cleanupWorktrees,
	createWorktrees,
	diffWorktrees,
	findWorktreeTaskCwdConflict,
	formatWorktreeDiffSummary,
	formatWorktreeTaskCwdConflict,
	type WorktreeSetup,
} from "./worktree.ts";
import {
	type AgentProgress,
	type ArtifactConfig,
	type ArtifactPaths,
	type ControlConfig,
	type ControlEvent,
	type Details,
	type ExtensionConfig,
	type ForkReuseConfig,
	type MaxOutputConfig,
	type ResolvedControlConfig,
	type SingleResult,
	type SubagentMetadata,
	type SubagentState,
	type Usage,
	DEFAULT_ARTIFACT_CONFIG,
	DEFAULT_MAX_OUTPUT,
	SUBAGENT_COMPLETED_EVENT,
	SUBAGENT_CONTROL_EVENT,
	SUBAGENT_CONTROL_INTERCOM_EVENT,
	SUBAGENT_NEEDS_ATTENTION_EVENT,
	SUBAGENT_ASYNC_COMPLETE_EVENT,
	SUBAGENT_ASYNC_RUN_COMPLETE_EVENT,
	SUBAGENT_ASYNC_STARTED_EVENT,
	SUBAGENT_FAILED_EVENT,
	SUBAGENT_SPAWN_STARTED_EVENT,
	type SubagentNeedsAttentionPayload,
	checkNestedDelegationGuard,
	checkSubagentDepth,
	isInsideChildSession,
	resolveTopLevelParallelConcurrency,
	resolveTopLevelParallelMaxTasks,
	resolveChildMaxSubagentDepth,
	resolveCurrentMaxSubagentDepth,
	truncateOutput,
	wrapForkTask,
} from "./types.ts";
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];
function applyThinkingSuffix(model: string | undefined, thinking: string | undefined): string | undefined {
	if (!model || !thinking || thinking === "off") return model;
	const colonIdx = model.lastIndexOf(":");
	if (colonIdx !== -1 && THINKING_LEVELS.includes(model.substring(colonIdx + 1))) return model;
	return `${model}:${thinking}`;
}
interface TaskParam {
	agent: string;
	task: string;
	/** Caller-provided short summary (~5-10 words) shown in widgets and status overlays. */
	label?: string;
	cwd?: string;
	count?: number;
	model?: string;
	skill?: string | string[] | boolean;
}
export type { SubagentToolInput, Step, Task };
export type { SubagentToolInput as SubagentParamsLike };
export function batchToNotifyPolicy(batch: boolean | undefined): "rollup" | "each" {
	return batch === true ? "rollup" : "each";
}
interface InternalSubagentParams {
	action?: string;
	id?: string;
	runId?: string;
	dir?: string;
	agent?: string;
	task?: string;
	/** Caller-provided short summary (~5-10 words) shown in widgets and status overlays. */
	label?: string;
	chain?: ChainStep[];
	tasks?: TaskParam[];
	prompt?: string;
	message?: string;
	concurrency?: number;
	worktree?: boolean;
	batch?: boolean;
	context?: "fresh" | "fork";
	async?: boolean;
	clarify?: boolean;
	share?: boolean;
	control?: ControlConfig;
	sessionDir?: string;
	cwd?: string;
	maxOutput?: MaxOutputConfig;
	artifacts?: boolean;
	includeProgress?: boolean;
	model?: string;
	skill?: string | string[] | boolean;
	output?: string | boolean;
	agentScope?: unknown;
	chainDir?: string;
	preset?: string;
	metadata?: SubagentMetadata;
	rawAgentConfig?: AgentConfig;
}
interface ExecutorDeps {
	pi: ExtensionAPI;
	state: SubagentState;
	config: ExtensionConfig;
	asyncByDefault: boolean;
	tempArtifactsDir: string;
	childRegistry: ChildAgentRegistry;
	expandTilde: (p: string) => string;
	discoverAgents: (cwd: string, scope: AgentScope, options?: { preset?: string; includeInternal?: boolean }) => { agents: AgentConfig[] };
	getActiveRootRoleName?: () => string | undefined;
}
interface ExecutionContextData {
	params: InternalSubagentParams;
	effectiveCwd: string;
	ctx: ExtensionContext;
	signal: AbortSignal;
	onUpdate?: (r: AgentToolResult<Details>) => void;
	agents: AgentConfig[];
	runId: string;
	rootRunId: string;
	shareEnabled: boolean;
	sessionRoot: string;
	sessionDirForIndex: (idx?: number) => string;
	sessionFileForIndex: (idx?: number) => string | undefined;
	artifactConfig: ArtifactConfig;
	artifactsDir: string;
	backgroundRequestedWhileClarifying: boolean;
	effectiveAsync: boolean;
	controlConfig: ResolvedControlConfig;
	intercomBridge: IntercomBridgeState;
	forkReuse?: ForkReuseConfig;
}
function resolveRequestedCwd(runtimeCwd: string, requestedCwd: string | undefined): string {
	return requestedCwd ? path.resolve(runtimeCwd, requestedCwd) : runtimeCwd;
}
function getForegroundControl(state: SubagentState, runId: string | undefined) {
	if (runId) return state.foregroundControls.get(runId);
	if (state.lastForegroundControlId) {
		const latest = state.foregroundControls.get(state.lastForegroundControlId);
		if (latest) return latest;
	}
	let newest: (SubagentState["foregroundControls"] extends Map<string, infer T> ? T : never) | undefined;
	for (const control of state.foregroundControls.values()) {
		if (!newest || control.updatedAt > newest.updatedAt) newest = control;
	}
	return newest;
}
function formatForegroundActivity(control: SubagentState["foregroundControls"] extends Map<string, infer T> ? T : never): string | undefined {
	if (control.currentTool && control.currentToolStartedAt) {
		return `tool ${control.currentTool} for ${Math.floor(Math.max(0, Date.now() - control.currentToolStartedAt) / 1000)}s`;
	}
	if (!control.lastActivityAt) return control.currentActivityState === "needs_attention" ? "needs attention" : undefined;
	const seconds = Math.floor(Math.max(0, Date.now() - control.lastActivityAt) / 1000);
	return control.currentActivityState === "needs_attention" ? `no activity for ${seconds}s` : `active ${seconds}s ago`;
}
const SLIM_TOP_LEVEL_KEYS = new Set(["run", "chain", "async", "batch", "concurrency", "worktree", "message", "action", "id"]);
const SLIM_TASK_KEYS = new Set(["agent", "task", "label", "context", "output"]);
const ALLOWED_CONTROL_ACTIONS = ["list", "status", "interrupt", "resume"] as const;
const REMOVED_CRUD_ACTIONS = new Set(["create", "update", "delete", "get"]);
function validationError(message: string): AgentToolResult<Details> {
	return {
		content: [{ type: "text", text: message }],
		isError: true,
		details: { mode: "management" as const, results: [] },
	};
}
function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function validateSlimTask(task: unknown, pathLabel: string): AgentToolResult<Details> | null {
	if (!isRecord(task)) return validationError(`${pathLabel} must be a task with agent and task.`);
	const unknownKey = Object.keys(task).find((key) => !SLIM_TASK_KEYS.has(key));
	if (unknownKey) return validationError(`Unknown task key '${unknownKey}' at ${pathLabel}.`);
	if (typeof task.agent !== "string" || typeof task.task !== "string") {
		return validationError(`${pathLabel} must be a task with agent and task.`);
	}
	// Same-agent enforcement for context:"fork" happens at dispatch time in
	// resolveForkReuseConfig, where the current agent identity is known.
	return null;
}
function isTaskStep(step: unknown): step is TaskParam {
	return isRecord(step)
		&& typeof step.agent === "string"
		&& typeof step.task === "string";
}
function applySharedMessage(message: string, task: string): string {
	if (message === "") return task;
	if (message.includes("{task}") || message.includes("{in}") || message.includes("{previous}")) {
		return message.replaceAll("{task}", task).replaceAll("{in}", task);
	}
	return `${message}\n\n${task}`;
}
function normalizeRunDispatchParams(params: InternalSubagentParams): { params?: InternalSubagentParams; error?: AgentToolResult<Details> } {
	const slimValidationError = validateSubagentToolInput(params);
	if (slimValidationError) return { error: slimValidationError };
	const input = params as InternalSubagentParams & { run?: unknown[]; message?: string; chain?: boolean; concurrency?: number };
	if (!Array.isArray(input.run) || input.run.length === 0) {
		return { error: validationError("`run` must contain at least one task") };
	}
	if (input.message) {
		const placeholderCount = (input.message.match(/\{in\}/g) ?? []).length;
		if (placeholderCount > 1) {
			return { error: validationError(`message contains ${placeholderCount} occurrences of {in}; only one is allowed.`) };
		}
	}
	if (input.chain === true) {
		const chain = input.run.map((step) => Array.isArray(step)
			? { parallel: (input.message ? step.map((task) => ({ ...task as TaskParam, task: applySharedMessage(input.message!, (task as TaskParam).task) })) : step) as TaskParam[] }
			: input.message ? { ...step as SequentialStep, task: applySharedMessage(input.message, (step as SequentialStep).task ?? "") } : step as SequentialStep) as ChainStep[];
		return { params: { ...params, chain, task: undefined, tasks: undefined, agent: undefined, message: undefined, prompt: undefined } };
	}
	const firstNestedIndex = input.run.findIndex(Array.isArray);
	if (firstNestedIndex !== -1) {
		return { error: validationError("Nested Task[] only allowed inside `chain:true`") };
	}
	const tasks = input.run as TaskParam[];
	const invalidIndex = tasks.findIndex((task) => !isTaskStep(task));
	if (invalidIndex !== -1) {
		return { error: validationError(`run[${invalidIndex}] must be a task with agent and task.`) };
	}
	if (tasks.length === 1) {
		const [task] = tasks;
		const singleTask = task! as TaskParam & { context?: "fresh" | "fork"; output?: string | boolean };
		const taskText = input.message ? applySharedMessage(input.message, singleTask.task) : singleTask.task;
		return {
			params: {
				...params,
				agent: singleTask.agent,
				task: taskText,
				...(singleTask.label ? { label: singleTask.label } : { label: undefined }),
				...(singleTask.context ? { context: singleTask.context } : { context: undefined }),
				...(singleTask.output !== undefined ? { output: singleTask.output } : {}),
				tasks: undefined,
				chain: undefined,
				message: undefined,
				prompt: undefined,
			},
		};
	}
	const parallelTasks = input.message
		? tasks.map((task) => ({ ...task, task: applySharedMessage(input.message!, task.task) }))
		: tasks;
	return {
		params: {
			...params,
			agent: undefined,
			task: undefined,
			tasks: parallelTasks,
			chain: undefined,
			message: undefined,
			prompt: undefined,
			concurrency: input.concurrency ?? parallelTasks.length,
		},
	};
}
export function validateSubagentToolInput(input: unknown): AgentToolResult<Details> | null {
	if (!isRecord(input)) return null;
	const action = typeof input.action === "string" ? input.action : undefined;
	if (action && REMOVED_CRUD_ACTIONS.has(action)) {
		return validationError(`Author agents as files under agents/<name>.md instead of action:\"${action}\". Allowed actions: ${ALLOWED_CONTROL_ACTIONS.join(", ")}.`);
	}
	if (action && !(ALLOWED_CONTROL_ACTIONS as readonly string[]).includes(action)) {
		return validationError(`Unknown action: ${action}. Allowed actions: ${ALLOWED_CONTROL_ACTIONS.join(", ")}.`);
	}
	if (action === "resume") {
		if (Object.hasOwn(input, "run")) return validationError('resume is per-run; do not supply `run`');
		if (Object.hasOwn(input, "agent")) return validationError('resume takes only `message`; do not supply `agent` or Task');
		if (!Object.hasOwn(input, "id")) return validationError("resume requires `id` (runId)");
		if (!Object.hasOwn(input, "message")) return validationError("resume requires `message` to send to the child");
	}
	const unknownKey = Object.keys(input).find((key) => !SLIM_TOP_LEVEL_KEYS.has(key));
	if (unknownKey) {
		if (unknownKey === "prompt") return validationError("Unknown top-level key 'prompt'; `prompt` renamed to `message`.");
		return validationError(`Unknown top-level key '${unknownKey}'.`);
	}
	if (!Array.isArray(input.run)) return null;
	if (input.run.length === 0) return validationError("`run` must contain at least one task");
	for (let i = 0; i < input.run.length; i++) {
		const step = input.run[i];
		if (Array.isArray(step)) {
			if (input.chain !== true) return validationError("Nested Task[] only allowed inside `chain:true`");
			for (let j = 0; j < step.length; j++) {
				const error = validateSlimTask(step[j], `run[${i}][${j}]`);
				if (error) return error;
			}
			continue;
		}
		const error = validateSlimTask(step, `run[${i}]`);
		if (error) return error;
	}
	return null;
}
function foregroundStatusResult(control: SubagentState["foregroundControls"] extends Map<string, infer T> ? T : never): AgentToolResult<Details> {
	const lines = [
		`Run: ${control.runId}`,
		"State: running",
		`Mode: ${control.mode}`,
		control.currentAgent ? `Current: ${control.currentAgent}${control.currentIndex !== undefined ? ` step ${control.currentIndex + 1}` : ""}` : undefined,
		formatForegroundActivity(control) ? `Activity: ${formatForegroundActivity(control)}` : undefined,
	].filter((line): line is string => Boolean(line));
	return { content: [{ type: "text", text: lines.join("\n") }], details: { mode: "management", results: [] } };
}
function getAsyncInterruptTarget(state: SubagentState, runId: string | undefined): { asyncId: string; asyncDir: string } | undefined {
	if (runId) {
		const direct = state.asyncJobs.get(runId);
		if (direct) return { asyncId: direct.asyncId, asyncDir: direct.asyncDir };
		const registered = readAllEntries().find((entry) => entry.runId === runId);
		if (registered) return { asyncId: registered.runId, asyncDir: registered.runRecordDir };
	}
	let newest: { asyncId: string; asyncDir: string; updatedAt: number } | undefined;
	for (const job of state.asyncJobs.values()) {
		if (job.status !== "running") continue;
		if (!newest || (job.updatedAt ?? 0) > newest.updatedAt) {
			newest = { asyncId: job.asyncId, asyncDir: job.asyncDir, updatedAt: job.updatedAt ?? 0 };
		}
	}
	return newest ? { asyncId: newest.asyncId, asyncDir: newest.asyncDir } : undefined;
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
function interruptAllAsyncRuns(state: SubagentState, childRegistry: ChildAgentRegistry): AgentToolResult<Details> {
	const handles = childRegistry.list();
	const asyncHandles = handles.filter((handle) => state.asyncJobs.has(handle.runId));
	if (asyncHandles.length === 0) {
		return {
			content: [{ type: "text", text: "No running runs to interrupt." }],
			details: { mode: "management", results: [] },
		};
	}
	const seen = new Set<string>();
	const ids: string[] = [];
	for (const handle of asyncHandles) {
		if (seen.has(handle.runId)) continue;
		seen.add(handle.runId);
		ids.push(handle.runId);
		try {
			void childRegistry.abortRun(handle.runId, "interrupt-all requested");
			const tracked = state.asyncJobs.get(handle.runId);
			if (tracked) {
				tracked.activityState = undefined;
				tracked.updatedAt = Date.now();
			}
		} catch {
			// best-effort: continue aborting remaining runs
		}
	}
	return {
		content: [{ type: "text", text: `Interrupt requested for ${ids.length} run(s): ${ids.join(", ")}.` }],
		details: { mode: "management", results: [] },
	};
}
function interruptAsyncRun(state: SubagentState, childRegistry: ChildAgentRegistry, runId: string | undefined): AgentToolResult<Details> | null {
	const target = getAsyncInterruptTarget(state, runId);
	if (!target) return null;
	const handle = childRegistry.get(target.asyncId);
	try {
		if (handle) {
			void handle.abort("interrupt requested");
			const tracked = state.asyncJobs.get(target.asyncId);
			if (tracked) {
				tracked.activityState = undefined;
				tracked.updatedAt = Date.now();
			}
			return {
				content: [{ type: "text", text: `Interrupt requested for run ${target.asyncId}.` }],
				details: { mode: "management", results: [] },
			};
		}
		const cascade = interruptRun(target.asyncId, { cascade: true });
		const abortedChildRunIds: string[] = [];
		for (const targetRunId of cascade.interruptedRunIds) {
			if (targetRunId === target.asyncId || !childRegistry.get(targetRunId)) continue;
			void childRegistry.abortRun(targetRunId, "interrupt requested");
			abortedChildRunIds.push(targetRunId);
			const tracked = state.asyncJobs.get(targetRunId);
			if (tracked) {
				tracked.activityState = undefined;
				tracked.updatedAt = Date.now();
			}
		}
		const tracked = state.asyncJobs.get(target.asyncId);
		if (tracked && abortedChildRunIds.length > 0) {
			tracked.activityState = undefined;
			tracked.updatedAt = Date.now();
		}
		if (abortedChildRunIds.length === 0) {
			return {
				content: [{ type: "text", text: `No running in-process run was found for '${runId ?? "current"}'.` }],
				isError: true,
				details: { mode: "management", results: [] },
			};
		}
		return {
			content: [{ type: "text", text: `Interrupt requested for run ${target.asyncId} (${abortedChildRunIds.length} descendant run(s): ${abortedChildRunIds.join(", ")}).` }],
			details: { mode: "management", results: [] },
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			content: [{ type: "text", text: `Failed to interrupt run ${target.asyncId}: ${message}` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
}
function parseChildRunId(id: string): { dispatchRunId: string; stepIndex?: number } {
	const match = id.match(/^(.*):(\d+)$/);
	if (!match) return { dispatchRunId: id };
	return { dispatchRunId: match[1]!, stepIndex: Number(match[2]) };
}
function isResumeTerminalStatus(status: unknown): boolean {
	return status === "complete" || status === "failed" || status === "interrupted" || status === "paused" || status === "lost";
}

export interface ResumeTarget {
	runId: string;
	sessionFile: string;
	runRecordDir: string;
	agentName: string;
	cwd: string;
	parentRunId?: string;
	rootRunId: string;
	startedAt: number;
	state: string;
	status: NonNullable<ReturnType<typeof readStatus>>;
	registryEntry: RunsRegistryEntry;
}

export function resolveResumeTarget(runId: string, stepIndex = 0): ResumeTarget {
	const entry = readAllEntries().find((candidate) => candidate.runId === runId);
	if (!entry) throw new Error(`Unknown runId '${runId}'.`);
	if (entry.mode === "parallel") throw new Error(`Run ${runId} is a parallel group; resume an individual child runId instead.`);
	const status = readStatus(entry.runRecordDir);
	if (!status) throw new Error(`No status.json found for runId '${runId}' at ${entry.runRecordDir}.`);
	const step = status.steps?.[stepIndex];
	// Prefer the targeted step's own session file: async chain status stores the run-level
	// `sessionFile` as step 0's file, so a non-zero stepIndex must read the per-step file first
	// or it would silently reopen step 0's session.
	const sessionFile = step?.sessionFile
		?? status.sessionFile
		?? path.join(entry.runRecordDir, `run-${stepIndex}`, "session.jsonl");
	if (!fs.existsSync(sessionFile)) throw new Error(`Session file for run ${runId} is missing at ${sessionFile}; cannot resume without the original session.`);
	const agentName = step?.agent ?? entry.agentName ?? entry.agentNames?.[stepIndex] ?? entry.agentNames?.[0] ?? "unknown";
	return {
		runId,
		sessionFile,
		runRecordDir: entry.runRecordDir,
		agentName,
		cwd: status.cwd ?? entry.cwd,
		...(status.parentRunId ?? entry.parentRunId ? { parentRunId: status.parentRunId ?? entry.parentRunId } : {}),
		rootRunId: entry.rootRunId ?? entry.runId,
		startedAt: status.startedAt ?? entry.startedAt,
		state: status.state,
		status,
		registryEntry: entry,
	};
}

export function assertCompleteResumeTarget(target: Pick<ResumeTarget, "runId" | "state">): void {
	if (target.state !== "complete") {
		throw new Error(`Run ${target.runId} is '${target.state}', not complete; disk resume currently supports only completed runs. Wait for it to complete or start a new run.`);
	}
}

const resumeInFlight = new Set<string>();

function postResumeMessage(handle: ChildAgentHandle, runId: string, message: string): AgentToolResult<Details> | null {
	try {
		const session = handle.session as unknown as {
			postUserMessage?: (message: string, options?: unknown) => unknown;
			enqueueTurn?: (message: string, options?: unknown) => unknown;
			prompt?: (message: string, options?: unknown) => unknown;
		};
		const post = session.postUserMessage ?? session.enqueueTurn ?? session.prompt;
		if (typeof post !== "function") return validationError(`Run ${runId} cannot accept resume messages.`);
		void Promise.resolve(post.call(session, message, { expandPromptTemplates: false, source: "extension" })).catch((error) => {
			logger.warn("resume action failed after dispatch", { runId, error: error instanceof Error ? error.message : String(error) });
		});
		return null;
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		return validationError(`Failed to resume run ${runId}: ${errorMessage}`);
	}
}

async function resumeRun(state: SubagentState, childRegistry: ChildAgentRegistry, runId: string, message: string, asyncMode: boolean | undefined, data: ExecutionContextData, deps: ExecutorDeps): Promise<AgentToolResult<Details>> {
	const parsed = parseChildRunId(runId);
	const tracked = state.asyncJobs.get(parsed.dispatchRunId);
	// Key the in-flight guard by the canonical target (dispatchRunId + step), not the raw caller
	// id, so aliases like `runId` and `runId:0` cannot bypass the guard and double-open the session.
	const resumeKey = `${parsed.dispatchRunId}:${parsed.stepIndex ?? 0}`;
	if (resumeInFlight.has(resumeKey)) return validationError(`Resume already in progress for run ${runId}.`);
	const handles = childRegistry.list().filter((handle) => handle.runId === parsed.dispatchRunId);
	if (parsed.stepIndex === undefined) {
		if ((tracked?.mode && tracked.mode !== "single") || handles.length > 1 || (handles.length === 1 && handles[0]!.stepIndex !== 0)) {
			return validationError("`id` must be a runId, not batchId");
		}
	} else if ((tracked?.mode && tracked.mode === "single") || (handles.length === 1 && handles[0]!.stepIndex === 0 && handles[0]!.runId === parsed.dispatchRunId)) {
		return validationError(`No resumable run found for '${runId}'.`);
	}
	const handle = parsed.stepIndex === undefined
		? handles[0]
		: handles.find((candidate) => candidate.stepIndex === parsed.stepIndex);
	if (handle) {
		const error = postResumeMessage(handle, runId, message);
		if (error) return error;
		if (tracked) {
			tracked.status = "running";
			tracked.activityState = undefined;
			tracked.updatedAt = Date.now();
		}
		return {
			content: [{ type: "text", text: `Resume message sent to run ${runId}.` }],
			details: { mode: "management", results: [] },
		};
	}
	let target: ResumeTarget;
	try {
		target = resolveResumeTarget(parsed.dispatchRunId, parsed.stepIndex ?? 0);
		assertCompleteResumeTarget(target);
	} catch (error) {
		const messageText = error instanceof Error ? error.message : String(error);
		return validationError(messageText);
	}
	const agentConfig = data.agents.find((agent) => agent.name === target.agentName) ?? data.agents[0];
	if (!agentConfig) return validationError(`No agent config available to resume run ${runId}.`);
	const built = buildAsyncChildStep({
		data: {
			...data,
			params: { ...data.params, sessionDir: undefined },
			effectiveCwd: target.cwd,
			runId: target.runId,
			rootRunId: target.rootRunId,
			forkReuse: undefined,
		},
		deps,
		agentConfig,
		task: message,
		stepIndex: parsed.stepIndex ?? 0,
		cwd: target.cwd,
		maxSubagentDepth: resolveCurrentMaxSubagentDepth(deps.config.maxSubagentDepth),
	});
	if ("error" in built) return built.error;
	const step: ChildAgentStep = {
		...built.step,
		runId: target.runId,
		stepIndex: parsed.stepIndex ?? 0,
		sessionFile: target.sessionFile,
		runRecordDir: target.runRecordDir,
		forkReuse: undefined,
		rootRunId: target.rootRunId,
	};
	const statusWriter = new StatusWriter({ runRecordDir: target.runRecordDir, runId: target.runId });
	// Resume reseeds the activity/heartbeat clocks to now so the inactivity
	// watchdog measures from the resume moment, not the original run's last
	// activity (startedAt stays immutable for duration semantics).
	const resumedAt = Date.now();
	const resumeCount = (target.status.resumeCount ?? 0) + 1;
	statusWriter.initialize({
		mode: target.status.mode,
		state: "running",
		startedAt: target.startedAt,
		lastActivityAt: resumedAt,
		runnerHeartbeatAt: resumedAt,
		resumedAt,
		resumeCount,
		cwd: target.cwd,
		...(target.parentRunId ? { parentRunId: target.parentRunId } : {}),
		currentStep: step.stepIndex,
		sessionFile: target.sessionFile,
		sessionDir: target.runRecordDir,
		steps: target.status.steps?.map((statusStep, index) => ({
			agent: statusStep.agent,
			...(statusStep.label ? { label: statusStep.label } : {}),
			status: index === step.stepIndex ? "running" : statusStep.status,
			startedAt: statusStep.startedAt ?? target.startedAt,
			...(index === step.stepIndex ? { lastActivityAt: resumedAt } : {}),
			sessionFile: statusStep.sessionFile ?? (index === step.stepIndex ? target.sessionFile : undefined),
			...(statusStep.live ? { live: statusStep.live } : {}),
		})) ?? [{ agent: target.agentName, status: "running", startedAt: target.startedAt, lastActivityAt: resumedAt, sessionFile: target.sessionFile }],
	});
	resumeInFlight.add(resumeKey);
	evictCompletionDedupeForRunId(target.runId);
	if (asyncMode === false) {
		const interruptController = new AbortController();
		const foregroundControl: ForegroundControlRef = {
			runId: target.runId,
			asyncDir: target.runRecordDir,
			...(target.parentRunId ? { parentRunId: target.parentRunId } : {}),
			mode: "single",
			startedAt: resumedAt,
			updatedAt: resumedAt,
			currentAgent: target.agentName,
			currentIndex: step.stepIndex,
			currentActivityState: undefined,
			interrupt: (reason?: string) => {
				if (interruptController.signal.aborted) return false;
				interruptController.abort(reason ?? "interrupt requested");
				foregroundControl.currentActivityState = undefined;
				foregroundControl.updatedAt = Date.now();
				return true;
			},
		};
		deps.state.foregroundControls.set(target.runId, foregroundControl);
		deps.state.lastForegroundControlId = target.runId;
		const resumeData: ExecutionContextData = {
			...data,
			params: { ...data.params, sessionDir: undefined },
			effectiveCwd: target.cwd,
			runId: target.runId,
			rootRunId: target.rootRunId,
			forkReuse: undefined,
		};
		const onControlEvent = createForegroundControlNotifier(resumeData, deps);
		const forwardUpdate = (update: AgentToolResult<Details>) => {
			const firstProgress = update.details?.progress?.[0];
			foregroundControl.currentAgent = target.agentName;
			foregroundControl.currentAgentColor = firstProgress?.color;
			foregroundControl.currentIndex = firstProgress?.index ?? step.stepIndex;
			foregroundControl.currentActivityState = firstProgress?.activityState;
			foregroundControl.lastActivityAt = firstProgress?.lastActivityAt;
			foregroundControl.currentTool = firstProgress?.currentTool;
			foregroundControl.currentToolStartedAt = firstProgress?.currentToolStartedAt;
			foregroundControl.phase = firstProgress?.phase;
			foregroundControl.phaseStartedAt = firstProgress?.phaseStartedAt;
			foregroundControl.lastToolEndAt = firstProgress?.lastToolEndAt;
			foregroundControl.recentTools = firstProgress?.recentTools;
			foregroundControl.recentOutput = firstProgress?.recentOutput;
			foregroundControl.finalOutput = update.details?.results?.[0]?.finalOutput;
			foregroundControl.updatedAt = Date.now();
			const statusStepPatch = target.status.steps?.map((_, index) => index === step.stepIndex
				? {
					agent: firstProgress?.agent ?? target.agentName,
					status: firstProgress?.status ?? "running",
					startedAt: target.status.steps?.[step.stepIndex]?.startedAt ?? target.startedAt,
					lastActivityAt: firstProgress?.lastActivityAt,
					currentTool: firstProgress?.currentTool,
					currentToolStartedAt: firstProgress?.currentToolStartedAt,
				}
				: {}) ?? [{
					agent: firstProgress?.agent ?? target.agentName,
					status: firstProgress?.status ?? "running",
					startedAt: target.startedAt,
					lastActivityAt: firstProgress?.lastActivityAt,
					currentTool: firstProgress?.currentTool,
					currentToolStartedAt: firstProgress?.currentToolStartedAt,
				}];
			writeSyncRunStatusUpdate(target.runId, {
				currentStep: firstProgress?.index ?? step.stepIndex,
				lastActivityAt: firstProgress?.lastActivityAt,
				currentTool: firstProgress?.currentTool,
				currentToolStartedAt: firstProgress?.currentToolStartedAt,
				phase: firstProgress?.phase,
				phaseStartedAt: firstProgress?.phaseStartedAt,
				steps: statusStepPatch as never,
			}, {}, target.runRecordDir);
			data.onUpdate?.(update);
		};
		const eventPayload = {
			runId: target.runId,
			agent: target.agentName,
			task: message,
			cwd: target.cwd,
			metadata: data.params.metadata,
		};
		let result: SingleResult | undefined;
		let failureMessage: string | undefined;
		try {
			emitSyncLifecycleEvent(deps.pi, SUBAGENT_SPAWN_STARTED_EVENT, eventPayload);
			result = await runInProcessChildStep({
				data: resumeData,
				deps,
				agentConfig,
				task: message,
				cleanTask: message,
				stepIndex: step.stepIndex,
				cwd: target.cwd,
				...(step.label ? { label: step.label } : {}),
				interruptSignal: interruptController.signal,
				maxSubagentDepth: step.maxSubagentDepth,
				onUpdate: forwardUpdate,
				onControlEvent: (event) => {
					if (!interruptForegroundOnNeedsAttention(event, interruptController, foregroundControl)) {
						onControlEvent(event);
					}
				},
				layer0: { runId: target.runId, runRecordDir: target.runRecordDir, sessionFile: target.sessionFile, rootRunId: target.rootRunId },
			});
			emitSyncLifecycleEvent(deps.pi, result.exitCode === 0 ? SUBAGENT_COMPLETED_EVENT : SUBAGENT_FAILED_EVENT, {
				...eventPayload,
				exitCode: result.exitCode,
				error: result.error,
			});
			return {
				content: [{ type: "text", text: `Resume completed for run ${runId}.` }],
				details: { mode: "management", results: [] },
			};
		} catch (error) {
			failureMessage = error instanceof Error ? error.message : String(error);
			emitSyncLifecycleEvent(deps.pi, SUBAGENT_FAILED_EVENT, { ...eventPayload, exitCode: 1, error: failureMessage });
			return validationError(`Failed to resume run ${runId}: ${failureMessage}`);
		} finally {
			writeSyncRunStatusEnd(target.runId, {
				state: result?.exitCode === 0 && !failureMessage ? "complete" : "failed",
				// Only the resumed step is finalized; siblings echo their existing
				// fields so writeSyncRunStatusEnd's force-overrides become no-ops
				// (a patchless `{}` would flip siblings to the run-level end state).
				steps: target.status.steps?.map((existingStep, index) => index === step.stepIndex
					? {
						status: result?.exitCode === 0 && !failureMessage ? "complete" : "failed",
						tokens: result ? tokenUsageFromResult(result) : undefined,
						durationMs: result?.progressSummary?.durationMs,
						error: result?.error ?? failureMessage,
					}
					: existingStep) ?? [{
					status: result?.exitCode === 0 && !failureMessage ? "complete" : "failed",
					tokens: result ? tokenUsageFromResult(result) : undefined,
					durationMs: result?.progressSummary?.durationMs,
					error: result?.error ?? failureMessage,
				}],
				sessionFile: result?.sessionFile ?? target.sessionFile,
			}, target.runRecordDir);
			statusWriter.dispose();
			deps.state.foregroundControls.delete(target.runId);
			if (deps.state.lastForegroundControlId === target.runId) deps.state.lastForegroundControlId = null;
			resumeInFlight.delete(resumeKey);
		}
	}
	const detachedAbort = new AbortController();
	const asyncCtx = {
		extensionCtx: data.ctx,
		abortSignal: detachedAbort.signal,
		onStatusUpdate: (patch: Parameters<StatusWriter["enqueue"]>[0]) => statusWriter.enqueue(patch),
		registry: deps.childRegistry,
		pi: deps.pi,
	};
	const childHandle = dispatchAsyncChild(step, asyncCtx);
	const finalize = async () => {
		let result: ChildAgentResult | undefined;
		try {
			result = await childHandle.completed;
			await statusWriter.finalize(result);
			safeEmit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
				id: target.runId,
				runId: target.runId,
				...(target.parentRunId ? { parentRunId: target.parentRunId } : {}),
				rootRunId: target.rootRunId,
				notifyPolicy: "each",
				success: result.state === "complete",
				agent: target.agentName,
				summary: result.outputText,
				exitCode: result.exitCode,
				state: result.state,
				durationMs: result.durationMs,
				sessionFile: result.sessionFile,
				timestamp: Date.now(),
				result,
				asyncDir: target.runRecordDir,
			});
		} finally {
			statusWriter.dispose();
			resumeInFlight.delete(resumeKey);
		}
		return result;
	};
	const completed = finalize();
	safeEmit(SUBAGENT_ASYNC_STARTED_EVENT, {
		id: target.runId,
		runId: target.runId,
		agent: target.agentName,
		task: message.slice(0, 50),
		cwd: target.cwd,
		asyncDir: target.runRecordDir,
		...(target.parentRunId ? { parentRunId: target.parentRunId } : {}),
	});
	void completed.catch((error) => logger.warn("disk resume failed after dispatch", { runId, error: error instanceof Error ? error.message : String(error) }));
	return asyncStartedResult({ mode: "single", runId: target.runId, asyncDir: target.runRecordDir, text: `Async resume: ${target.agentName} [${target.runId}]` });
}
function createForegroundControlNotifier(data: Pick<ExecutionContextData, "controlConfig" | "intercomBridge">, deps: Pick<ExecutorDeps, "pi">): (event: ControlEvent) => void {
	return (event) => emitControlNotification({
		pi: deps.pi,
		controlConfig: data.controlConfig,
		intercomBridge: data.intercomBridge,
		event,
	});
}
type ForegroundControlRef = SubagentState["foregroundControls"] extends Map<string, infer T> ? T : never;
function interruptForegroundOnNeedsAttention(
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
function validateExecutionInput(
	params: InternalSubagentParams,
	agents: AgentConfig[],
	hasChain: boolean,
	hasTasks: boolean,
	hasSingle: boolean,
	allowClarifyTaskPrompt: boolean,
): AgentToolResult<Details> | null {
	if (Number(hasChain) + Number(hasTasks) + Number(hasSingle) !== 1) {
		return {
			content: [
				{
					type: "text",
					text: `Provide exactly one mode. Agents: ${agents.map((a) => a.name).join(", ") || "none"}`,
				},
			],
			isError: true,
			details: { mode: "single" as const, results: [] },
		};
	}
	if (hasChain && params.chain) {
		if (params.chain.length === 0) {
			return {
				content: [{ type: "text", text: "Chain must have at least one step" }],
				isError: true,
				details: { mode: "chain" as const, results: [] },
			};
		}
		const firstStep = params.chain[0] as ChainStep;
		if (isParallelStep(firstStep)) {
			const missingTaskIndex = firstStep.parallel.findIndex((t) => !t.task);
			if (missingTaskIndex !== -1) {
				return {
					content: [{ type: "text", text: `First parallel step: task ${missingTaskIndex + 1} must have a task (no previous output to reference)` }],
					isError: true,
					details: { mode: "chain" as const, results: [] },
				};
			}
		} else if (!(firstStep as SequentialStep).task && !params.task && !allowClarifyTaskPrompt) {
			return {
				content: [{ type: "text", text: "First step in chain must have a task" }],
				isError: true,
				details: { mode: "chain" as const, results: [] },
			};
		}
		for (let i = 0; i < params.chain.length; i++) {
			const step = params.chain[i] as ChainStep;
			const stepAgents = getStepAgents(step);
			for (const agentName of stepAgents) {
				if (!agents.find((a) => a.name === agentName)) {
					return {
						content: [{ type: "text", text: `Unknown agent: ${agentName} (step ${i + 1})` }],
						isError: true,
						details: { mode: "chain" as const, results: [] },
					};
				}
			}
			if (isParallelStep(step) && step.parallel.length === 0) {
				return {
					content: [{ type: "text", text: `Parallel step ${i + 1} must have at least one task` }],
					isError: true,
					details: { mode: "chain" as const, results: [] },
				};
			}
			if (isParallelStep(step) && step.prompt) {
				const count = (step.prompt.match(/\{in\}/g) ?? []).length;
				if (count > 1) {
					return {
						content: [{ type: "text", text: `Parallel step ${i + 1} prompt contains ${count} occurrences of {in}; only one is allowed.` }],
						isError: true,
						details: { mode: "chain" as const, results: [] },
					};
				}
			}
		}
	}
	return null;
}
function getRequestedModeLabel(params: InternalSubagentParams): Details["mode"] {
	if ((params.chain?.length ?? 0) > 0) return "chain";
	if ((params.tasks?.length ?? 0) > 0) return "parallel";
	if (params.agent) return "single";
	return "single";
}
function buildRequestedModeError(params: InternalSubagentParams, message: string): AgentToolResult<Details> {
	return withForkContext(
		{
			content: [{ type: "text", text: message }],
			isError: true,
			details: { mode: getRequestedModeLabel(params), results: [] },
		},
		params.context,
	);
}
function collectRequestedAgentNames(params: InternalSubagentParams): string[] {
	if ((params.tasks?.length ?? 0) > 0) {
		return params.tasks!
			.map((task) => typeof task === "object" && task && !Array.isArray(task) ? normalizeName(task.agent) : undefined)
			.filter((agent): agent is string => Boolean(agent));
	}
	if ((params.chain?.length ?? 0) > 0) return params.chain!.flatMap((step) => getStepAgents(step as ChainStep));
	if (params.agent) return [params.agent];
	return [];
}
function normalizeName(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed || undefined;
}
function collectForkOverridePaths(params: InternalSubagentParams): string[] {
	const paths: string[] = [];
	if (params.clarify === true) paths.push("clarify");
	if (params.model !== undefined) paths.push("model");
	if (params.skill !== undefined) paths.push("skill");
	for (let i = 0; i < (params.tasks?.length ?? 0); i++) {
		const task = params.tasks![i]!;
		if (typeof task !== "object" || !task || Array.isArray(task)) continue;
		if (task.model !== undefined) paths.push(`tasks[${i}].model`);
		if (task.skill !== undefined) paths.push(`tasks[${i}].skill`);
	}
	for (let i = 0; i < (params.chain?.length ?? 0); i++) {
		const step = params.chain![i]!;
		if (isParallelStep(step)) {
			for (let j = 0; j < step.parallel.length; j++) {
				const task = step.parallel[j]!;
				if (task.model !== undefined) paths.push(`chain[${i}].parallel[${j}].model`);
				if (task.skill !== undefined) paths.push(`chain[${i}].parallel[${j}].skill`);
			}
			continue;
		}
		const sequential = step as SequentialStep & { model?: unknown; skill?: unknown };
		if (sequential.model !== undefined) paths.push(`chain[${i}].model`);
		if (sequential.skill !== undefined) paths.push(`chain[${i}].skill`);
	}
	return paths;
}
function resolveForkReuse(
	params: InternalSubagentParams,
	ctx: ExtensionContext,
	deps: ExecutorDeps,
): ForkReuseConfig | undefined {
	if (params.context !== "fork") return undefined;
	const requestedAgents = collectRequestedAgentNames(params);
	// Identity resolution order:
	//   1. PI_SUBAGENT_CURRENT_AGENT env (set for child agents by the executor)
	//   2. Active root role / preset stored by index.ts (e.g. picked via /role or auto-activated at startup)
	//   3. Single requested agent (root self-fork: "fork as main" implies parent IS main)
	const uniqueRequested = [...new Set(requestedAgents)];
	const currentAgentName = normalizeName(process.env.PI_SUBAGENT_CURRENT_AGENT)
		?? normalizeName(deps.getActiveRootRoleName?.())
		?? (uniqueRequested.length === 1 ? normalizeName(uniqueRequested[0]) : undefined);
	if (!currentAgentName) {
		throw new Error("Fork context requires a known current agent identity.");
	}
	const mismatchedAgents = uniqueRequested.filter((name) => name !== currentAgentName);
	if (mismatchedAgents.length > 0) {
		throw new Error(
			`Fork context only allows the current agent '${currentAgentName}' to fork itself. ` +
			`Requested: ${mismatchedAgents.join(", ")}`,
		);
	}
	const overridePaths = collectForkOverridePaths(params);
	if (overridePaths.length > 0) {
		throw new Error(
			`Fork context requires same-agent execution without prompt/model/skill overrides. Unsupported overrides: ${overridePaths.join(", ")}`,
		);
	}
	const currentSessionId = ctx.sessionManager.getSessionId() ?? deps.state.currentSessionId;
	if (!currentSessionId) {
		throw new Error("Fork context requires a known current session id.");
	}
	return {
		agentName: currentAgentName,
		sessionId: currentSessionId,
	};
}
function expandTopLevelTaskCounts(tasks: TaskParam[]): { tasks?: TaskParam[]; error?: string } {
	const expanded: TaskParam[] = [];
	for (let taskIndex = 0; taskIndex < tasks.length; taskIndex++) {
		const task = tasks[taskIndex]!;
		const rawCount = (task as TaskParam & { count?: unknown }).count;
		if (rawCount !== undefined && (typeof rawCount !== "number" || !Number.isInteger(rawCount) || rawCount < 1)) {
			return { error: `tasks[${taskIndex}].count must be an integer >= 1` };
		}
		const { count, ...concreteTask } = task;
		for (let repeat = 0; repeat < (rawCount ?? 1); repeat++) {
			expanded.push({ ...concreteTask });
		}
	}
	return { tasks: expanded };
}
function expandChainParallelCounts(chain: ChainStep[]): { chain?: ChainStep[]; error?: string } {
	const expandedChain: ChainStep[] = [];
	for (let stepIndex = 0; stepIndex < chain.length; stepIndex++) {
		const step = chain[stepIndex]!;
		if (!isParallelStep(step)) {
			expandedChain.push(step);
			continue;
		}
		const expandedParallel = [];
		for (let taskIndex = 0; taskIndex < step.parallel.length; taskIndex++) {
			const task = step.parallel[taskIndex]!;
			const rawCount = (task as typeof task & { count?: unknown }).count;
			if (rawCount !== undefined && (typeof rawCount !== "number" || !Number.isInteger(rawCount) || rawCount < 1)) {
				return { error: `chain[${stepIndex}].parallel[${taskIndex}].count must be an integer >= 1` };
			}
			const { count, ...concreteTask } = task;
			for (let repeat = 0; repeat < (rawCount ?? 1); repeat++) {
				expandedParallel.push({ ...concreteTask });
			}
		}
		expandedChain.push({ ...step, parallel: expandedParallel });
	}
	return { chain: expandedChain };
}
function normalizeRepeatedParallelCounts(params: InternalSubagentParams): { params?: InternalSubagentParams; error?: AgentToolResult<Details> } {
	if (params.tasks) {
		const expandedTasks = expandTopLevelTaskCounts(params.tasks);
		if (expandedTasks.error) {
			return { error: buildRequestedModeError(params, expandedTasks.error) };
		}
		return { params: { ...params, tasks: expandedTasks.tasks } };
	}
	if (params.chain) {
		const expandedChain = expandChainParallelCounts(params.chain);
		if (expandedChain.error) {
			return { error: buildRequestedModeError(params, expandedChain.error) };
		}
		return { params: { ...params, chain: expandedChain.chain } };
	}
	return { params };
}
function withForkContext(
	result: AgentToolResult<Details>,
	context: InternalSubagentParams["context"],
): AgentToolResult<Details> {
	if (context !== "fork" || !result.details) return result;
	return {
		...result,
		details: {
			...result.details,
			context: "fork",
		},
	};
}
function toExecutionErrorResult(params: InternalSubagentParams, error: unknown): AgentToolResult<Details> {
	const message = error instanceof Error ? error.message : String(error);
	return withForkContext(
		{
			content: [{ type: "text", text: message }],
			isError: true,
			details: { mode: getRequestedModeLabel(params), results: [] },
		},
		params.context,
	);
}
function collectChainSessionFiles(
	chain: ChainStep[],
	sessionFileForIndex: (idx?: number) => string | undefined,
): (string | undefined)[] {
	const sessionFiles: (string | undefined)[] = [];
	let flatIndex = 0;
	for (const step of chain) {
		if (isParallelStep(step)) {
			for (let i = 0; i < step.parallel.length; i++) {
				sessionFiles.push(sessionFileForIndex(flatIndex));
				flatIndex++;
			}
			continue;
		}
		sessionFiles.push(sessionFileForIndex(flatIndex));
		flatIndex++;
	}
	return sessionFiles;
}

function wrapChainTasksForFork(chain: ChainStep[], context: InternalSubagentParams["context"]): ChainStep[] {
	if (context !== "fork") return chain;
	return chain.map((step, stepIndex) => {
		if (isParallelStep(step)) {
			return {
				...step,
				parallel: step.parallel.map((task) => ({
					...task,
					task: wrapForkTask(task.task ?? "{previous}"),
				})),
			};
		}
		const sequential = step as SequentialStep;
		return {
			...sequential,
			task: wrapForkTask(sequential.task ?? (stepIndex === 0 ? "{task}" : "{previous}")),
		};
	});
}

interface AsyncDispatchStep {
	step: ChildAgentStep;
	cleanTask: string;
	agentConfig: AgentConfig;
}

interface AsyncChainStepGroup {
	items: AsyncDispatchStep[];
	concurrency: number;
}

function buildAsyncChildStep(input: {
	data: ExecutionContextData;
	deps: ExecutorDeps;
	agentConfig: AgentConfig;
	task: string;
	stepIndex: number;
	cwd: string;
	label?: string;
	modelOverride?: string;
	skills?: string[] | false;
	output?: string | false;
	maxSubagentDepth: number;
	chainSkills?: string[];
}): AsyncDispatchStep | { error: AgentToolResult<Details> } {
	const { data, deps, agentConfig, stepIndex } = input;
	const availableModels = data.ctx.modelRegistry.getAvailable();
	const modelRefs = buildModelCandidates(
		input.modelOverride ?? agentConfig.model,
		agentConfig.fallbackModels,
		availableModels.map((model) => ({ provider: model.provider, id: model.id, fullId: `${model.provider}/${model.id}` })),
		data.ctx.model?.provider,
	);
	const primaryModelRef = applyThinkingSuffix(modelRefs[0], agentConfig.thinking);
	const parsedPrimary = splitModelThinking(primaryModelRef, agentConfig.thinking);
	const primaryModel = resolveModelFromRef(parsedPrimary.modelRef, availableModels, data.ctx.model);
	if (!primaryModel) {
		return {
			error: {
				content: [{ type: "text", text: "No model available for child agent." }],
				isError: true,
				details: { mode: getRequestedModeLabel(data.params), results: [] },
			},
		};
	}
	const modelCandidates = modelRefs.slice(1)
		.map((ref) => resolveModelFromRef(splitModelThinking(applyThinkingSuffix(ref, agentConfig.thinking), agentConfig.thinking).modelRef, availableModels, undefined))
		.filter((model): model is Model<any> => Boolean(model));
	const rawSkills = input.skills !== undefined ? input.skills : resolveStepBehavior(agentConfig, { skills: undefined }, input.chainSkills).skills;
	const skillNames = data.forkReuse || rawSkills === false ? [] : (rawSkills ?? agentConfig.skills ?? []);
	const { resolved: resolvedSkills } = data.forkReuse
		? { resolved: [] }
		: resolveSkillsWithFallback(skillNames, input.cwd, data.ctx.cwd);
	const skillInjection = buildSkillInjection(resolvedSkills);
	const systemPromptBase = data.forkReuse ? "" : agentConfig.systemPrompt?.trim() || "";
	const systemPrompt = skillInjection ? (systemPromptBase ? `${systemPromptBase}\n\n${skillInjection}` : skillInjection) : systemPromptBase;
	const outputPath = resolveSingleOutputPath(input.output, data.ctx.cwd, input.cwd);
	const cleanTask = input.task;
	const task = injectSubmitResultInstruction(injectSingleOutputInstruction(cleanTask, outputPath));
	const sessionPaths = resolveChildSessionFile({
		parentCwd: data.effectiveCwd,
		parentSessionFile: data.ctx.sessionManager.getSessionFile() ?? null,
		runId: data.runId,
		stepIndex,
		...(data.params.sessionDir ? { sessionDirOverride: path.resolve(deps.expandTilde(data.params.sessionDir)) } : {}),
		...(deps.config.defaultSessionDir ? { defaultSessionDir: path.resolve(deps.expandTilde(deps.config.defaultSessionDir)) } : {}),
		...(data.forkReuse ? { forkContextFile: data.sessionFileForIndex(stepIndex) } : {}),
	});
	const { activeToolNames, customTools } = resolveChildTools(agentConfig, deps.pi);
	const step: ChildAgentStep = {
		runId: data.runId,
		stepIndex,
		agentName: agentConfig.name,
		agentConfig: agentConfig as unknown as ChildAgentStep["agentConfig"],
		task,
		cwd: input.cwd,
		model: primaryModel,
		modelCandidates,
		thinkingLevel: parsedPrimary.thinkingLevel,
		activeToolNames,
		customTools,
		systemPrompt,
		skillsResolved: resolvedSkills.map((skill) => skill.name),
		sessionFile: sessionPaths.sessionFile,
		runRecordDir: sessionPaths.runRecordDir,
		...(data.forkReuse && data.sessionFileForIndex(stepIndex) ? { forkReuse: { sessionFile: data.sessionFileForIndex(stepIndex)!, agentName: data.forkReuse.agentName } } : {}),
		...(data.intercomBridge.active ? { intercom: { selfTarget: resolveSubagentIntercomTarget(data.runId, agentConfig.name, stepIndex), bridgeTarget: data.intercomBridge.orchestratorTarget } } : {}),
		...(data.artifactConfig.enabled ? { artifactsDir: data.artifactsDir } : {}),
		...(input.label ? { label: input.label } : {}),
		parentAgentName: data.forkReuse?.agentName ?? process.env.PI_SUBAGENT_CURRENT_AGENT,
		parentSessionId: data.forkReuse?.sessionId ?? data.ctx.sessionManager.getSessionId() ?? deps.state.currentSessionId ?? undefined,
		rootSessionId: resolveDispatchRootSessionId(data.ctx, deps.state.currentSessionId ?? undefined),
		rootRunId: data.rootRunId,
		maxSubagentDepth: input.maxSubagentDepth,
		...(data.params.preset ? { preset: data.params.preset } : {}),
		shareEnabled: data.shareEnabled,
		controlConfig: data.controlConfig,
		...(outputPath ? { outputPath } : {}),
	};
	return { step, cleanTask, agentConfig };
}

function asyncStartedResult(input: {
	mode: "single" | "chain" | "parallel";
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

function childCompletionRunId(dispatchRunId: string, stepIndex: number, total: number): string {
	return total > 1 ? `${dispatchRunId}:${stepIndex}` : dispatchRunId;
}

function runAsyncPath(data: ExecutionContextData, deps: ExecutorDeps): AgentToolResult<Details> | null {
	const { params, effectiveCwd, agents, ctx, effectiveAsync, controlConfig } = data;
	const hasChain = (params.chain?.length ?? 0) > 0;
	const hasTasks = (params.tasks?.length ?? 0) > 0;
	const hasSingle = !hasChain && !hasTasks && Boolean(params.agent);
	if (!effectiveAsync) return null;

	if (hasChain && params.chain) {
		const chainWorktreeTaskCwdError = buildChainWorktreeTaskCwdError(params.chain as ChainStep[], effectiveCwd);
		if (chainWorktreeTaskCwdError) {
			return { content: [{ type: "text", text: chainWorktreeTaskCwdError }], isError: true, details: { mode: "chain" as const, results: [] } };
		}
	}
	if (hasTasks && params.tasks) {
		const tasks = params.tasks as TaskParam[];
		const maxParallelTasks = resolveTopLevelParallelMaxTasks(deps.config.parallel?.maxTasks);
		if (tasks.length > maxParallelTasks) return buildParallelModeError(`Max ${maxParallelTasks} tasks`);
		if (params.worktree) {
			const worktreeTaskCwdError = buildParallelWorktreeTaskCwdError(tasks, effectiveCwd);
			if (worktreeTaskCwdError) return buildParallelModeError(worktreeTaskCwdError);
		}
	}

	const runId = data.runId;
	const availableModels: ModelInfo[] = ctx.modelRegistry.getAvailable().map((m) => ({ provider: m.provider, id: m.id, fullId: `${m.provider}/${m.id}` }));
	const currentProvider = ctx.model?.provider;
	const currentMaxSubagentDepth = resolveCurrentMaxSubagentDepth(deps.config.maxSubagentDepth);
	const parentRunId = resolveDispatchParentRunId(ctx);
	const rootRunId = resolveDispatchRootRunId(ctx, runId);
	const steps: AsyncDispatchStep[] = [];
	const chainGroups: AsyncChainStepGroup[] = [];
	let mode: "single" | "chain" | "parallel" = "single";
	let runLabel = params.label;

	if (hasSingle) {
		const agentConfig = agents.find((x) => x.name === params.agent);
		if (!agentConfig) return { content: [{ type: "text", text: `Unknown agent: ${params.agent}` }], isError: true, details: { mode: "single" as const, results: [] } };
		const normalizedSkills = normalizeSkillInput(params.skill);
		const rawOutput = params.output !== undefined ? params.output : agentConfig.output;
		const built = buildAsyncChildStep({
			data,
			deps,
			agentConfig,
			task: params.context === "fork" ? wrapForkTask(params.task ?? "") : (params.task ?? ""),
			stepIndex: 0,
			cwd: effectiveCwd,
			...(params.label ? { label: params.label } : {}),
			modelOverride: resolveModelCandidate((params.model as string | undefined) ?? agentConfig.model, availableModels, currentProvider),
			skills: normalizedSkills === false ? false : normalizedSkills,
			output: rawOutput === true ? agentConfig.output : (rawOutput as string | false | undefined),
			maxSubagentDepth: resolveChildMaxSubagentDepth(currentMaxSubagentDepth, agentConfig.maxSubagentDepth),
		});
		if ("error" in built) return built.error;
		steps.push(built);
		runLabel ??= params.label;
	} else if (hasTasks && params.tasks) {
		mode = "parallel";
		const tasks = params.tasks as TaskParam[];
		for (let index = 0; index < tasks.length; index++) {
			const task = tasks[index]!;
			const agentConfig = agents.find((agent) => agent.name === task.agent);
			if (!agentConfig) return { content: [{ type: "text", text: `Unknown agent: ${task.agent}` }], isError: true, details: { mode: "parallel" as const, results: [] } };
			const skillOverride = normalizeSkillInput(task.skill);
			const built = buildAsyncChildStep({
				data,
				deps,
				agentConfig,
				task: params.context === "fork" ? wrapForkTask(task.task) : task.task,
				stepIndex: index,
				cwd: resolveChildCwd(effectiveCwd, task.cwd),
				...(task.label ? { label: task.label } : {}),
				modelOverride: resolveModelCandidate(task.model ?? agentConfig.model, availableModels, currentProvider),
				skills: skillOverride === false ? false : skillOverride,
				maxSubagentDepth: resolveChildMaxSubagentDepth(currentMaxSubagentDepth, agentConfig.maxSubagentDepth),
			});
			if ("error" in built) return built.error;
			steps.push(built);
		}
	} else if (hasChain && params.chain) {
		mode = "chain";
		const normalized = normalizeSkillInput(params.skill);
		const chainSkills = normalized === false ? [] : (normalized ?? []);
		let flatIndex = 0;
		for (const chainStep of wrapChainTasksForFork(params.chain as ChainStep[], params.context)) {
			if (isParallelStep(chainStep)) {
				const group: AsyncDispatchStep[] = [];
				for (const task of chainStep.parallel) {
					const agentConfig = agents.find((agent) => agent.name === task.agent);
					if (!agentConfig) return { content: [{ type: "text", text: `Unknown agent: ${task.agent}` }], isError: true, details: { mode: "chain" as const, results: [] } };
					const skillOverride = normalizeSkillInput(task.skill);
					const built = buildAsyncChildStep({
						data,
						deps,
						agentConfig,
						task: task.task ?? "{previous}",
						stepIndex: flatIndex++,
						cwd: resolveChildCwd(effectiveCwd, task.cwd),
						...(task.label ? { label: task.label } : {}),
						modelOverride: resolveModelCandidate(task.model ?? agentConfig.model, availableModels, currentProvider),
						skills: skillOverride === false ? false : skillOverride,
						maxSubagentDepth: resolveChildMaxSubagentDepth(currentMaxSubagentDepth, agentConfig.maxSubagentDepth),
						chainSkills,
					});
					if ("error" in built) return built.error;
					steps.push(built);
					group.push(built);
				}
				chainGroups.push({ items: group, concurrency: chainStep.concurrency ?? group.length });
				continue;
			}
			const sequential = chainStep as SequentialStep;
			const agentConfig = agents.find((agent) => agent.name === sequential.agent);
			if (!agentConfig) return { content: [{ type: "text", text: `Unknown agent: ${sequential.agent}` }], isError: true, details: { mode: "chain" as const, results: [] } };
			const skillOverride = normalizeSkillInput(sequential.skill);
			const built = buildAsyncChildStep({
				data,
				deps,
				agentConfig,
				task: sequential.task ?? (flatIndex === 0 ? (params.task ?? "") : "{previous}"),
				stepIndex: flatIndex++,
				cwd: resolveChildCwd(effectiveCwd, sequential.cwd),
				...(sequential.label ? { label: sequential.label } : {}),
				modelOverride: resolveModelCandidate(sequential.model ?? agentConfig.model, availableModels, currentProvider),
				skills: skillOverride === false ? false : skillOverride,
				maxSubagentDepth: resolveChildMaxSubagentDepth(currentMaxSubagentDepth, agentConfig.maxSubagentDepth),
				chainSkills,
			});
			if ("error" in built) return built.error;
			steps.push(built);
			chainGroups.push({ items: [built], concurrency: 1 });
		}
	}

	const first = steps[0];
	if (!first) return null;
	if (mode === "parallel" && hasTasks) {
		const rootSessionId = resolveDispatchRootSessionId(ctx);
		const parentSessionId = ctx.sessionManager?.getSessionId?.();
		const notifyPolicy = batchToNotifyPolicy(params.batch);
		const group = openGroup({
			cwd: effectiveCwd,
			...(rootRunId !== runId ? { rootRunId } : {}),
			notifyPolicy,
			...(runLabel ? { label: runLabel } : {}),
			...(parentRunId ? { parentRunId } : {}),
			...(params.sessionDir ? { sessionDir: path.resolve(deps.expandTilde(params.sessionDir)) } : {}),
			...(deps.config.defaultSessionDir ? { defaultSessionDir: path.resolve(deps.expandTilde(deps.config.defaultSessionDir)) } : {}),
			parentSessionFile: ctx.sessionManager.getSessionFile() ?? null,
			...(parentSessionId ? { parentSessionId } : {}),
			...(rootSessionId ? { rootSessionId } : {}),
			source: "async",
			mode: "parallel",
		});
		const groupRunId = group.runId;
		const groupRootRunId = rootRunId === runId ? groupRunId : rootRunId;
		const asyncDetachedAbort = new AbortController();
		const childRuns = steps.map((item, originalStepIndex) => {
			const handle = spawnRun({
				agentName: item.step.agentName,
				task: item.step.task,
				cwd: item.step.cwd,
				...(item.step.label ? { label: item.step.label } : {}),
			}, {
				parentRunId: groupRunId,
				rootRunId: groupRootRunId,
				notifyPolicy: "each",
				parentSessionFile: ctx.sessionManager.getSessionFile() ?? null,
				...(params.sessionDir ? { sessionDir: path.resolve(deps.expandTilde(params.sessionDir)) } : {}),
				...(deps.config.defaultSessionDir ? { defaultSessionDir: path.resolve(deps.expandTilde(deps.config.defaultSessionDir)) } : {}),
				...(rootSessionId ? { rootSessionId } : {}),
				...(parentSessionId ? { parentSessionId } : {}),
				source: "async",
				runAgent: async (prepared, layer0Ctx) => {
					const childStep: ChildAgentStep = {
						...item.step,
						runId: prepared.runId,
						stepIndex: 0,
						runRecordDir: prepared.runRecordDir,
						sessionFile: prepared.sessionFile,
						rootRunId: groupRootRunId,
					};
					const childHandle = dispatchAsyncChild(childStep, {
						extensionCtx: ctx,
						abortSignal: asyncDetachedAbort.signal,
						onStatusUpdate: (patch) => layer0Ctx.statusWriter.enqueue({ ...patch, stepIndex: 0 }),
						registry: deps.childRegistry,
						pi: deps.pi,
					});
					return childHandle.completed;
				},
				onLifecycle: (event) => {
					if (event.type === "run.started") {
						safeEmit(SUBAGENT_ASYNC_STARTED_EVENT, {
							id: event.runId,
							runId: event.runId,
							metadata: params.metadata,
							controlConfig,
							agent: item.step.agentName,
							task: item.cleanTask.slice(0, 50),
							cwd: item.step.cwd,
							asyncDir: event.runRecordDir,
							parentRunId: groupRunId,
						});
						return;
					}
					const result = event.result;
					safeEmit(SUBAGENT_ASYNC_RUN_COMPLETE_EVENT, {
						id: event.runId,
						runId: event.runId,
						parentRunId: groupRunId,
						rootRunId: groupRootRunId,
						metadata: params.metadata,
						notifyPolicy,
						agent: item.step.agentName,
						...(item.step.label ? { label: item.step.label } : {}),
						success: result ? result.state === "complete" : false,
						summary: result?.outputText ?? (event.error ? String(event.error) : ""),
						exitCode: result?.exitCode,
						state: result?.state ?? "failed",
						durationMs: result?.durationMs,
						sessionFile: result?.sessionFile ?? event.sessionFile,
						timestamp: event.timestamp,
						taskIndex: originalStepIndex,
						totalTasks: steps.length,
						asyncDir: event.runRecordDir,
					});
				},
			});
			return { item, originalStepIndex, handle };
		});

		void (async () => {
			logger.info("finalizeAsync: awaiting layer0 parallel handles", { runId: groupRunId });
			try {
				const settled = await Promise.allSettled(childRuns.map((child) => child.handle.completed));
				const results = settled.flatMap((entry) => entry.status === "fulfilled" ? [entry.value] : []);
				const finalResult = results.find((result) => result.state !== "complete") ?? results.at(-1);
				const totalUsage: Usage = emptyUsage();
				for (const entry of settled) {
					if (entry.status !== "fulfilled") continue;
					if (entry.value.usage) addUsageInto(totalUsage, entry.value.usage as Usage);
				}
				const childResults = childRuns
					.flatMap((child, index) => {
						const entry = settled[index];
						if (entry?.status !== "fulfilled") return [];
						const r = entry.value;
						return [{
							id: child.handle.runId,
							runId: child.handle.runId,
							dispatchRunId: groupRunId,
							...(params.batch === true ? { batchId: groupRunId } : {}),
							stepIndex: child.originalStepIndex,
							agent: child.item.step.agentName,
							...(child.item.step.label ? { label: child.item.step.label } : {}),
							state: r.state,
							success: r.state === "complete",
							exitCode: r.exitCode,
							output: r.outputText ?? "",
							summary: r.outputText ?? "",
							durationMs: r.durationMs,
							sessionFile: r.sessionFile,
						}];
					})
					.sort((a, b) => a.stepIndex - b.stepIndex);
				safeEmit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
					id: groupRunId,
					runId: groupRunId,
					...(parentRunId ? { parentRunId } : {}),
					rootRunId: groupRootRunId,
					notifyPolicy,
					success: finalResult?.state === "complete",
					agent: steps.map(({ step }) => step.agentName).join(","),
					summary: finalResult?.outputText ?? "",
					exitCode: finalResult?.exitCode,
					state: finalResult?.state,
					durationMs: finalResult?.durationMs,
					sessionFile: finalResult?.sessionFile,
					shareUrl: finalResult?.shareUrl,
					timestamp: Date.now(),
					result: finalResult,
					results: childResults,
					children: childResults,
					batch: params.batch === true,
					...(params.batch === true ? { batchId: groupRunId } : {}),
					total: childResults.length,
					completed: childResults.filter((child) => child.state === "complete").length,
					totalUsage,
					asyncDir: group.runRecordDir,
					metadata: params.metadata,
				});
			} catch (err) {
				logger.error("finalizeAsync: layer0 parallel threw", err instanceof Error ? err : new Error(String(err)), { runId: groupRunId });
			} finally {
				deps.childRegistry.delete(groupRunId);
			}
		})();

		const childDetails = childRuns.map((child) => ({
			runId: child.handle.runId,
			agent: child.item.step.agentName,
			...(child.item.step.label ? { label: child.item.step.label } : {}),
			stepIndex: child.originalStepIndex,
		}));
		const childLines = childDetails.map((child) => {
			const label = child.label ? ` · ${child.label}` : "";
			return `- ${child.agent}${label}: ${child.runId}`;
		});
		const handleText = [
			"Async parallel children:",
			...childLines,
			`Group handle: ${formatRunHandle({ mode: "parallel", agents: steps.map(({ step }) => step.agentName), style: "verbose" })} [${groupRunId}]`,
		].join("\n");
		return asyncStartedResult({ mode, runId: groupRunId, asyncDir: group.runRecordDir, text: handleText, children: childDetails });
	}
	const runRecordDir = first.step.runRecordDir;
	const statusWriter = new StatusWriter({ runRecordDir, runId });
	const startedAt = Date.now();
	appendRunEntry({
		runId,
		runRecordDir,
		mode,
		source: "async",
		...(mode === "single" ? { agentName: first.step.agentName } : { agentNames: steps.map(({ step }) => step.agentName) }),
		...(runLabel ? { label: runLabel } : {}),
		...(parentRunId ? { parentRunId } : {}),
		rootRunId,
		...(ctx.sessionManager?.getSessionId ? { parentSessionId: ctx.sessionManager.getSessionId() } : {}),
		...(() => {
			const root = resolveDispatchRootSessionId(ctx);
			return root ? { rootSessionId: root } : {};
		})(),
		cwd: effectiveCwd,
		startedAt,
	});
	statusWriter.initialize({
		mode,
		state: "queued",
		startedAt,
		cwd: effectiveCwd,
		...(runLabel ? { label: runLabel } : {}),
		...(parentRunId ? { parentRunId } : {}),
		currentStep: 0,
		sessionFile: first.step.sessionFile,
		sessionDir: runRecordDir,
		steps: steps.map(({ step }) => ({
			agent: step.agentName,
			...(step.label ? { label: step.label } : {}),
			status: "queued",
			sessionFile: step.sessionFile,
			live: {
				color: resolveAgentColor(step.agentConfig as unknown as AgentConfig),
				thinking: (step.agentConfig as unknown as AgentConfig).thinking,
			},
		})),
	});

	// Async children deliberately do NOT receive the parent turn's AbortSignal.
	// They survive ESC/cancel of the parent turn (matching the stated semantics:
	// "spawn async and hand control back; Pi wakes the parent when children finish").
	// Cancellation is still possible via childRegistry per-run controllers, exposed
	// through subagent({ action: "interrupt", runId }) and { runId: "all" }.
	const asyncDetachedAbort = new AbortController();
	const asyncCtx = {
		extensionCtx: ctx,
		abortSignal: asyncDetachedAbort.signal,
		onStatusUpdate: (patch: Parameters<StatusWriter["enqueue"]>[0]) => statusWriter.enqueue(patch),
		registry: deps.childRegistry,
		pi: deps.pi,
	};
	const finalizeAsync = async (handlesPromise: Promise<ChildAgentHandle[]>) => {
		logger.info("finalizeAsync: awaiting handles", { runId });
		let finalResult: ChildAgentResult | undefined;
		try {
			const handles = await handlesPromise;
			logger.info("finalizeAsync: handles resolved", { runId, count: handles.length });
			const settled = await Promise.allSettled(handles.map((handle) => handle.completed));
			logger.info("finalizeAsync: settled", { runId, states: settled.map((s) => s.status) });
			const results = settled.flatMap((entry) => entry.status === "fulfilled" ? [entry.value] : []);
			finalResult = results.find((result) => result.state !== "complete") ?? results.at(-1);
			if (!finalResult && settled[0]?.status === "rejected") {
				const now = Date.now();
				finalResult = { runId, stepIndex: 0, state: "failed", exitCode: 1, outputText: "", toolCallCount: 0, toolResultCount: 0, toolErrorCount: 0, durationMs: now - startedAt, startedAt, endedAt: now, sessionFile: first.step.sessionFile, error: { message: String(settled[0].reason) } };
			}
			// Canonical run-level usage aggregate across all child agents (single,
			// or each step of chain/parallel). For single mode this is just the
			// final result's usage; for chain/parallel we sum across results since
			// each step is its own ChildAgentResult with its own usage.
			const totalUsage: Usage = emptyUsage();
			if (mode === "chain" || mode === "parallel") {
				for (const entry of settled) {
					if (entry.status !== "fulfilled") continue;
					if (entry.value.usage) addUsageInto(totalUsage, entry.value.usage as Usage);
				}
			} else if (finalResult?.usage) {
				addUsageInto(totalUsage, finalResult.usage as Usage);
			}
			if (finalResult) await statusWriter.finalize(finalResult, { totalUsage });
			logger.info("finalizeAsync: emitting COMPLETE", { runId, success: finalResult?.state === "complete", state: finalResult?.state });
			const completeAgent = mode === "chain" || mode === "parallel"
				? steps.map(({ step }) => step.agentName).join(",")
				: first.step.agentName;
			const childResults = settled
				.flatMap((entry) => entry.status === "fulfilled" ? [entry.value] : [])
				.sort((a, b) => a.stepIndex - b.stepIndex)
				.map((r) => {
					const step = steps.find((candidate) => candidate.step.stepIndex === r.stepIndex)?.step;
					const childRunId = childCompletionRunId(runId, r.stepIndex, steps.length);
					return {
						id: childRunId,
						runId: childRunId,
						dispatchRunId: runId,
						...(params.batch === true ? { batchId: runId } : {}),
						stepIndex: r.stepIndex,
						agent: step?.agentName ?? "unknown",
						state: r.state,
						success: r.state === "complete",
						exitCode: r.exitCode,
						output: r.outputText ?? "",
						summary: r.outputText ?? "",
						durationMs: r.durationMs,
						sessionFile: r.sessionFile,
					};
				});
				safeEmit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
					id: runId,
					runId,
					...(parentRunId ? { parentRunId } : {}),
					rootRunId,
					notifyPolicy: batchToNotifyPolicy(params.batch),
					success: finalResult?.state === "complete",
				agent: completeAgent,
				summary: finalResult?.outputText ?? "",
				exitCode: finalResult?.exitCode,
				state: finalResult?.state,
				durationMs: finalResult?.durationMs,
				sessionFile: finalResult?.sessionFile,
				shareUrl: finalResult?.shareUrl,
				timestamp: Date.now(),
				result: finalResult,
				results: childResults,
				children: childResults,
				batch: params.batch === true,
				...(params.batch === true ? { batchId: runId } : {}),
				total: childResults.length,
				completed: childResults.filter((child) => child.state === "complete").length,
				totalUsage,
				asyncDir: runRecordDir,
				metadata: params.metadata,
			});
		} catch (err) {
			logger.error("finalizeAsync: threw", err instanceof Error ? err : new Error(String(err)), { runId });
		} finally {
			statusWriter.dispose();
			deps.childRegistry.delete(runId);
		}
	};

	let handlesPromise: Promise<ChildAgentHandle[]>;
	if (mode === "chain") {
		handlesPromise = (async () => {
			const handles: ChildAgentHandle[] = [];
			let previous = params.task ?? "";
			for (const group of chainGroups) {
				if (group.items.length === 1) {
					const item = group.items[0]!;
					item.step.task = item.step.task.replaceAll("{previous}", previous).replaceAll("{task}", params.task ?? "");
					const handle = dispatchAsyncChild(item.step, asyncCtx);
					handles.push(handle);
					const result = await handle.completed;
					previous = result.outputText;
					if (result.state !== "complete") break;
					continue;
				}

				const parallelResults = await mapConcurrent(group.items, group.concurrency, async (item) => {
					item.step.task = item.step.task.replaceAll("{previous}", previous).replaceAll("{task}", params.task ?? "");
					const handle = dispatchAsyncChild(item.step, asyncCtx);
					handles.push(handle);
					return { item, result: await handle.completed };
				});
				previous = aggregateParallelOutputs(parallelResults.map(({ item, result }, index) => ({
					agent: item.step.agentName,
					taskIndex: index,
					output: result.outputText,
					exitCode: result.exitCode,
					...(result.error?.message ? { error: result.error.message } : {}),
				})));
				if (parallelResults.some(({ result }) => result.state !== "complete")) break;
			}
			return handles;
		})();
	} else if (mode === "parallel") {
		const concurrency = hasTasks
			? resolveTopLevelParallelConcurrency(params.concurrency, deps.config.parallel?.concurrency, deps.config.parallel?.maxConcurrency)
			: 4;
		handlesPromise = mapConcurrent(steps, concurrency, async (item) => {
			const handle = dispatchAsyncChild(item.step, asyncCtx);
			await handle.completed;
			return handle;
		});
	} else {
		handlesPromise = Promise.resolve([dispatchAsyncChild(first.step, asyncCtx)]);
	}
	void finalizeAsync(handlesPromise);

	safeEmit(SUBAGENT_ASYNC_STARTED_EVENT, {
		id: runId,
		runId,
		metadata: params.metadata,
		controlConfig,
		agent: first.step.agentName,
		task: first.cleanTask.slice(0, 50),
		...(mode !== "single" ? { chain: steps.map(({ step }) => step.agentName) } : {}),
		cwd: effectiveCwd,
		asyncDir: runRecordDir,
	});

	const handleText = mode === "single"
		? `Async: ${first.step.agentName} [${runId}]`
		: mode === "parallel"
			? `Async parallel: ${formatRunHandle({ mode: "parallel", agents: steps.map(({ step }) => step.agentName), style: "verbose" })} [${runId}]`
			: `Async chain: ${formatRunHandle({ mode: "chain", agents: steps.map(({ step }) => step.agentName), style: "verbose" })} [${runId}]`;
	return asyncStartedResult({ mode, runId, asyncDir: runRecordDir, text: handleText });
}

async function runChainPath(data: ExecutionContextData, deps: ExecutorDeps): Promise<AgentToolResult<Details>> {
	const {
		params,
		effectiveCwd,
		agents,
		ctx,
		signal,
		runId,
		shareEnabled,
		sessionDirForIndex,
		sessionFileForIndex,
		artifactsDir,
		artifactConfig,
		onUpdate,
		sessionRoot,
		controlConfig,
		forkReuse,
	} = data;
	const onControlEvent = createForegroundControlNotifier(data, deps);
	const childIntercomTarget = data.intercomBridge.active ? resolveSubagentIntercomTarget : undefined;
	const foregroundControl = deps.state.foregroundControls.get(runId);
	const normalized = normalizeSkillInput(params.skill);
	const chainSkills = normalized === false ? [] : (normalized ?? []);
	const chain = wrapChainTasksForFork(params.chain as ChainStep[], params.context);
	const currentMaxSubagentDepth = resolveCurrentMaxSubagentDepth(deps.config.maxSubagentDepth);
	const runStep = async (_runtimeCwd: string, stepAgents: AgentConfig[], agentName: string, task: string, options: Parameters<NonNullable<Parameters<typeof executeChain>[0]["runStep"]>>[4]) => {
		const agentConfig = stepAgents.find((agent) => agent.name === agentName);
		if (!agentConfig) {
			return {
				agent: agentName,
				task,
				exitCode: 1,
				messages: [],
				usage: emptyUsage(),
				error: `Unknown agent: ${agentName}`,
			};
		}
		return runInProcessChildStep({
			data,
			deps,
			agentConfig,
			task,
			cleanTask: task,
			stepIndex: options.index ?? 0,
			cwd: options.cwd ?? ctx.cwd,
			...(options.label ? { label: options.label } : {}),
			interruptSignal: options.interruptSignal,
			outputPath: options.outputPath,
			maxSubagentDepth: options.maxSubagentDepth ?? currentMaxSubagentDepth,
			onUpdate: options.onUpdate,
			onControlEvent: options.onControlEvent,
			intercomSessionName: options.intercomSessionName,
			modelOverride: options.modelOverride,
			skills: options.skills,
			mode: "chain",
		});
	};
	const chainResult = await executeChain({
		chain,
		task: params.task,
		agents,
		ctx,
		signal,
		runId,
		cwd: effectiveCwd,
		shareEnabled,
		sessionDirForIndex,
		sessionFileForIndex,
		artifactsDir,
		artifactConfig,
		includeProgress: params.includeProgress,
		clarify: params.clarify,
		onUpdate,
		onControlEvent,
		controlConfig,
		childIntercomTarget: childIntercomTarget ? (agent, index) => childIntercomTarget(runId, agent, index) : undefined,
		foregroundControl,
		chainSkills,
		chainDir: params.chainDir,
		maxSubagentDepth: currentMaxSubagentDepth,
		forkReuse,
		preset: params.preset,
		runStep,
		worktreeSetupHook: deps.config.worktreeSetupHook,
		worktreeSetupHookTimeoutMs: deps.config.worktreeSetupHookTimeoutMs,
	});

	if (chainResult.requestedAsync) {
		return runAsyncPath({ ...data, params: { ...params, chain: chainResult.requestedAsync.chain, async: true, clarify: false }, effectiveAsync: true }, deps)!;
	}

	return chainResult;
}

interface ForegroundParallelRunInput {
	data: ExecutionContextData;
	deps: ExecutorDeps;
	tasks: TaskParam[];
	taskTexts: string[];
	agents: AgentConfig[];
	ctx: ExtensionContext;
	runId: string;
	rootRunId: string;
	paramsCwd?: string;
	maxSubagentDepths: number[];
	modelOverrides: (string | undefined)[];
	skillOverrides: (string[] | false | undefined)[];
	behaviors: Array<ReturnType<typeof resolveStepBehavior>>;
	onControlEvent?: (event: ControlEvent) => void;
	childIntercomTarget?: (agent: string, index: number) => string | undefined;
	foregroundControl?: SubagentState["foregroundControls"] extends Map<string, infer T> ? T : never;
	concurrencyLimit: number;
	liveResults: (SingleResult | undefined)[];
	liveProgress: (AgentProgress | undefined)[];
	onUpdate?: (r: AgentToolResult<Details>) => void;
	worktreeSetup?: WorktreeSetup;
}

function buildParallelModeError(message: string): AgentToolResult<Details> {
	return {
		content: [{ type: "text", text: message }],
		isError: true,
		details: { mode: "parallel" as const, results: [] },
	};
}

function tokenUsageFromResult(result: SingleResult): { input: number; output: number; cacheRead?: number; cacheWrite?: number; total: number } | undefined {
	return tokenUsageFromUsage(result.usage);
}

function emitSyncLifecycleEvent(
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

function emptyUsage(): Usage {
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

function resolveThinkingLevel(value: string | undefined): ChildAgentStep["thinkingLevel"] {
	return value === "off" || value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh"
		? value
		: undefined;
}

function splitModelThinking(modelRef: string | undefined, fallbackThinking: string | undefined): { modelRef?: string; thinkingLevel?: ChildAgentStep["thinkingLevel"] } {
	if (!modelRef) return { thinkingLevel: resolveThinkingLevel(fallbackThinking) };
	const colonIdx = modelRef.lastIndexOf(":");
	if (colonIdx === -1) return { modelRef, thinkingLevel: resolveThinkingLevel(fallbackThinking) };
	const suffix = modelRef.slice(colonIdx + 1);
	const thinkingLevel = resolveThinkingLevel(suffix);
	if (!thinkingLevel) return { modelRef, thinkingLevel: resolveThinkingLevel(fallbackThinking) };
	return { modelRef: modelRef.slice(0, colonIdx), thinkingLevel };
}

function resolveModelFromRef(ref: string | undefined, models: Model<any>[], fallback: Model<any> | undefined): Model<any> | undefined {
	if (!ref) return fallback ?? models[0];
	return models.find((model) => `${model.provider}/${model.id}` === ref || model.id === ref) ?? fallback ?? models[0];
}

export function resolveChildTools(agentConfig: AgentConfig, pi: ExtensionAPI): { activeToolNames: string[] | undefined; customTools: ToolDefinition[] } {
	// Semantics:
	//   tools frontmatter absent (undefined)  -> no allowlist => session sees ALL tools
	//   tools frontmatter explicit list       -> allowlist exactly those names
	//   tools: []                              -> explicit empty allowlist (zero tools)
	// Globs/negations were already expanded at registration time via
	// resolveAgentToolPatterns(discoverAgents(...)) in index.ts, so by the time
	// we reach here agentConfig.tools is either undefined or a concrete name list.
	const activeToolNames = agentConfig.tools === undefined
		? undefined
		: [...new Set([...agentConfig.tools, SUBMIT_RESULT_TOOL_NAME])];
	const customToolNames = new Set(agentConfig.mcpDirectTools ?? []);
	const customTools = [
		...pi.getAllTools().filter((tool) => customToolNames.has(tool.name)),
		createSubmitResultTool(),
	] as ToolDefinition[];
	return { activeToolNames, customTools };
}

function combineOptionalSignals(...signals: Array<AbortSignal | undefined>): AbortSignal {
	const controller = new AbortController();
	const abort = (signal: AbortSignal) => {
		if (!controller.signal.aborted) controller.abort(signal.reason);
	};
	for (const signal of signals) {
		if (!signal) continue;
		if (signal.aborted) {
			abort(signal);
			break;
		}
		signal.addEventListener("abort", () => abort(signal), { once: true });
	}
	return controller.signal;
}

function appendProgressOutput(progress: AgentProgress, text: string): void {
	const lines = text.split("\n").slice(-10).filter((line) => line.trim());
	if (lines.length === 0) return;
	progress.recentOutput.push(...lines);
	if (progress.recentOutput.length > 50) progress.recentOutput.splice(0, progress.recentOutput.length - 50);
}

function snapshotProgress(progress: AgentProgress): AgentProgress {
	return {
		...progress,
		skills: progress.skills ? [...progress.skills] : undefined,
		recentTools: progress.recentTools.map((tool) => ({ ...tool })),
		recentOutput: [...progress.recentOutput],
	};
}

async function runInProcessChildStep(input: {
	data: ExecutionContextData;
	deps: ExecutorDeps;
	agentConfig: AgentConfig;
	task: string;
	cleanTask: string;
	stepIndex: number;
	cwd: string;
	label?: string;
	modelOverride?: string;
	skills?: string[];
	outputPath?: string;
	maxSubagentDepth: number;
	interruptSignal?: AbortSignal;
	onUpdate?: (r: AgentToolResult<Details>) => void;
	onControlEvent?: (event: ControlEvent) => void;
	intercomSessionName?: string;
	mode?: Details["mode"];
	wrapUpdateDetails?: (update: AgentToolResult<Details>) => AgentToolResult<Details>;
	layer0?: { runId: string; runRecordDir: string; sessionFile: string; rootRunId: string };
}): Promise<SingleResult> {
	const { data, deps, agentConfig, stepIndex } = input;
	const availableModels = data.ctx.modelRegistry.getAvailable();
	const modelRefs = buildModelCandidates(
		input.modelOverride ?? agentConfig.model,
		agentConfig.fallbackModels,
		availableModels.map((model) => ({ provider: model.provider, id: model.id, fullId: `${model.provider}/${model.id}` })),
		data.ctx.model?.provider,
	);
	const primaryModelRef = applyThinkingSuffix(modelRefs[0], agentConfig.thinking);
	const parsedPrimary = splitModelThinking(primaryModelRef, agentConfig.thinking);
	const primaryModel = resolveModelFromRef(parsedPrimary.modelRef, availableModels, data.ctx.model);
	if (!primaryModel) {
		return {
			agent: agentConfig.name,
			task: input.cleanTask,
			...(input.label ? { label: input.label } : {}),
			exitCode: 1,
			messages: [],
			usage: emptyUsage(),
			error: "No model available for child agent.",
		};
	}
	const modelCandidates = modelRefs.slice(1)
		.map((ref) => resolveModelFromRef(splitModelThinking(applyThinkingSuffix(ref, agentConfig.thinking), agentConfig.thinking).modelRef, availableModels, undefined))
		.filter((model): model is Model<any> => Boolean(model));
	const skillNames = input.skills ?? agentConfig.skills ?? [];
	const { resolved: resolvedSkills, missing: missingSkills } = data.forkReuse
		? { resolved: [], missing: [] }
		: resolveSkillsWithFallback(skillNames, input.cwd, data.ctx.cwd);
	const skillInjection = buildSkillInjection(resolvedSkills);
	const systemPromptBase = data.forkReuse ? "" : agentConfig.systemPrompt?.trim() || "";
	const systemPrompt = skillInjection ? (systemPromptBase ? `${systemPromptBase}\n\n${skillInjection}` : skillInjection) : systemPromptBase;
	const sessionPaths = resolveChildSessionFile({
		parentCwd: data.effectiveCwd,
		parentSessionFile: data.ctx.sessionManager.getSessionFile() ?? null,
		runId: data.runId,
		stepIndex,
		...(data.params.sessionDir ? { sessionDirOverride: path.resolve(deps.expandTilde(data.params.sessionDir)) } : {}),
		...(deps.config.defaultSessionDir ? { defaultSessionDir: path.resolve(deps.expandTilde(deps.config.defaultSessionDir)) } : {}),
		...(data.forkReuse ? { forkContextFile: data.sessionFileForIndex(stepIndex) } : {}),
	});
	const childRunId = input.layer0?.runId ?? data.runId;
	const childSessionFile = input.layer0?.sessionFile ?? sessionPaths.sessionFile;
	const childRunRecordDir = input.layer0?.runRecordDir ?? sessionPaths.runRecordDir;
	const { activeToolNames, customTools } = resolveChildTools(agentConfig, deps.pi);
	const step: ChildAgentStep = {
		runId: childRunId,
		stepIndex,
		agentName: agentConfig.name,
		agentConfig: agentConfig as unknown as ChildAgentStep["agentConfig"],
		task: injectSubmitResultInstruction(input.task),
		cwd: input.cwd,
		model: primaryModel,
		modelCandidates,
		thinkingLevel: parsedPrimary.thinkingLevel,
		activeToolNames,
		customTools,
		systemPrompt,
		skillsResolved: resolvedSkills.map((skill) => skill.name),
		sessionFile: childSessionFile,
		runRecordDir: childRunRecordDir,
		...(data.forkReuse && data.sessionFileForIndex(stepIndex) ? { forkReuse: { sessionFile: data.sessionFileForIndex(stepIndex)!, agentName: data.forkReuse.agentName } } : {}),
		...(input.intercomSessionName || data.intercomBridge.orchestratorTarget ? { intercom: { selfTarget: input.intercomSessionName, bridgeTarget: data.intercomBridge.orchestratorTarget } } : {}),
		...(data.artifactConfig.enabled ? { artifactsDir: data.artifactsDir } : {}),
		...(input.label ? { label: input.label } : {}),
		parentAgentName: data.forkReuse?.agentName ?? process.env.PI_SUBAGENT_CURRENT_AGENT,
		parentSessionId: data.forkReuse?.sessionId ?? data.ctx.sessionManager.getSessionId() ?? deps.state.currentSessionId ?? undefined,
		rootSessionId: resolveDispatchRootSessionId(data.ctx, deps.state.currentSessionId ?? undefined),
		rootRunId: input.layer0?.rootRunId ?? data.rootRunId,
		maxSubagentDepth: input.maxSubagentDepth,
		...(data.params.preset ? { preset: data.params.preset } : {}),
		shareEnabled: data.shareEnabled,
		controlConfig: data.controlConfig,
		...(input.outputPath ? { outputPath: input.outputPath } : {}),
	};

	let artifactPathsResult: ArtifactPaths | undefined;
	if (data.artifactConfig.enabled) {
		artifactPathsResult = getArtifactPaths(data.artifactsDir, data.runId, agentConfig.name, stepIndex);
		ensureArtifactsDir(data.artifactsDir);
		if (data.artifactConfig.includeInput !== false) writeArtifact(artifactPathsResult.inputPath, `# Task for ${agentConfig.name}\n\n${input.cleanTask}`);
	}
	const outputSnapshot = captureSingleOutputSnapshot(input.outputPath);
	const usage = emptyUsage();
	const messages: Message[] = [];
	const startedAt = Date.now();
	const progress: AgentProgress = {
		index: stepIndex,
		agent: agentConfig.name,
		status: "running",
		task: input.cleanTask,
		skills: step.skillsResolved.length > 0 ? step.skillsResolved : undefined,
		recentTools: [],
		recentOutput: missingSkills.length > 0 ? [`Skills not found: ${missingSkills.join(", ")}`] : [],
		toolCount: 0,
		tokens: 0,
		durationMs: 0,
		lastActivityAt: startedAt,
		thinking: agentConfig.thinking,
		color: resolveAgentColor(agentConfig),
		tokenSamples: [{ ts: startedAt, tokens: 0 }],
	};
	const resultShell: SingleResult = {
		agent: agentConfig.name,
		task: input.cleanTask,
		...(input.label ? { label: input.label } : {}),
		exitCode: 0,
		messages,
		usage,
		model: `${primaryModel.provider}/${primaryModel.id}`,
		attemptedModels: modelRefs.length > 0 ? modelRefs : undefined,
		artifactPaths: artifactPathsResult,
		skills: step.skillsResolved.length > 0 ? step.skillsResolved : undefined,
		skillsWarning: missingSkills.length > 0 ? `Skills not found: ${missingSkills.join(", ")}` : undefined,
		progress,
	};
	const activityTicker = createActivityTicker({
		runId: childRunId,
		agent: agentConfig.name,
		index: stepIndex,
		config: data.controlConfig,
		getStartedAt: () => startedAt,
		getLastActivityAt: () => progress.lastActivityAt,
		getPhase: () => progress.phase,
		onNeedsAttention: input.onControlEvent,
	});
	const emitUpdate = () => {
		progress.activityState = activityTicker.tick();
		progress.durationMs = Date.now() - startedAt;
		const progressSnapshot = snapshotProgress(progress);
		const update: AgentToolResult<Details> = {
			content: [{ type: "text", text: getFinalOutput(messages) || resultShell.finalOutput || "(running...)" }],
			details: {
				mode: input.mode ?? "single",
				runId: input.layer0?.runId ?? data.runId,
				results: [{ ...resultShell, progress: progressSnapshot, messages: [...messages], usage: { ...usage } }],
				totalUsage: { ...usage },
				progress: [progressSnapshot],
			},
		};
		input.onUpdate?.(input.wrapUpdateDetails ? input.wrapUpdateDetails(update) : update);
	};
	const applyStatusPatchToProgress = (patch: StatusPatch) => {
		let shouldEmit = false;
		if (patch.activity?.updatedAt !== undefined) {
			progress.lastActivityAt = patch.activity.updatedAt;
			shouldEmit = true;
		}
		if (patch.phase !== undefined) {
			progress.phase = patch.phase;
			shouldEmit = true;
		}
		if (patch.phaseStartedAt !== undefined) {
			progress.phaseStartedAt = patch.phaseStartedAt;
			shouldEmit = true;
		}
		if (shouldEmit) emitUpdate();
	};
	let childResult: ChildAgentResult | undefined;
	try {
		childResult = await runChildAgent(step, {
			extensionCtx: data.ctx,
			abortSignal: combineOptionalSignals(data.signal, input.interruptSignal),
			onEvent: (_stepIndex: number, event: AgentSessionEvent) => {
			const record = event as Record<string, unknown>;
			const now = Date.now();
			progress.lastActivityAt = now;
			if (record.type === "tool_execution_start") {
				progress.toolCount++;
				progress.currentTool = typeof record.toolName === "string" ? record.toolName : undefined;
				progress.currentToolRawArgs = record.args && typeof record.args === "object" && !Array.isArray(record.args) ? record.args as Record<string, unknown> : undefined;
				progress.currentToolArgs = progress.currentToolRawArgs ? JSON.stringify(progress.currentToolRawArgs).slice(0, 200) : undefined;
				progress.currentToolStartedAt = now;
				emitUpdate();
			} else if (record.type === "tool_execution_end") {
				if (progress.currentTool) {
					const durationMs = progress.currentToolStartedAt !== undefined ? Math.max(0, now - progress.currentToolStartedAt) : undefined;
					progress.recentTools.push({ tool: progress.currentTool, args: progress.currentToolArgs || "", rawArgs: progress.currentToolRawArgs, endMs: now, durationMs });
				}
				// Bubble nested subagent usage into the parent's accumulator. When a
				// child agent invokes the `subagent` tool, the tool_result carries
				// `details.totalUsage` representing the full descendant tree. Adding
				// it here means parent SingleResult.usage (and therefore
				// details.totalUsage on the foreground return) includes nested work
				// even though the descendant's message_end events fire on a
				// different AgentSession's bus.
				const toolName = typeof record.toolName === "string" ? record.toolName : undefined;
				if (toolName === "subagent" && record.result && typeof record.result === "object") {
					const result = record.result as { details?: { totalUsage?: Usage } };
					const nested = result.details?.totalUsage;
					if (nested) {
						usage.input += nested.input || 0;
						usage.output += nested.output || 0;
						usage.cacheRead = (usage.cacheRead ?? 0) + (nested.cacheRead || 0);
						usage.cacheWrite = (usage.cacheWrite ?? 0) + (nested.cacheWrite || 0);
						usage.cost = (usage.cost ?? 0) + (nested.cost || 0);
						progress.tokens = totalUsageTokens(usage);
					}
				}
				progress.currentTool = undefined;
				progress.currentToolArgs = undefined;
				progress.currentToolRawArgs = undefined;
				progress.currentToolStartedAt = undefined;
				progress.lastToolEndAt = now;
				emitUpdate();
			} else if (record.type === "message_end" && record.message) {
				const message = record.message as Message;
				messages.push(message);
				if (message.role === "assistant") {
					usage.turns = (usage.turns ?? 0) + 1;
					const u = message.usage;
					if (u) {
						usage.input += u.input || 0;
						usage.output += u.output || 0;
						usage.cacheRead = (usage.cacheRead ?? 0) + (u.cacheRead || 0);
						usage.cacheWrite = (usage.cacheWrite ?? 0) + (u.cacheWrite || 0);
						usage.cost = (usage.cost ?? 0) + (u.cost?.total || 0);
						progress.tokens = totalUsageTokens(usage);
						progress.tokenSamples?.push({ ts: now, tokens: progress.tokens });
					}
					appendProgressOutput(progress, extractTextFromContent(message.content));
				}
				emitUpdate();
			}
		},
			onStatusUpdate: applyStatusPatchToProgress,
			registry: deps.childRegistry,
			pi: deps.pi,
		});
	} finally {
		activityTicker.stop();
	}
	if (!childResult) throw new Error(`Child agent did not produce a result for ${childRunId}`);
	progress.activityState = undefined;
	return childResultToSingleResult(childResult, {
		resultShell,
		progress,
		startedAt,
		artifactPathsResult,
		artifactConfig: data.artifactConfig,
		maxOutput: data.params.maxOutput,
		outputPath: input.outputPath,
		outputSnapshot,
	});
}

function childResultToSingleResult(childResult: ChildAgentResult, input: {
	resultShell: SingleResult;
	progress: AgentProgress;
	startedAt: number;
	artifactPathsResult?: ArtifactPaths;
	artifactConfig: ArtifactConfig;
	maxOutput?: MaxOutputConfig;
	outputPath?: string;
	outputSnapshot?: ReturnType<typeof captureSingleOutputSnapshot>;
}): SingleResult {
	const result = input.resultShell;
	result.exitCode = childResult.exitCode;
	result.error = childResult.error?.message;
	result.interrupted = childResult.state === "interrupted" ? true : undefined;
	result.sessionFile = childResult.sessionFile;
	result.shareUrl = childResult.shareUrl;
	result.structuredResult = childResult.structuredResult;
	let fullOutput = getFinalOutput(result.messages ?? []) || childResult.outputText;
	if (input.outputPath && result.exitCode === 0) {
		const resolvedOutput = resolveSingleOutput(input.outputPath, fullOutput, input.outputSnapshot);
		fullOutput = resolvedOutput.fullOutput;
		result.savedOutputPath = resolvedOutput.savedPath;
		result.outputSaveError = resolvedOutput.saveError;
	}
	result.finalOutput = fullOutput;
	input.progress.status = result.exitCode === 0 ? "completed" : "failed";
	input.progress.durationMs = childResult.durationMs || Date.now() - input.startedAt;
	if (result.error) input.progress.error = result.error;
	result.progressSummary = {
		toolCount: childResult.toolCallCount || input.progress.toolCount,
		tokens: totalUsageTokens(result.usage),
		durationMs: input.progress.durationMs,
	};
	if (input.artifactPathsResult && input.artifactConfig.enabled !== false) {
		result.artifactPaths = input.artifactPathsResult;
		if (input.artifactConfig.includeOutput !== false) writeArtifact(input.artifactPathsResult.outputPath, result.finalOutput ?? "");
		if (input.artifactConfig.includeMetadata !== false) {
			writeMetadata(input.artifactPathsResult.metadataPath, {
				runId: childResult.runId,
				agent: result.agent,
				task: result.task,
				exitCode: result.exitCode,
				usage: result.usage,
				model: result.model,
				attemptedModels: result.attemptedModels,
				durationMs: result.progressSummary.durationMs,
				toolCount: result.progressSummary.toolCount,
				error: result.error,
				skills: result.skills,
				skillsWarning: result.skillsWarning,
				timestamp: Date.now(),
			});
		}
	}
	if (input.maxOutput) {
		const truncationResult = truncateOutput(result.finalOutput ?? "", { ...DEFAULT_MAX_OUTPUT, ...input.maxOutput }, input.artifactPathsResult?.outputPath);
		if (truncationResult.truncated) result.truncation = truncationResult;
	}
	return result;
}

function createParallelWorktreeSetup(
	enabled: boolean | undefined,
	cwd: string,
	runId: string,
	tasks: TaskParam[],
	setupHook: ExtensionConfig["worktreeSetupHook"],
	setupHookTimeoutMs: ExtensionConfig["worktreeSetupHookTimeoutMs"],
): { setup?: WorktreeSetup; errorResult?: AgentToolResult<Details> } {
	if (!enabled) return {};
	try {
		return {
			setup: createWorktrees(cwd, runId, tasks.length, {
				agents: tasks.map((task) => task.agent),
				setupHook: setupHook
					? { hookPath: setupHook, timeoutMs: setupHookTimeoutMs }
					: undefined,
			}),
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { errorResult: buildParallelModeError(message) };
	}
}

function buildParallelWorktreeTaskCwdError(
	tasks: ReadonlyArray<{ agent: string; cwd?: string }>,
	sharedCwd: string,
): string | undefined {
	const conflict = findWorktreeTaskCwdConflict(tasks, sharedCwd);
	if (!conflict) return undefined;
	return formatWorktreeTaskCwdConflict(conflict, sharedCwd);
}

function buildChainWorktreeTaskCwdError(chain: ChainStep[], sharedCwd: string): string | undefined {
	for (let stepIndex = 0; stepIndex < chain.length; stepIndex++) {
		const step = chain[stepIndex]!;
		if (!isParallelStep(step) || !step.worktree) continue;
		const stepCwd = sharedCwd;
		const conflict = findWorktreeTaskCwdConflict(step.parallel, stepCwd);
		if (!conflict) continue;
		const detail = formatWorktreeTaskCwdConflict(conflict, stepCwd);
		return `parallel chain step ${stepIndex + 1}: ${detail}`;
	}
	return undefined;
}

function resolveParallelTaskCwd(
	task: TaskParam,
	paramsCwd: string | undefined,
	worktreeSetup: WorktreeSetup | undefined,
	index: number,
): string | undefined {
	if (worktreeSetup) return worktreeSetup.worktrees[index]!.agentCwd;
	if (!paramsCwd) return task.cwd;
	return resolveChildCwd(paramsCwd, task.cwd);
}

function buildParallelWorktreeSuffix(
	worktreeSetup: WorktreeSetup | undefined,
	artifactsDir: string,
	tasks: TaskParam[],
): string {
	if (!worktreeSetup) return "";
	const diffsDir = path.join(artifactsDir, "worktree-diffs");
	const diffs = diffWorktrees(worktreeSetup, tasks.map((task) => task.agent), diffsDir);
	return formatWorktreeDiffSummary(diffs);
}

async function runForegroundParallelTasks(input: ForegroundParallelRunInput): Promise<SingleResult[]> {
	return mapConcurrent(input.tasks, input.concurrencyLimit, async (task, index) => {
		try {
			const overrideSkills = input.skillOverrides[index];
			const effectiveSkills = overrideSkills === undefined ? input.behaviors[index]?.skills : overrideSkills;
			const taskCwd = resolveParallelTaskCwd(task, input.paramsCwd, input.worktreeSetup, index);
			let childRunId = input.runId;
			if (input.foregroundControl) {
				input.foregroundControl.currentAgent = task.agent;
				input.foregroundControl.currentIndex = index;
				input.foregroundControl.currentActivityState = undefined;
				input.foregroundControl.updatedAt = Date.now();
				input.foregroundControl.interrupt = () => {
					const interrupted = interruptRun(childRunId, { cascade: true }).interruptedRunIds.length > 0;
					if (!interrupted) return false;
					input.foregroundControl!.currentActivityState = undefined;
					input.foregroundControl!.updatedAt = Date.now();
					return true;
				};
			}
			let result: SingleResult | undefined;
			const handle = spawnRun({
				agentName: task.agent,
				task: input.taskTexts[index]!,
				cwd: taskCwd ?? input.ctx.cwd,
				...(task.label ? { label: task.label } : {}),
			}, {
				parentRunId: input.runId,
				rootRunId: input.rootRunId,
				notifyPolicy: "each",
				parentSessionFile: input.ctx.sessionManager.getSessionFile() ?? null,
				...(input.data.params.sessionDir ? { sessionDir: path.resolve(input.deps.expandTilde(input.data.params.sessionDir)) } : {}),
				...(input.deps.config.defaultSessionDir ? { defaultSessionDir: path.resolve(input.deps.expandTilde(input.deps.config.defaultSessionDir)) } : {}),
				...(input.ctx.sessionManager?.getSessionId ? { parentSessionId: input.ctx.sessionManager.getSessionId() } : {}),
				...(() => {
					const root = resolveDispatchRootSessionId(input.ctx);
					return root ? { rootSessionId: root } : {};
				})(),
				source: "sync",
				runAgent: async (prepared, layer0Ctx) => {
					childRunId = prepared.runId;
					result = await runInProcessChildStep({
					data: input.data,
					deps: input.deps,
					agentConfig: input.agents.find((agent) => agent.name === task.agent)!,
					task: input.taskTexts[index]!,
					cleanTask: input.taskTexts[index]!,
					stepIndex: index,
					cwd: taskCwd ?? input.ctx.cwd,
					...(task.label ? { label: task.label } : {}),
					interruptSignal: layer0Ctx.abortSignal,
					maxSubagentDepth: input.maxSubagentDepths[index],
					onControlEvent: (event) => {
						if (event.type === "needs_attention") {
							interruptRun(prepared.runId, { cascade: true });
							if (input.foregroundControl) {
								input.foregroundControl.currentActivityState = undefined;
								input.foregroundControl.updatedAt = Date.now();
							}
							return;
						}
						input.onControlEvent?.(event);
					},
					intercomSessionName: input.childIntercomTarget?.(task.agent, index),
					modelOverride: input.modelOverrides[index],
					skills: effectiveSkills === false ? [] : effectiveSkills,
					mode: "parallel",
					layer0: { runId: prepared.runId, runRecordDir: prepared.runRecordDir, sessionFile: prepared.sessionFile, rootRunId: input.rootRunId },
					onUpdate: input.onUpdate || input.foregroundControl
				? (progressUpdate) => {
						const stepResults = progressUpdate.details?.results || [];
						const stepProgress = progressUpdate.details?.progress || [];
						if (input.foregroundControl && stepProgress.length > 0) {
							const current = stepProgress[0];
							input.foregroundControl.currentAgent = task.agent;
							input.foregroundControl.currentAgentColor = current?.color;
							input.foregroundControl.currentIndex = index;
							input.foregroundControl.currentActivityState = current?.activityState;
							input.foregroundControl.lastActivityAt = current?.lastActivityAt;
							input.foregroundControl.currentTool = current?.currentTool;
							input.foregroundControl.currentToolStartedAt = current?.currentToolStartedAt;
							input.foregroundControl.phase = current?.phase;
							input.foregroundControl.phaseStartedAt = current?.phaseStartedAt;
							input.foregroundControl.lastToolEndAt = current?.lastToolEndAt;
							input.foregroundControl.recentTools = current?.recentTools;
							input.foregroundControl.recentOutput = current?.recentOutput;
							input.foregroundControl.finalOutput = stepResults[0]?.finalOutput;
							input.foregroundControl.updatedAt = Date.now();
						}
						if (stepResults.length > 0) input.liveResults[index] = stepResults[0];
						if (stepProgress.length > 0) input.liveProgress[index] = stepProgress[0];
						const mergedResults = input.liveResults.filter((result): result is SingleResult => result !== undefined);
						const mergedProgress = input.liveProgress.filter((progress): progress is AgentProgress => progress !== undefined);
						input.onUpdate?.({
							content: progressUpdate.content,
							details: {
								mode: "parallel",
								runId: input.runId,
								results: mergedResults,
								progress: mergedProgress,
								controlEvents: progressUpdate.details?.controlEvents,
								totalSteps: input.tasks.length,
							},
						});
					}
				: undefined,
					});
					return {
					runId: prepared.runId,
					stepIndex: 0,
					state: result.interrupted ? "interrupted" : result.exitCode === 0 ? "complete" : "failed",
					exitCode: result.exitCode === 0 ? 0 : 1,
					outputText: getSingleResultOutput(result),
					toolCallCount: result.progressSummary?.toolCount ?? 0,
					toolResultCount: 0,
					toolErrorCount: 0,
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
				},
			});
			await awaitRun(handle);
			if (!result) throw new Error(`Child agent did not produce a result for ${handle.runId}`);
			return result;
		} finally {
			if (input.foregroundControl?.currentIndex === index) {
				input.foregroundControl.interrupt = undefined;
				input.foregroundControl.updatedAt = Date.now();
			}
		}
	});
}

async function runParallelPath(data: ExecutionContextData, deps: ExecutorDeps): Promise<AgentToolResult<Details>> {
	const {
		params,
		effectiveCwd,
		agents,
		ctx,
		runId,
		artifactsDir,
		backgroundRequestedWhileClarifying,
		onUpdate,
	} = data;
	const onControlEvent = createForegroundControlNotifier(data, deps);
	const childIntercomTarget = data.intercomBridge.active ? resolveSubagentIntercomTarget : undefined;
	const allProgress: AgentProgress[] = [];
	const allArtifactPaths: ArtifactPaths[] = [];
	const tasks = params.tasks as TaskParam[];
	const maxParallelTasks = resolveTopLevelParallelMaxTasks(deps.config.parallel?.maxTasks);
	const parallelConcurrency = resolveTopLevelParallelConcurrency(
		params.concurrency,
		deps.config.parallel?.concurrency,
		deps.config.parallel?.maxConcurrency,
	);

	if (tasks.length > maxParallelTasks)
		return {
			content: [{ type: "text", text: `Max ${maxParallelTasks} tasks` }],
			isError: true,
			details: { mode: "parallel" as const, results: [] },
		};

	const agentConfigs: AgentConfig[] = [];
	for (const t of tasks) {
		const config = agents.find((a) => a.name === t.agent);
		if (!config) {
			return {
				content: [{ type: "text", text: `Unknown agent: ${t.agent}` }],
				isError: true,
				details: { mode: "parallel" as const, results: [] },
			};
		}
		agentConfigs.push(config);
	}

	const currentMaxSubagentDepth = resolveCurrentMaxSubagentDepth(deps.config.maxSubagentDepth);
	const maxSubagentDepths = agentConfigs.map((config) =>
		resolveChildMaxSubagentDepth(currentMaxSubagentDepth, config.maxSubagentDepth),
	);

	if (params.worktree) {
		const worktreeTaskCwdError = buildParallelWorktreeTaskCwdError(tasks, effectiveCwd);
		if (worktreeTaskCwdError) return buildParallelModeError(worktreeTaskCwdError);
	}

	const currentProvider = ctx.model?.provider;
	const availableModels: ModelInfo[] = ctx.modelRegistry.getAvailable().map((m) => ({
		provider: m.provider,
		id: m.id,
		fullId: `${m.provider}/${m.id}`,
	}));
	let taskTexts = tasks.map((t) => t.task);
	const modelOverrides: (string | undefined)[] = tasks.map((t, i) =>
		resolveModelCandidate(t.model ?? agentConfigs[i]?.model, availableModels, currentProvider),
	);
	const skillOverrides: (string[] | false | undefined)[] = tasks.map((t) =>
		normalizeSkillInput(t.skill),
	);

	if (params.clarify === true && ctx.hasUI) {
		const behaviors = agentConfigs.map((c, i) =>
			resolveStepBehavior(c, { skills: skillOverrides[i] }),
		);
		const availableSkills = discoverAvailableSkills(effectiveCwd);

		const result = await ctx.ui.custom<ChainClarifyResult>(
			(tui, theme, _kb, done) =>
				new ChainClarifyComponent(
					tui, theme,
					agentConfigs,
					taskTexts,
					"",
					undefined,
					behaviors,
					availableModels,
					currentProvider,
					availableSkills,
					done,
					"parallel",
				),
			{ overlay: true, overlayOptions: { anchor: "center", width: 84, maxHeight: "80%" } },
		);

		if (!result || !result.confirmed) {
			return { content: [{ type: "text", text: "Cancelled" }], details: { mode: "parallel", results: [] } };
		}

		taskTexts = result.templates;
		for (let i = 0; i < result.behaviorOverrides.length; i++) {
			const override = result.behaviorOverrides[i];
			if (override?.model) modelOverrides[i] = override.model;
			if (override?.skills !== undefined) skillOverrides[i] = override.skills;
		}

		if (result.runInBackground) {
			const parallelTasks = tasks.map((t, i) => ({
				...t,
				task: taskTexts[i]!,
				...(modelOverrides[i] ? { model: modelOverrides[i] } : {}),
				...(skillOverrides[i] !== undefined ? { skill: skillOverrides[i] } : {}),
			}));
			return runAsyncPath({ ...data, params: { ...params, tasks: parallelTasks, async: true, clarify: false }, effectiveAsync: true }, deps)!;
		}
	}
	const behaviors = agentConfigs.map((config) => resolveStepBehavior(config, {}));
	const liveResults: (SingleResult | undefined)[] = new Array(tasks.length).fill(undefined);
	const liveProgress: (AgentProgress | undefined)[] = new Array(tasks.length).fill(undefined);
	const foregroundControl = deps.state.foregroundControls.get(runId);
	const { setup: worktreeSetup, errorResult } = createParallelWorktreeSetup(
		params.worktree,
		effectiveCwd,
		runId,
		tasks,
		deps.config.worktreeSetupHook,
		deps.config.worktreeSetupHookTimeoutMs,
	);
	if (errorResult) return errorResult;

	try {
		if (params.context === "fork") {
			for (let i = 0; i < taskTexts.length; i++) {
				taskTexts[i] = wrapForkTask(taskTexts[i]!);
			}
		}

		const results = await runForegroundParallelTasks({
			data,
			deps,
			tasks,
			taskTexts,
			agents,
			ctx,
			runId,
			rootRunId: data.rootRunId,
			paramsCwd: effectiveCwd,
			modelOverrides,
			skillOverrides,
			behaviors,
			onControlEvent,
			childIntercomTarget: childIntercomTarget ? (agent, index) => childIntercomTarget(runId, agent, index) : undefined,
			foregroundControl,
			concurrencyLimit: parallelConcurrency,
			maxSubagentDepths,
			liveResults,
			liveProgress,
			onUpdate,
			worktreeSetup,
		});
		for (let i = 0; i < results.length; i++) {
			const run = results[i]!;
			recordRun(run.agent, taskTexts[i]!, run.exitCode, run.progressSummary?.durationMs ?? 0);
		}

		for (const result of results) {
			if (result.progress) allProgress.push(result.progress);
			if (result.artifactPaths) allArtifactPaths.push(result.artifactPaths);
		}

		const interrupted = results.find((result) => result.interrupted);
		if (interrupted) {
			return {
				content: [{ type: "text", text: `Parallel run paused after interrupt (${interrupted.agent}). Waiting for explicit next action.` }],
				details: compactForegroundDetails({
					mode: "parallel",
					runId,
					results,
					progress: params.includeProgress ? allProgress : undefined,
					artifacts: allArtifactPaths.length ? { dir: artifactsDir, files: allArtifactPaths } : undefined,
				}),
			};
		}

		const worktreeSuffix = buildParallelWorktreeSuffix(worktreeSetup, artifactsDir, tasks);
		// A run "succeeded" only if the executor reported exitCode 0 AND it produced
		// something usable (any text output, regardless of byte count). exitCode 0 +
		// empty output gets reported as "empty" so the parent doesn't read 5/5 success
		// when half the agents returned nothing. After in-process-executor's
		// detectProviderFailure landed, provider-error runs already exit non-zero;
		// this catches any other empty-completion edge case (refusals, legit-empty
		// model output, etc.).
		const hasOutput = (result: SingleResult): boolean =>
			Boolean((result.truncation?.text || getSingleResultOutput(result)).trim());
		const ok = results.filter((result) => result.exitCode === 0 && hasOutput(result)).length;
		const emptyCount = results.filter((result) => result.exitCode === 0 && !hasOutput(result)).length;
		const downgradeNote = backgroundRequestedWhileClarifying ? " (background requested, but clarify kept this run foreground)" : "";
		const aggregatedOutput = aggregateParallelOutputs(
			results.map((result) => ({
				agent: result.agent,
				output: result.truncation?.text || getSingleResultOutput(result),
				exitCode: result.exitCode,
				error: result.error,
			})),
			(i, agent) => `=== Task ${i + 1}: ${agent} ===`,
		);

		const emptyNote = emptyCount > 0 ? `, ${emptyCount} empty` : "";
		const summary = `${ok}/${results.length} succeeded${emptyNote}${downgradeNote}`;
		const fullContent = worktreeSuffix
			? `${summary}\n\n${aggregatedOutput}\n\n${worktreeSuffix}`
			: `${summary}\n\n${aggregatedOutput}`;

		return {
			content: [{ type: "text", text: fullContent }],
			details: compactForegroundDetails({
				mode: "parallel",
				runId,
				results,
				progress: params.includeProgress ? allProgress : undefined,
				artifacts: allArtifactPaths.length ? { dir: artifactsDir, files: allArtifactPaths } : undefined,
			}),
		};
	} finally {
		if (worktreeSetup) cleanupWorktrees(worktreeSetup);
	}
}

async function runSinglePath(data: ExecutionContextData, deps: ExecutorDeps): Promise<AgentToolResult<Details>> {
	const {
		params,
		effectiveCwd,
		agents,
		ctx,
		signal,
		runId,
		sessionDirForIndex,
		sessionFileForIndex,
		shareEnabled,
		artifactConfig,
		artifactsDir,
		onUpdate,
		sessionRoot,
		controlConfig,
		forkReuse,
	} = data;
	const onControlEvent = createForegroundControlNotifier(data, deps);
	const childIntercomTarget = data.intercomBridge.active ? resolveSubagentIntercomTarget(runId, params.agent!, undefined) : undefined;
	const allProgress: AgentProgress[] = [];
	const allArtifactPaths: ArtifactPaths[] = [];
	const agentConfig = agents.find((a) => a.name === params.agent);
	if (!agentConfig) {
		return {
			content: [{ type: "text", text: `Unknown agent: ${params.agent}` }],
			isError: true,
			details: { mode: "single", results: [] },
		};
	}

	const currentProvider = ctx.model?.provider;
	const availableModels: ModelInfo[] = ctx.modelRegistry.getAvailable().map((m) => ({
		provider: m.provider,
		id: m.id,
		fullId: `${m.provider}/${m.id}`,
	}));
	let task = params.task ?? "";
	let modelOverride: string | undefined = resolveModelCandidate(
		(params.model as string | undefined) ?? agentConfig.model,
		availableModels,
		currentProvider,
	);
	let skillOverride: string[] | false | undefined = normalizeSkillInput(params.skill);
	const rawOutput = params.output !== undefined ? params.output : agentConfig.output;
	let effectiveOutput: string | false | undefined = rawOutput === true ? agentConfig.output : (rawOutput as string | false | undefined);
	const currentMaxSubagentDepth = resolveCurrentMaxSubagentDepth(deps.config.maxSubagentDepth);
	const maxSubagentDepth = resolveChildMaxSubagentDepth(currentMaxSubagentDepth, agentConfig.maxSubagentDepth);

	if (params.clarify === true && ctx.hasUI) {
		const behavior = resolveStepBehavior(agentConfig, { output: effectiveOutput, skills: skillOverride });
		const availableSkills = discoverAvailableSkills(effectiveCwd);

		const result = await ctx.ui.custom<ChainClarifyResult>(
			(tui, theme, _kb, done) =>
				new ChainClarifyComponent(
					tui, theme,
					[agentConfig],
					[task],
					task,
					undefined,
					[behavior],
					availableModels,
					currentProvider,
					availableSkills,
					done,
					"single",
				),
			{ overlay: true, overlayOptions: { anchor: "center", width: 84, maxHeight: "80%" } },
		);

		if (!result || !result.confirmed) {
			return { content: [{ type: "text", text: "Cancelled" }], details: { mode: "single", results: [] } };
		}

		task = result.templates[0]!;
		const override = result.behaviorOverrides[0];
		if (override?.model) modelOverride = override.model;
		if (override?.output !== undefined) effectiveOutput = override.output;
		if (override?.skills !== undefined) skillOverride = override.skills;

		if (result.runInBackground) {
			return runAsyncPath({ ...data, params: { ...params, task, model: modelOverride, skill: skillOverride, output: effectiveOutput, async: true, clarify: false }, effectiveAsync: true }, deps)!;
		}
	}
	if (params.context === "fork") {
		task = wrapForkTask(task);
	}
	const cleanTask = task;
	const outputPath = resolveSingleOutputPath(effectiveOutput, ctx.cwd, effectiveCwd);
	task = injectSingleOutputInstruction(task, outputPath);

	let effectiveSkills: string[] | undefined;
	if (skillOverride === false) {
		effectiveSkills = [];
	} else {
		effectiveSkills = skillOverride;
	}
	const interruptController = new AbortController();
	const foregroundControl = deps.state.foregroundControls.get(runId);
	if (foregroundControl) {
		foregroundControl.currentAgent = params.agent;
		foregroundControl.currentIndex = 0;
		foregroundControl.currentActivityState = undefined;
		foregroundControl.updatedAt = Date.now();
		foregroundControl.interrupt = (reason?: string) => {
			if (interruptController.signal.aborted) return false;
			interruptController.abort(reason ?? "interrupt requested");
			foregroundControl.currentActivityState = undefined;
			foregroundControl.updatedAt = Date.now();
			return true;
		};
	}

	const forwardSingleUpdate = onUpdate || foregroundControl
		? (update: AgentToolResult<Details>) => {
			if (foregroundControl) {
				const firstProgress = update.details?.progress?.[0];
				foregroundControl.currentAgent = params.agent;
				foregroundControl.currentAgentColor = firstProgress?.color;
				foregroundControl.currentIndex = firstProgress?.index ?? 0;
				foregroundControl.currentActivityState = firstProgress?.activityState;
				foregroundControl.lastActivityAt = firstProgress?.lastActivityAt;
				foregroundControl.currentTool = firstProgress?.currentTool;
				foregroundControl.currentToolStartedAt = firstProgress?.currentToolStartedAt;
				foregroundControl.phase = firstProgress?.phase;
				foregroundControl.phaseStartedAt = firstProgress?.phaseStartedAt;
				foregroundControl.lastToolEndAt = firstProgress?.lastToolEndAt;
				foregroundControl.recentTools = firstProgress?.recentTools;
				foregroundControl.recentOutput = firstProgress?.recentOutput;
				foregroundControl.finalOutput = update.details?.results?.[0]?.finalOutput;
				foregroundControl.updatedAt = Date.now();
				writeSyncRunStatusUpdate(runId, {
					currentStep: firstProgress?.index ?? 0,
					lastActivityAt: firstProgress?.lastActivityAt,
					currentTool: firstProgress?.currentTool,
					currentToolStartedAt: firstProgress?.currentToolStartedAt,
					phase: firstProgress?.phase,
					phaseStartedAt: firstProgress?.phaseStartedAt,
					steps: [{
						agent: firstProgress?.agent ?? params.agent!,
						status: firstProgress?.status ?? "running",
						startedAt: firstProgress?.lastActivityAt,
						lastActivityAt: firstProgress?.lastActivityAt,
						currentTool: firstProgress?.currentTool,
						currentToolStartedAt: firstProgress?.currentToolStartedAt,
					}],
				}, {}, sessionRoot);
			}
			onUpdate?.(update);
		}
		: undefined;

	const eventPayload = {
		runId,
		agent: params.agent!,
		task: cleanTask,
		cwd: effectiveCwd,
		metadata: params.metadata,
	};
	emitSyncLifecycleEvent(deps.pi, SUBAGENT_SPAWN_STARTED_EVENT, eventPayload);
	writeSyncRunStatusUpdate(runId, { currentStep: 0, steps: [{ agent: params.agent!, status: "running", startedAt: Date.now(), lastActivityAt: Date.now() }] }, { flush: true }, sessionRoot);
	const r = await runInProcessChildStep({
		data,
		deps,
		agentConfig,
		task,
		cleanTask,
		stepIndex: 0,
		cwd: effectiveCwd,
		...(params.label ? { label: params.label } : {}),
		interruptSignal: interruptController.signal,
		outputPath,
		maxSubagentDepth,
		onUpdate: forwardSingleUpdate,
		onControlEvent: (event) => {
			if (!interruptForegroundOnNeedsAttention(event, interruptController, foregroundControl)) {
				onControlEvent(event);
			}
		},
		intercomSessionName: childIntercomTarget,
		modelOverride,
		skills: effectiveSkills,
	});
	emitSyncLifecycleEvent(deps.pi, r.exitCode === 0 ? SUBAGENT_COMPLETED_EVENT : SUBAGENT_FAILED_EVENT, {
		...eventPayload,
		exitCode: r.exitCode,
		error: r.error,
	});
	if (foregroundControl?.currentIndex === 0) {
		foregroundControl.interrupt = undefined;
		foregroundControl.currentActivityState = r.progress?.activityState;
		foregroundControl.lastActivityAt = r.progress?.lastActivityAt;
		foregroundControl.currentTool = r.progress?.currentTool;
		foregroundControl.currentToolStartedAt = r.progress?.currentToolStartedAt;
		foregroundControl.phase = r.progress?.phase;
		foregroundControl.phaseStartedAt = r.progress?.phaseStartedAt;
		foregroundControl.lastToolEndAt = r.progress?.lastToolEndAt;
		foregroundControl.recentTools = r.progress?.recentTools;
		foregroundControl.recentOutput = r.progress?.recentOutput;
		foregroundControl.finalOutput = r.finalOutput;
		foregroundControl.updatedAt = Date.now();
	}
	recordRun(params.agent!, cleanTask, r.exitCode, r.progressSummary?.durationMs ?? 0);

	if (r.progress) allProgress.push(r.progress);
	if (r.artifactPaths) allArtifactPaths.push(r.artifactPaths);

	const fullOutput = getSingleResultOutput(r);
	const finalizedOutput = finalizeSingleOutput({
		fullOutput,
		truncatedOutput: r.truncation?.text,
		outputPath,
		exitCode: r.exitCode,
		savedPath: r.savedOutputPath,
		saveError: r.outputSaveError,
	});

	if (r.detached) {
		return {
			content: [{ type: "text", text: `Detached for intercom coordination: ${params.agent}` }],
				details: compactForegroundDetails({
					mode: "single",
					runId,
					results: [r],
				progress: params.includeProgress ? allProgress : undefined,
				artifacts: allArtifactPaths.length ? { dir: artifactsDir, files: allArtifactPaths } : undefined,
				truncation: r.truncation,
			}),
		};
	}

	if (r.interrupted) {
		return {
			content: [{ type: "text", text: `Run paused after interrupt (${params.agent}). Waiting for explicit next action.` }],
				details: compactForegroundDetails({
					mode: "single",
					runId,
					results: [r],
				progress: params.includeProgress ? allProgress : undefined,
				artifacts: allArtifactPaths.length ? { dir: artifactsDir, files: allArtifactPaths } : undefined,
				truncation: r.truncation,
			}),
		};
	}

	if (r.exitCode !== 0)
		return {
			content: [{ type: "text", text: r.error || "Failed" }],
			details: compactForegroundDetails({
				mode: "single",
				runId,
				results: [r],
				progress: params.includeProgress ? allProgress : undefined,
				artifacts: allArtifactPaths.length ? { dir: artifactsDir, files: allArtifactPaths } : undefined,
				truncation: r.truncation,
			}),
			isError: true,
		};
	return {
		content: [{ type: "text", text: finalizedOutput.displayOutput || "(no output)" }],
		details: compactForegroundDetails({
			mode: "single",
			runId,
			results: [r],
			progress: params.includeProgress ? allProgress : undefined,
			artifacts: allArtifactPaths.length ? { dir: artifactsDir, files: allArtifactPaths } : undefined,
			truncation: r.truncation,
		}),
	};
}

export function createSubagentExecutor(deps: ExecutorDeps): {
	execute: (
		id: string,
		params: SubagentToolInput,
		signal: AbortSignal,
		onUpdate: ((r: AgentToolResult<Details>) => void) | undefined,
		ctx: ExtensionContext,
	) => Promise<AgentToolResult<Details>>;
	executeInternal: (
		id: string,
		params: InternalSubagentParams,
		signal: AbortSignal,
		onUpdate: ((r: AgentToolResult<Details>) => void) | undefined,
		ctx: ExtensionContext,
	) => Promise<AgentToolResult<Details>>;
} {
	const executeImpl = async (
		_id: string,
		params: InternalSubagentParams,
		signal: AbortSignal,
		onUpdate: ((r: AgentToolResult<Details>) => void) | undefined,
		ctx: ExtensionContext,
		internal: boolean,
	): Promise<AgentToolResult<Details>> => {
		deps.state.baseCwd = ctx.cwd;
		deps.state.foregroundControls ??= new Map();
		deps.state.lastForegroundControlId ??= null;
		if (!internal) {
			const slimValidationError = validateSubagentToolInput(params);
			if (slimValidationError) return slimValidationError;
		}

		const requestCwd = internal ? resolveRequestedCwd(ctx.cwd, params.cwd) : ctx.cwd;
		const paramsWithResolvedCwd = params.cwd === undefined ? params : { ...params, cwd: requestCwd };
		if (params.action) {
			if (params.action === "status") {
				const foreground = getForegroundControl(deps.state, paramsWithResolvedCwd.id ?? paramsWithResolvedCwd.runId);
				if (foreground) return foregroundStatusResult(foreground);
				// Auto-scope the no-id list to the current session's tree (matches the
				// /subagents-status overlay) so `subagent({ action: "status" })` doesn't
				// dump every entry in runs-index.jsonl across every project ever spawned.
				const statusSessionId = resolveDispatchRootSessionId(ctx, deps.state.currentSessionId ?? undefined);
				return inspectSubagentStatus({
					...(paramsWithResolvedCwd as { action?: "status"; id?: string; runId?: string; dir?: string; cwd?: string; includeProgress?: boolean; includeCompleted?: boolean }),
					...(statusSessionId ? { sessionId: statusSessionId } : {}),
					sessionCwd: requestCwd,
				});
			}
			if (params.action === "interrupt") {
				const targetRunId = paramsWithResolvedCwd.runId ?? paramsWithResolvedCwd.id;
				// Explicit fan-out: runId="all" interrupts every running async child in this
				// session (foreground runs are not affected). Used as a discoverable kill
				// switch now that ESC of the parent turn no longer cascades into async work.
				if (targetRunId === "all") {
					return interruptAllAsyncRuns(deps.state, deps.childRegistry);
				}
				const foreground = getForegroundControl(deps.state, targetRunId);
				if (foreground?.interrupt) {
					const interrupted = foreground.interrupt();
					if (interrupted) {
						foreground.updatedAt = Date.now();
						foreground.currentActivityState = undefined;
						return {
							content: [{ type: "text", text: `Interrupt requested for foreground run ${foreground.runId}.` }],
							details: { mode: "management", results: [] },
						};
					}
					return {
						content: [{ type: "text", text: `Foreground run ${foreground.runId} has no active child step to interrupt.` }],
						isError: true,
						details: { mode: "management", results: [] },
					};
				}
				const asyncInterruptResult = interruptAsyncRun(deps.state, deps.childRegistry, targetRunId);
				if (asyncInterruptResult) return asyncInterruptResult;
				return {
					content: [{ type: "text", text: "No interrupt-capable run found in this session." }],
					isError: true,
					details: { mode: "management", results: [] },
				};
			}
			if (params.action === "resume") {
				const resumeCwd = paramsWithResolvedCwd.cwd ?? requestCwd;
				const scope: AgentScope = resolveExecutionAgentScope(paramsWithResolvedCwd.agentScope);
				const agents = deps.discoverAgents(resumeCwd, scope, { preset: paramsWithResolvedCwd.preset, includeInternal: true }).agents;
				// async omitted => follow the host default; async:false => foreground; async:true => background.
				const resumeAsyncMode = paramsWithResolvedCwd.async ?? deps.asyncByDefault;
				const resumeData: ExecutionContextData = {
					params: paramsWithResolvedCwd,
					effectiveCwd: resumeCwd,
					ctx,
					signal,
					onUpdate,
					agents,
					runId: paramsWithResolvedCwd.id!,
					rootRunId: paramsWithResolvedCwd.id!,
					shareEnabled: false,
					sessionRoot: "",
					sessionDirForIndex: () => "",
					sessionFileForIndex: () => undefined,
					artifactConfig: { ...DEFAULT_ARTIFACT_CONFIG, enabled: false },
					artifactsDir: deps.tempArtifactsDir,
					backgroundRequestedWhileClarifying: false,
					effectiveAsync: resumeAsyncMode,
					controlConfig: resolveControlConfig(deps.config.control, paramsWithResolvedCwd.control),
					intercomBridge: resolveIntercomBridge({ config: deps.config.intercomBridge, context: paramsWithResolvedCwd.context, orchestratorTarget: undefined }),
				};
				// Bare resume (async omitted) follows the host's asyncByDefault, exactly
				// like normal dispatch (see requestedAsync below) — so the two surfaces
				// share one mode default instead of resume hard-defaulting to async.
				return resumeRun(deps.state, deps.childRegistry, paramsWithResolvedCwd.id!, paramsWithResolvedCwd.message!, resumeAsyncMode, resumeData, deps);
			}
			if (!(ALLOWED_CONTROL_ACTIONS as readonly string[]).includes(params.action)) {
				return validationError(`Unknown action: ${params.action}. Allowed actions: ${ALLOWED_CONTROL_ACTIONS.join(", ")}.`);
			}
			return handleManagementAction(params.action, paramsWithResolvedCwd as { action?: string; agent?: string; chainName?: string; agentScope?: string; includeInternal?: boolean; config?: unknown; preset?: string }, { ...ctx, cwd: requestCwd });
		}

		const runNormalized = internal
			? { params: paramsWithResolvedCwd }
			: normalizeRunDispatchParams(paramsWithResolvedCwd);
		if (runNormalized.error) return runNormalized.error;
		const dispatchParams = runNormalized.params!;

		const { blocked, depth, maxDepth } = checkSubagentDepth(deps.config.maxSubagentDepth);
		if (blocked) {
			return {
				content: [
					{
						type: "text",
						text:
							`Nested subagent call blocked (depth=${depth}, max=${maxDepth}). ` +
							"You are running at the maximum subagent nesting depth. " +
							"Complete your current task directly without delegating to further subagents.",
					},
				],
				isError: true,
				details: { mode: "single" as const, results: [] },
			};
		}

		const normalized = normalizeRepeatedParallelCounts(dispatchParams);
		if (normalized.error) return normalized.error;
		const normalizedParams = normalized.params!;

		const nestedGuard = checkNestedDelegationGuard(collectRequestedAgentNames(normalizedParams));
		if (nestedGuard.blocked) {
			return buildRequestedModeError(normalizedParams, nestedGuard.reason ?? "Nested subagent call blocked.");
		}

		const effectiveParams = applyForceTopLevelAsyncOverride(
			normalizedParams,
			depth,
			deps.config.forceTopLevelAsync === true,
		);

		const scope: AgentScope = resolveExecutionAgentScope(effectiveParams.agentScope);
		const effectiveCwd = effectiveParams.cwd ?? ctx.cwd;
		const parentSessionFile = ctx.sessionManager.getSessionFile() ?? null;
		deps.state.currentSessionId = ctx.sessionManager.getSessionId() ?? `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const discoveredAgents = deps.discoverAgents(effectiveCwd, scope, { preset: normalizedParams.preset, includeInternal: true }).agents;
		const sessionName = resolveIntercomSessionTarget(deps.pi.getSessionName(), ctx.sessionManager.getSessionId());
		const intercomBridge = resolveIntercomBridge({
			config: deps.config.intercomBridge,
			context: effectiveParams.context,
			orchestratorTarget: sessionName,
		});
		const executionAgents = effectiveParams.rawAgentConfig
			? [...discoveredAgents.filter((agent) => agent.name !== effectiveParams.rawAgentConfig?.name), effectiveParams.rawAgentConfig]
			: discoveredAgents;
		const agents = intercomBridge.active
			? executionAgents.map((agent) => applyIntercomBridgeToAgent(agent, intercomBridge))
			: executionAgents;
		let runId: string = randomUUID();
		const shareEnabled = effectiveParams.share === true;

		// Expand shared message into legacy tasks (swarm-style dispatch). `prompt`
		// remains only for internal/legacy bridge callers; slim tool callers use `message`.
		const sharedMessage = effectiveParams.message ?? effectiveParams.prompt;
		if (sharedMessage && effectiveParams.tasks && effectiveParams.tasks.length > 0) {
			const template = sharedMessage;
			const placeholderCount = (template.match(/\{in\}/g) ?? []).length;
			if (placeholderCount > 1) {
				return {
					content: [{ type: "text", text: `message contains ${placeholderCount} occurrences of {in}; only one is allowed.` }],
					isError: true,
					details: { mode: "parallel" as const, results: [] },
				};
			}
			effectiveParams.tasks = effectiveParams.tasks.map((task) => ({
				...task,
				task: applySharedMessage(template, task.task),
			}));
			effectiveParams.message = undefined;
			effectiveParams.prompt = undefined;
		}

		const hasChain = (effectiveParams.chain?.length ?? 0) > 0;
		const hasTasks = (effectiveParams.tasks?.length ?? 0) > 0;
		const hasSingle = !hasChain && !hasTasks && Boolean(effectiveParams.agent);
		const allowClarifyTaskPrompt = hasChain
			&& effectiveParams.clarify === true
			&& ctx.hasUI
			&& !(effectiveParams.chain?.some(isParallelStep) ?? false);

		const executionValidationError = validateExecutionInput(
			effectiveParams,
			agents,
			hasChain,
			hasTasks,
			hasSingle,
			allowClarifyTaskPrompt,
		);
		if (executionValidationError) return executionValidationError;

		let sessionFileForIndex: (idx?: number) => string | undefined = () => undefined;
		let forkReuse: ForkReuseConfig | undefined;
		try {
			forkReuse = resolveForkReuse(effectiveParams, ctx, deps);
			sessionFileForIndex = createForkContextResolver(ctx.sessionManager as unknown as Parameters<typeof createForkContextResolver>[0], effectiveParams.context).sessionFileForIndex;
		} catch (error) {
			return toExecutionErrorResult(effectiveParams, error);
		}
		const requestedAsync = effectiveParams.async ?? deps.asyncByDefault;
		// Async dispatch is only allowed from the host session. A child session (in-process
		// subagent) has no UI to surface its async runs, no notify wake target separate
		// from the host, and no lifecycle owner to await descendants. Reject early.
		//
		// Detection: `isInsideChildSession()` catches the brief activate-construction
		// window (when the executor is created before the prompt loop runs). For the
		// normal case — child's prompt loop calling the subagent tool — we look up
		// lineage by the current session id. Children have role==='child'; the host
		// has role==='host'; an unknown session falls through as 'not a child'.
		const currentSid = ctx.sessionManager.getSessionId();
		const currentLineage = currentSid ? getLineageForSession(currentSid) : null;
		const dispatchedFromChild = isInsideChildSession() || currentLineage?.role === "child";
		if (requestedAsync && dispatchedFromChild) {
			const mode: "single" | "parallel" | "chain" = hasChain ? "chain" : hasTasks ? "parallel" : "single";
			return {
				content: [{
					type: "text",
					text: "Async dispatch is only allowed from the host session. Sub-subagents must be synchronous; retry without async:true.",
				}],
				isError: true,
				details: { mode, results: [] },
			};
		}
		const backgroundRequestedWhileClarifying = hasTasks && requestedAsync && effectiveParams.clarify === true;
		// async:true only downgrades to sync when clarify is explicitly true (interactive
		// preview gates the run). Undefined clarify means "no clarify", so it must not
		// suppress async — single/parallel/chain all share this rule.
		const effectiveAsync = requestedAsync && effectiveParams.clarify !== true;
		const controlConfig = resolveControlConfig(deps.config.control, effectiveParams.control);

		const artifactConfig: ArtifactConfig = {
			...DEFAULT_ARTIFACT_CONFIG,
			enabled: effectiveParams.artifacts !== false,
		};
		const artifactsDir = effectiveAsync ? deps.tempArtifactsDir : getArtifactsDir(parentSessionFile);
		const foregroundMode: "single" | "parallel" | "chain" = hasChain ? "chain" : hasTasks ? "parallel" : "single";
		// Compute run-level label and per-step labels for foreground runs so the
		// dashboard's sync-run summary mirrors what the async tracker writes to
		// status.json. Run-level label applies for single runs and uniform-label parallel
		// runs; otherwise per-step labels carry the meaning.
		const foregroundAgentLabels: string[] | undefined = hasTasks && effectiveParams.tasks
			? effectiveParams.tasks.map((t) => t.label ?? "")
			: hasChain && effectiveParams.chain
				? effectiveParams.chain.flatMap((step) => {
					if (isParallelStep(step)) return step.parallel.map((t) => t.label ?? "");
					return [(step as SequentialStep).label ?? ""];
				})
				: undefined;
		// Run-level label precedence: top-level params.label wins over per-step inference;
		// single -> step label; parallel/chain with uniform per-step labels -> shared label.
		let foregroundRunLabel: string | undefined;
		if (effectiveParams.label) {
			foregroundRunLabel = effectiveParams.label;
		} else if (foregroundMode === "single") {
			foregroundRunLabel = foregroundAgentLabels?.[0] || undefined;
		} else if (foregroundAgentLabels && foregroundAgentLabels.length > 0) {
			const first = foregroundAgentLabels[0];
			if (first && foregroundAgentLabels.every((l) => l === first)) foregroundRunLabel = first;
		}
		const parentRunId = resolveDispatchParentRunId(ctx);
		let rootRunId = resolveDispatchRootRunId(ctx, runId);
		const foregroundGroup = !effectiveAsync && foregroundMode === "parallel"
			? openGroup({
				cwd: effectiveCwd,
				...(rootRunId !== runId ? { rootRunId } : {}),
				notifyPolicy: batchToNotifyPolicy(effectiveParams.batch),
				...(foregroundRunLabel ? { label: foregroundRunLabel } : {}),
				...(parentRunId ? { parentRunId } : {}),
				...(effectiveParams.sessionDir ? { sessionDir: path.resolve(deps.expandTilde(effectiveParams.sessionDir)) } : {}),
				...(deps.config.defaultSessionDir ? { defaultSessionDir: path.resolve(deps.expandTilde(deps.config.defaultSessionDir)) } : {}),
				parentSessionFile,
				...(ctx.sessionManager?.getSessionId ? { parentSessionId: ctx.sessionManager.getSessionId() } : {}),
				...(() => {
					const root = resolveDispatchRootSessionId(ctx);
					return root ? { rootSessionId: root } : {};
				})(),
				source: "sync",
				mode: "parallel",
			})
			: undefined;
		if (foregroundGroup) {
			rootRunId = rootRunId === runId ? foregroundGroup.runId : rootRunId;
			runId = foregroundGroup.runId;
		}

	let sessionRoot: string;
	if (foregroundGroup) {
		sessionRoot = foregroundGroup.runRecordDir;
	} else if (effectiveParams.sessionDir) {
		sessionRoot = path.resolve(deps.expandTilde(effectiveParams.sessionDir));
	} else {
		sessionRoot = resolveChildSessionFile({
			parentCwd: effectiveCwd,
			parentSessionFile,
			runId,
			stepIndex: 0,
			...(deps.config.defaultSessionDir ? { defaultSessionDir: path.resolve(deps.expandTilde(deps.config.defaultSessionDir)) } : {}),
		}).sessionRoot;
	}
		try {
			fs.mkdirSync(sessionRoot, { recursive: true });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return toExecutionErrorResult(
				effectiveParams,
				new Error(`Failed to create session directory '${sessionRoot}': ${message}`),
			);
		}
		const sessionDirForIndex = (idx?: number) =>
			path.join(sessionRoot, `run-${idx ?? 0}`);
		const childSessionFileForIndex = (idx?: number) =>
			sessionFileForIndex(idx) ?? path.join(sessionDirForIndex(idx), "session.jsonl");

		const onUpdateWithContext = onUpdate
			? (r: AgentToolResult<Details>) => onUpdate(withForkContext(r, effectiveParams.context))
			: undefined;

		const execData: ExecutionContextData = {
			params: effectiveParams,
			effectiveCwd,
			ctx,
			signal,
			onUpdate: onUpdateWithContext,
			agents,
			runId,
			rootRunId,
			shareEnabled,
			sessionRoot,
			sessionDirForIndex,
			sessionFileForIndex: childSessionFileForIndex,
			artifactConfig,
			artifactsDir,
			backgroundRequestedWhileClarifying,
			effectiveAsync,
			controlConfig,
			intercomBridge,
			forkReuse,
		};

		const foregroundControl = effectiveAsync
			? undefined
			: {
				runId,
				asyncDir: sessionRoot,
				...(parentRunId ? { parentRunId } : {}),
				mode: foregroundMode,
				startedAt: Date.now(),
				updatedAt: Date.now(),
				...(foregroundRunLabel ? { label: foregroundRunLabel } : {}),
				...(foregroundAgentLabels && foregroundAgentLabels.some((l) => l) ? { agentLabels: foregroundAgentLabels } : {}),
				currentAgent: undefined,
				currentIndex: undefined,
				currentActivityState: undefined,
				interrupt: undefined,
			};
		if (foregroundControl) {
			deps.state.foregroundControls.set(runId, foregroundControl);
			deps.state.lastForegroundControlId = runId;
			if (foregroundMode !== "parallel") {
			const stepsRaw: Omit<SyncRunStepInit, "sessionFile">[] = hasTasks && effectiveParams.tasks
				? effectiveParams.tasks.map((task) => ({ agent: task.agent, task: task.task, ...(task.label ? { label: task.label } : {}) }))
				: hasChain && effectiveParams.chain
					? effectiveParams.chain.flatMap((step) => isParallelStep(step)
						? step.parallel.map((task) => ({ agent: task.agent, task: task.task, ...(task.label ? { label: task.label } : {}) }))
						: [{ agent: (step as SequentialStep).agent, task: (step as SequentialStep).task ?? effectiveParams.task ?? "", ...((step as SequentialStep).label ? { label: (step as SequentialStep).label } : {}) }])
					: [{ agent: effectiveParams.agent ?? "subagent", task: effectiveParams.task ?? "", ...(effectiveParams.label ? { label: effectiveParams.label } : {}) }];
			// Attach per-step sessionFile so the right-pane transcript reader can find
			// the session.jsonl. Use the canonical path under <runRecordDir>/run-<idx>/
			// rather than sessionFileForIndex — for fork-reuse the latter returns a
			// pi-managed branch path elsewhere, while the in-process executor opens
			// the canonical path (seeded from the branch source).
			const steps: SyncRunStepInit[] = stepsRaw.map((step, idx) => ({
				...step,
				sessionFile: path.join(sessionDirForIndex(idx), "session.jsonl"),
			}));
			writeSyncRunStatusStart(runId, {
				mode: foregroundMode,
				startedAt: foregroundControl.startedAt,
				cwd: effectiveCwd,
				...(foregroundRunLabel ? { label: foregroundRunLabel } : {}),
				...(parentRunId ? { parentRunId } : {}),
				steps,
			}, sessionRoot);
			appendRunEntry({
				runId,
				runRecordDir: sessionRoot,
				mode: foregroundMode,
				source: "sync",
				...(foregroundMode === "single" ? { agentName: steps[0]?.agent } : { agentNames: steps.map((s) => s.agent) }),
				...(foregroundRunLabel ? { label: foregroundRunLabel } : {}),
				...(parentRunId ? { parentRunId } : {}),
				rootRunId,
				...(ctx.sessionManager?.getSessionId ? { parentSessionId: ctx.sessionManager.getSessionId() } : {}),
				...(() => {
					const root = resolveDispatchRootSessionId(ctx);
					return root ? { rootSessionId: root } : {};
				})(),
				cwd: effectiveCwd,
				startedAt: foregroundControl.startedAt,
			});
			}
		}

		let executionResult: AgentToolResult<Details> | undefined;
		try {
			const asyncResult = runAsyncPath(execData, deps);
			if (asyncResult) return withForkContext(asyncResult, effectiveParams.context);

			if (hasChain && effectiveParams.chain) {
				executionResult = withForkContext(await runChainPath(execData, deps), effectiveParams.context);
				return executionResult;
			}

			if (hasTasks && effectiveParams.tasks) {
				executionResult = withForkContext(await runParallelPath(execData, deps), effectiveParams.context);
				return executionResult;
			}

			if (hasSingle) {
				executionResult = withForkContext(await runSinglePath(execData, deps), effectiveParams.context);
				return executionResult;
			}
		} catch (error) {
			executionResult = toExecutionErrorResult(normalizedParams, error);
			return executionResult;
		} finally {
			if (foregroundControl) {
				if (foregroundMode !== "parallel") {
					writeSyncRunStatusEnd(runId, {
						state: executionResult?.isError ? "failed" : "complete",
						steps: executionResult?.details?.results?.map((result) => ({
							status: result.exitCode === 0 ? "complete" : "failed",
							tokens: tokenUsageFromResult(result),
							durationMs: result.progressSummary?.durationMs,
							error: result.error,
						})) ?? [],
					}, sessionRoot);
				}
				deps.state.foregroundControls.delete(runId);
				if (deps.state.lastForegroundControlId === runId) {
					deps.state.lastForegroundControlId = null;
				}
			}
		}

		return withForkContext({
			content: [{ type: "text", text: "Invalid params" }],
			isError: true,
			details: { mode: "single" as const, results: [] },
		}, effectiveParams.context);
	};

	return {
		execute: (id, params, signal, onUpdate, ctx) => executeImpl(id, params as InternalSubagentParams, signal, onUpdate, ctx, false),
		executeInternal: (id, params, signal, onUpdate, ctx) => executeImpl(id, params, signal, onUpdate, ctx, true),
	};
}
