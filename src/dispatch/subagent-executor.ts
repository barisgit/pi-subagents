import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message, Model } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
	AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { type AgentConfig, type AgentScope, resolveAgentColor } from "../shared/agents.ts";
import {
	ensureArtifactsDir,
	getArtifactPaths,
	getArtifactsDir,
	writeArtifact,
	writeMetadata,
} from "../shared/artifacts.ts";
import { resolveExecutionAgentScope } from "./agent-scope.ts";
import { handleManagementAction } from "../surfaces/agent-management.ts";
import { normalizeAvailableModels, resolveModelCandidate } from "./model-fallback.ts";
import { recordRun } from "../state/run-history.ts";
import { resolveStepBehavior } from "../shared/settings.ts";
import { discoverAvailableSkills, normalizeSkillInput } from "../shared/skills.ts";
import { createForkContextResolver } from "./fork-context.ts";
import {
	type ChildAgentHandle,
	type ChildAgentResult,
	type ChildAgentStep,
	type StatusPatch,
	type ChildAgentRegistry,
	dispatchAsyncChild,
	runChildAgent,
} from "./in-process-executor.ts";
import { parkLeafPermit } from "./leaf-concurrency.ts";
import { prepareChildStep } from "./prepare-child-step.ts";
import type {
	AsyncDispatchStep,
	ExecutionContextData,
	ExecutorDeps,
	ForegroundControlRef,
	InternalSubagentParams,
	TaskParam,
} from "./executor-types.ts";
export type {
	AsyncDispatchStep,
	ExecutionContextData,
	ExecutorDeps,
	ForegroundControlRef,
	ModelInfo,
	TaskParam,
} from "./executor-types.ts";
import {
	addUsageInto,
	applyForegroundProgress,
	asyncStartedResult,
	batchToNotifyPolicy,
	buildAsyncAggregateCompletePayload,
	buildParallelModeError,
	buildParallelWorktreeTaskCwdError,
	createForegroundControlNotifier,
	emitRunAnchor,
	emitSyncLifecycleEvent,
	emptyUsage,
	getRequestedModeLabel,
	interruptForegroundOnNeedsAttention,
	mirrorForegroundProgressToStatus,
	resolveChildTools,
	resolveDispatchParentRunId,
	resolveDispatchRootRunId,
	resolveDispatchRootSessionId,
	safeEmit,
	singleResultToChildAgentResult,
	sumUsages,
	tokenUsageFromResult,
	validationError,
} from "./executor-helpers.ts";
export {
	addUsageInto,
	applyForegroundProgress,
	asyncStartedResult,
	batchToNotifyPolicy,
	buildParallelModeError,
	buildParallelWorktreeTaskCwdError,
	createForegroundControlNotifier,
	emitRunAnchor,
	emitSyncLifecycleEvent,
	emptyUsage,
	getRequestedModeLabel,
	interruptForegroundOnNeedsAttention,
	mirrorForegroundProgressToStatus,
	resolveChildTools,
	resolveDispatchParentRunId,
	resolveDispatchRootRunId,
	resolveDispatchRootSessionId,
	safeEmit,
	singleResultToChildAgentResult,
	sumUsages,
	tokenUsageFromResult,
	validationError,
} from "./executor-helpers.ts";
import { buildAsyncChildStep, runInProcessChildStep } from "./child-step-runner.ts";
export { buildAsyncChildStep, runInProcessChildStep } from "./child-step-runner.ts";
import {
	applyIntercomBridgeToAgent,
	resolveIntercomBridge,
	resolveIntercomSessionTarget,
	resolveSubagentIntercomTarget,
	type IntercomBridgeState,
} from "./intercom-bridge.ts";
import {
	createActivityTicker,
	formatControlIntercomMessage,
	formatControlInterruptReason,
	formatControlNoticeMessage,
	resolveControlConfig,
	shouldNotifyControlEvent,
} from "./subagent-control.ts";
import {
	captureSingleOutputSnapshot,
	finalizeSingleOutput,
	injectSingleOutputInstruction,
	resolveSingleOutput,
	resolveSingleOutputPath,
} from "../surfaces/single-output.ts";
import { createSubmitResultTool, SUBMIT_RESULT_TOOL_NAME } from "../protocol/submit-result.ts";
import { resolveChildSessionFile } from "../state/session-paths.ts";
import type { StatusWriter } from "../state/status-writer.ts";
import { ASYNC_NO_POLL_GUIDANCE, formatAsyncStatusHint } from "../surfaces/async-guidance.ts";
import { formatRunHandle, type RunMode } from "../state/run-shape.ts";
import {
	compactForegroundDetails,
	extractTextFromContent,
	getFinalOutput,
	getSingleResultOutput,
	readStatus,
	resolveChildCwd,
} from "../shared/utils.ts";
import { tokenUsageFromTotal, tokenUsageFromUsage, totalUsageTokens } from "../state/usage-totals.ts";
import { inspectSubagentStatus } from "../state/run-status.ts";
import { applyForceTopLevelAsyncOverride } from "./top-level-async.ts";
import { readAllEntries, type RunsRegistryEntry } from "../state/runs-registry.ts";
import { evictCompletionDedupeForRunId } from "../state/completion-dedupe.ts";
import {
	interruptRun,
	spawnRun,
	openGroup,
	awaitRun,
	openRunRecord,
	finalizeRun,
	type OpenRunHandle,
} from "./layer0-runs.ts";
import { logger } from "../shared/logger.ts";
import { getCurrentPi } from "../shared/current-pi.ts";
import { getLineageForSession, resolveRootSessionIdForSession } from "../state/lineage.ts";
import type { SubagentToolInput, Step, Task } from "../protocol/schemas.ts";
import type { WorkflowGroupHandle } from "../workflow/workflow.ts";
import { writeWorkflowGroupState } from "../workflow/workflow-group-state.ts";
import { findWorktreeTaskCwdConflict, formatWorktreeTaskCwdConflict } from "./worktree.ts";
import { createForegroundRunController } from "./foreground-run-controller.ts";
import { resumeRun } from "./resume-run.ts";
import { runAsyncPath } from "./run-async-path.ts";
import { runParallelPath } from "./run-parallel-path.ts";
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
	isInsideChildSession,
	resolveTopLevelParallelMaxTasks,
	resolveChildMaxSubagentDepth,
	truncateOutput,
	wrapForkTask,
} from "../protocol/types.ts";
import {
	checkNestedDelegationGuard,
	checkSubagentDepth,
	resolveCurrentMaxSubagentDepth,
} from "../shared/runtime-env.ts";
export type { SubagentToolInput, Step, Task };
export type { SubagentToolInput as SubagentParamsLike };
function resolveRequestedCwd(runtimeCwd: string, requestedCwd: string | undefined): string {
	return requestedCwd ? path.resolve(runtimeCwd, requestedCwd) : runtimeCwd;
}
type ForegroundControl = SubagentState["foregroundControls"] extends Map<string, infer T> ? T : never;

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
function formatForegroundActivity(
	control: SubagentState["foregroundControls"] extends Map<string, infer T> ? T : never,
): string | undefined {
	if (control.currentTool && control.currentToolStartedAt) {
		return `tool ${control.currentTool} for ${Math.floor(Math.max(0, Date.now() - control.currentToolStartedAt) / 1000)}s`;
	}
	if (!control.lastActivityAt)
		return control.currentActivityState === "needs_attention" ? "needs attention" : undefined;
	const seconds = Math.floor(Math.max(0, Date.now() - control.lastActivityAt) / 1000);
	return control.currentActivityState === "needs_attention"
		? `no activity for ${seconds}s`
		: `active ${seconds}s ago`;
}
const SLIM_TOP_LEVEL_KEYS = new Set(["run", "async", "batch", "worktree", "message", "action", "id"]);
const SLIM_TASK_KEYS = new Set(["agent", "task", "label", "context", "output"]);
const ALLOWED_CONTROL_ACTIONS = ["list", "status", "interrupt", "resume"] as const;
const REMOVED_CRUD_ACTIONS = new Set(["create", "update", "delete", "get"]);
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
	return isRecord(step) && typeof step.agent === "string" && typeof step.task === "string";
}
function applySharedMessage(message: string, task: string): string {
	if (message === "") return task;
	if (message.includes("{task}") || message.includes("{in}")) {
		return message.replaceAll("{task}", task).replaceAll("{in}", task);
	}
	return `${message}\n\n${task}`;
}
function normalizeRunDispatchParams(params: InternalSubagentParams): {
	params?: InternalSubagentParams;
	error?: AgentToolResult<Details>;
} {
	const slimValidationError = validateSubagentToolInput(params);
	if (slimValidationError) return { error: slimValidationError };
	const input = params as InternalSubagentParams & { run?: unknown[]; message?: string };
	if (!Array.isArray(input.run) || input.run.length === 0) {
		return { error: validationError("`run` must contain at least one task") };
	}
	if (input.message) {
		const placeholderCount = (input.message.match(/\{in\}/g) ?? []).length;
		if (placeholderCount > 1) {
			return {
				error: validationError(
					`message contains ${placeholderCount} occurrences of {in}; only one is allowed.`,
				),
			};
		}
	}
	const firstNestedIndex = input.run.findIndex(Array.isArray);
	if (firstNestedIndex !== -1) {
		return {
			error: validationError(
				"Nested Task[] dispatch is no longer supported; use the workflow tool for orchestration.",
			),
		};
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
			message: undefined,
			prompt: undefined,
		},
	};
}
export function validateSubagentToolInput(input: unknown): AgentToolResult<Details> | null {
	if (!isRecord(input)) return null;
	const action = typeof input.action === "string" ? input.action : undefined;
	if (action && REMOVED_CRUD_ACTIONS.has(action)) {
		return validationError(
			`Author agents as files under agents/<name>.md instead of action:"${action}". Allowed actions: ${ALLOWED_CONTROL_ACTIONS.join(", ")}.`,
		);
	}
	if (action && !(ALLOWED_CONTROL_ACTIONS as readonly string[]).includes(action)) {
		return validationError(`Unknown action: ${action}. Allowed actions: ${ALLOWED_CONTROL_ACTIONS.join(", ")}.`);
	}
	if (action === "resume") {
		if (Object.hasOwn(input, "run")) return validationError("resume is per-run; do not supply `run`");
		if (Object.hasOwn(input, "agent"))
			return validationError("resume takes only `message`; do not supply `agent` or Task");
		if (!Object.hasOwn(input, "id")) return validationError("resume requires `id` (runId)");
		if (!Object.hasOwn(input, "message")) return validationError("resume requires `message` to send to the child");
	}
	const unknownKey = Object.keys(input).find((key) => !SLIM_TOP_LEVEL_KEYS.has(key));
	if (unknownKey) {
		if (unknownKey === "prompt")
			return validationError("Unknown top-level key 'prompt'; `prompt` renamed to `message`.");
		return validationError(`Unknown top-level key '${unknownKey}'.`);
	}
	if (!Array.isArray(input.run)) return null;
	if (input.run.length === 0) return validationError("`run` must contain at least one task");
	for (let i = 0; i < input.run.length; i++) {
		const step = input.run[i];
		if (Array.isArray(step)) {
			if (input.parallel !== true)
				return validationError(
					"Nested Task[] dispatch is no longer supported; use the workflow tool for orchestration.",
				);
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
function foregroundStatusResult(
	control: SubagentState["foregroundControls"] extends Map<string, infer T> ? T : never,
): AgentToolResult<Details> {
	const lines = [
		`Run: ${control.runId}`,
		"State: running",
		`Mode: ${control.mode}`,
		control.currentAgent
			? `Current: ${control.currentAgent}${control.currentIndex !== undefined ? ` step ${control.currentIndex + 1}` : ""}`
			: undefined,
		formatForegroundActivity(control) ? `Activity: ${formatForegroundActivity(control)}` : undefined,
	].filter((line): line is string => Boolean(line));
	return { content: [{ type: "text", text: lines.join("\n") }], details: { mode: "management", results: [] } };
}
function getAsyncInterruptTarget(
	state: SubagentState,
	runId: string | undefined,
): { asyncId: string; asyncDir: string } | undefined {
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
function interruptAsyncRun(
	state: SubagentState,
	childRegistry: ChildAgentRegistry,
	runId: string | undefined,
): AgentToolResult<Details> | null {
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
			content: [
				{
					type: "text",
					text: `Interrupt requested for run ${target.asyncId} (${abortedChildRunIds.length} descendant run(s): ${abortedChildRunIds.join(", ")}).`,
				},
			],
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
function validateExecutionInput(
	params: InternalSubagentParams,
	agents: AgentConfig[],
	hasTasks: boolean,
	hasSingle: boolean,
): AgentToolResult<Details> | null {
	if (Number(hasTasks) + Number(hasSingle) !== 1) {
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
	return null;
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
		return params
			.tasks!.map((task) =>
				typeof task === "object" && task && !Array.isArray(task) ? normalizeName(task.agent) : undefined,
			)
			.filter((agent): agent is string => Boolean(agent));
	}
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
	const currentAgentName =
		normalizeName(process.env.PI_SUBAGENT_CURRENT_AGENT) ??
		normalizeName(deps.getActiveRootRoleName?.()) ??
		(uniqueRequested.length === 1 ? normalizeName(uniqueRequested[0]) : undefined);
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
function normalizeRepeatedParallelCounts(params: InternalSubagentParams): {
	params?: InternalSubagentParams;
	error?: AgentToolResult<Details>;
} {
	if (params.tasks) {
		const expandedTasks = expandTopLevelTaskCounts(params.tasks);
		if (expandedTasks.error) {
			return { error: buildRequestedModeError(params, expandedTasks.error) };
		}
		return { params: { ...params, tasks: expandedTasks.tasks } };
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
	const childIntercomTarget = data.intercomBridge.active
		? resolveSubagentIntercomTarget(runId, params.agent!, undefined)
		: undefined;
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
	const availableModels = normalizeAvailableModels(ctx.modelRegistry.getAvailable());
	let task = params.task ?? "";
	const modelOverride: string | undefined = resolveModelCandidate(
		(params.model as string | undefined) ?? agentConfig.model,
		availableModels,
		currentProvider,
	);
	const skillOverride: string[] | false | undefined = normalizeSkillInput(params.skill);
	const rawOutput = params.output !== undefined ? params.output : agentConfig.output;
	const effectiveOutput: string | false | undefined =
		rawOutput === true ? agentConfig.output : (rawOutput as string | false | undefined);
	const currentMaxSubagentDepth = resolveCurrentMaxSubagentDepth(deps.config.maxSubagentDepth);
	const maxSubagentDepth = resolveChildMaxSubagentDepth(currentMaxSubagentDepth, agentConfig.maxSubagentDepth);

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
	const fg = createForegroundRunController(foregroundControl, {
		mirror: (firstProgress, index) => {
			const liveStepTokens = tokenUsageFromTotal(firstProgress?.tokens);
			mirrorForegroundProgressToStatus(
				data.foregroundStatusWriter,
				firstProgress,
				index,
				[
					{
						agent: firstProgress?.agent ?? params.agent!,
						status: firstProgress?.status ?? "running",
						startedAt: firstProgress?.lastActivityAt,
						lastActivityAt: firstProgress?.lastActivityAt,
						currentTool: firstProgress?.currentTool,
						currentToolStartedAt: firstProgress?.currentToolStartedAt,
						...(liveStepTokens ? { tokens: liveStepTokens } : {}),
					},
				],
				foregroundControl?.executionStartedAt,
			);
		},
	});
	fg.beginStep(params.agent!, 0, (reason?: string) => {
		if (interruptController.signal.aborted) return false;
		interruptController.abort(reason ?? "interrupt requested");
		foregroundControl!.currentActivityState = undefined;
		foregroundControl!.updatedAt = Date.now();
		return true;
	});

	const forwardSingleUpdate =
		onUpdate || foregroundControl
			? (update: AgentToolResult<Details>) => {
					const firstProgress = update.details?.progress?.[0];
					fg.applyProgress(
						params.agent!,
						firstProgress?.index ?? 0,
						firstProgress,
						update.details?.results?.[0]?.finalOutput,
					);
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
	// Opened "queued": this fires BEFORE runInProcessChildStep reaches
	// acquireLeafPermit, so the child may still be blocked on the leaf pool. The
	// run + step flip to "running" via the foreground progress mirror once the
	// child actually begins its first step (after the permit is granted).
	data.foregroundStatusWriter?.mergePatch(
		{
			currentStep: 0,
			steps: [{ agent: params.agent!, status: "queued", startedAt: Date.now(), lastActivityAt: Date.now() }],
		},
		{ flush: true },
	);
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
	fg.finalizeStep(0, { progress: r.progress, finalOutput: r.finalOutput });
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
			content: [
				{
					type: "text",
					text: `Run paused after interrupt (${params.agent}). Waiting for explicit next action.`,
				},
			],
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
	openWorkflowGroup: (args: {
		toolCallId: string;
		signal: AbortSignal;
		onUpdate?: (r: AgentToolResult<Details>) => void;
		ctx: ExtensionContext;
		requestedAsync?: boolean;
	}) => WorkflowGroupHandle;
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
				const foreground = getForegroundControl(
					deps.state,
					paramsWithResolvedCwd.id ?? paramsWithResolvedCwd.runId,
				);
				if (foreground) return foregroundStatusResult(foreground);
				// Auto-scope the no-id list to the current session's tree (matches the
				// /subagents-status overlay) so `subagent({ action: "status" })` doesn't
				// dump every entry in runs-index.jsonl across every project ever spawned.
				const statusSessionId = resolveDispatchRootSessionId(ctx, deps.state.currentSessionId ?? undefined);
				return inspectSubagentStatus({
					...(paramsWithResolvedCwd as {
						action?: "status";
						id?: string;
						runId?: string;
						dir?: string;
						cwd?: string;
						includeProgress?: boolean;
						includeCompleted?: boolean;
					}),
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
							content: [
								{ type: "text", text: `Interrupt requested for foreground run ${foreground.runId}.` },
							],
							details: { mode: "management", results: [] },
						};
					}
					return {
						content: [
							{
								type: "text",
								text: `Foreground run ${foreground.runId} has no active child step to interrupt.`,
							},
						],
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
				const agents = deps.discoverAgents(resumeCwd, scope, {
					preset: paramsWithResolvedCwd.preset,
					includeInternal: true,
				}).agents;
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
					intercomBridge: resolveIntercomBridge({
						config: deps.config.intercomBridge,
						context: paramsWithResolvedCwd.context,
						orchestratorTarget: undefined,
					}),
				};
				// Bare resume (async omitted) follows the host's asyncByDefault, exactly
				// like normal dispatch (see requestedAsync below) — so the two surfaces
				// share one mode default instead of resume hard-defaulting to async.
				// A nested foreground resume blocks the calling agent (which holds a leaf
				// permit) while it awaits the resumed child, so park that permit for the
				// span — same deadlock-avoidance rule as fresh nested dispatch. Async
				// resume returns immediately, making the park a trivial no-op span.
				const resumeParentRunId = resolveDispatchParentRunId(ctx);
				return parkLeafPermit(resumeParentRunId, () =>
					resumeRun(
						deps.state,
						deps.childRegistry,
						paramsWithResolvedCwd.id!,
						paramsWithResolvedCwd.message!,
						resumeAsyncMode,
						resumeData,
						deps,
					),
				);
			}
			if (!(ALLOWED_CONTROL_ACTIONS as readonly string[]).includes(params.action)) {
				return validationError(
					`Unknown action: ${params.action}. Allowed actions: ${ALLOWED_CONTROL_ACTIONS.join(", ")}.`,
				);
			}
			return handleManagementAction(
				params.action,
				paramsWithResolvedCwd as {
					action?: string;
					agent?: string;
					agentScope?: string;
					includeInternal?: boolean;
					config?: unknown;
					preset?: string;
				},
				{ ...ctx, cwd: requestCwd },
			);
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
		deps.state.currentSessionId =
			ctx.sessionManager.getSessionId() ?? `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const discoveredAgents = deps.discoverAgents(effectiveCwd, scope, {
			preset: normalizedParams.preset,
			includeInternal: true,
		}).agents;
		const sessionName = resolveIntercomSessionTarget(deps.pi.getSessionName(), ctx.sessionManager.getSessionId());
		const intercomBridge = resolveIntercomBridge({
			config: deps.config.intercomBridge,
			context: effectiveParams.context,
			orchestratorTarget: sessionName,
		});
		const executionAgents = effectiveParams.rawAgentConfig
			? [
					...discoveredAgents.filter((agent) => agent.name !== effectiveParams.rawAgentConfig?.name),
					effectiveParams.rawAgentConfig,
				]
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
					content: [
						{
							type: "text",
							text: `message contains ${placeholderCount} occurrences of {in}; only one is allowed.`,
						},
					],
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

		const hasTasks = (effectiveParams.tasks?.length ?? 0) > 0;
		const hasSingle = !hasTasks && Boolean(effectiveParams.agent);

		const executionValidationError = validateExecutionInput(effectiveParams, agents, hasTasks, hasSingle);
		if (executionValidationError) return executionValidationError;

		let sessionFileForIndex: (idx?: number) => string | undefined = () => undefined;
		let forkReuse: ForkReuseConfig | undefined;
		try {
			forkReuse = resolveForkReuse(effectiveParams, ctx, deps);
			sessionFileForIndex = createForkContextResolver(
				ctx.sessionManager as unknown as Parameters<typeof createForkContextResolver>[0],
				effectiveParams.context,
			).sessionFileForIndex;
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
			const mode: "single" | "parallel" = hasTasks ? "parallel" : "single";
			return {
				content: [
					{
						type: "text",
						text: "Async dispatch is only allowed from the host session. Sub-subagents must be synchronous; retry without async:true.",
					},
				],
				isError: true,
				details: { mode, results: [] },
			};
		}
		const backgroundRequestedWhileClarifying = hasTasks && requestedAsync && effectiveParams.clarify === true;
		// async:true only downgrades to sync when clarify is explicitly true (interactive
		// preview gates the run). Undefined clarify means "no clarify", so it must not
		// suppress async — single/parallel all share this rule.
		const effectiveAsync = requestedAsync && effectiveParams.clarify !== true;
		const controlConfig = resolveControlConfig(deps.config.control, effectiveParams.control);

		const artifactConfig: ArtifactConfig = {
			...DEFAULT_ARTIFACT_CONFIG,
			enabled: effectiveParams.artifacts !== false,
		};
		const artifactsDir = effectiveAsync ? deps.tempArtifactsDir : getArtifactsDir(parentSessionFile);
		const foregroundMode: "single" | "parallel" = hasTasks ? "parallel" : "single";
		// Compute run-level label and per-step labels for foreground runs so the
		// dashboard's sync-run summary mirrors what the async tracker writes to
		// status.json. Run-level label applies for single runs and uniform-label parallel
		// runs; otherwise per-step labels carry the meaning.
		const foregroundAgentLabels: string[] | undefined =
			hasTasks && effectiveParams.tasks ? effectiveParams.tasks.map((t) => t.label ?? "") : undefined;
		// Run-level label precedence: top-level params.label wins over per-step inference;
		// single -> step label; parallel/parallel with uniform per-step labels -> shared label.
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
		const foregroundGroup =
			!effectiveAsync && foregroundMode === "parallel"
				? openGroup({
						cwd: effectiveCwd,
						...(rootRunId !== runId ? { rootRunId } : {}),
						notifyPolicy: batchToNotifyPolicy(effectiveParams.batch),
						...(foregroundRunLabel ? { label: foregroundRunLabel } : {}),
						...(parentRunId ? { parentRunId } : {}),
						...(effectiveParams.sessionDir
							? { sessionDir: path.resolve(deps.expandTilde(effectiveParams.sessionDir)) }
							: {}),
						...(deps.config.defaultSessionDir
							? { defaultSessionDir: path.resolve(deps.expandTilde(deps.config.defaultSessionDir)) }
							: {}),
						parentSessionFile,
						...(ctx.sessionManager?.getSessionId
							? { parentSessionId: ctx.sessionManager.getSessionId() }
							: {}),
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
		if (!effectiveAsync) {
			emitRunAnchor(deps.pi, { runId, rootRunId, mode: foregroundMode, source: "sync", parentRunId });
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
				...(deps.config.defaultSessionDir
					? { defaultSessionDir: path.resolve(deps.expandTilde(deps.config.defaultSessionDir)) }
					: {}),
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
		const sessionDirForIndex = (idx?: number) => path.join(sessionRoot, `run-${idx ?? 0}`);
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
					...(foregroundAgentLabels && foregroundAgentLabels.some((l) => l)
						? { agentLabels: foregroundAgentLabels }
						: {}),
					currentAgent: undefined,
					currentIndex: undefined,
					currentActivityState: undefined,
					interrupt: undefined,
				};
		let fgWriter: StatusWriter | undefined;
		let runHandle: OpenRunHandle | undefined;
		if (foregroundControl) {
			deps.state.foregroundControls.set(runId, foregroundControl);
			deps.state.lastForegroundControlId = runId;
			if (foregroundMode !== "parallel") {
				const stepsRaw: Array<{ agent: string; label?: string; task?: string }> =
					hasTasks && effectiveParams.tasks
						? effectiveParams.tasks.map((task) => ({
								agent: task.agent,
								task: task.task,
								...(task.label ? { label: task.label } : {}),
							}))
						: [
								{
									agent: effectiveParams.agent ?? "subagent",
									task: effectiveParams.task ?? "",
									...(effectiveParams.label ? { label: effectiveParams.label } : {}),
								},
							];
				// Attach per-step sessionFile so the right-pane transcript reader can find
				// the session.jsonl. Use the canonical path under <runRecordDir>/run-<idx>/
				// rather than sessionFileForIndex — for fork-reuse the latter returns a
				// pi-managed branch path elsewhere, while the in-process executor opens
				// the canonical path (seeded from the branch source).
				const steps = stepsRaw.map((step, idx) => ({
					...step,
					sessionFile: path.join(sessionDirForIndex(idx), "session.jsonl"),
				}));
				runHandle = openRunRecord(
					{
						agentName: steps[0]?.agent ?? "subagent",
						task: steps[0]?.task ?? "",
						cwd: effectiveCwd,
						...(foregroundRunLabel ? { label: foregroundRunLabel } : {}),
					},
					{
						runId,
						runRecordDir: sessionRoot,
						...(steps[0]?.sessionFile ? { sessionFile: steps[0].sessionFile } : {}),
						rootRunId,
						...(parentRunId ? { parentRunId } : {}),
						...(ctx.sessionManager?.getSessionId
							? { parentSessionId: ctx.sessionManager.getSessionId() }
							: {}),
						...(() => {
							const root = resolveDispatchRootSessionId(ctx);
							return root ? { rootSessionId: root } : {};
						})(),
						source: "sync",
						variant: "sync-foreground",
						initialize: {
							mode: foregroundMode,
							startedAt: foregroundControl.startedAt,
							runnerHeartbeatAt: foregroundControl.startedAt,
							cwd: effectiveCwd,
							...(foregroundRunLabel ? { label: foregroundRunLabel } : {}),
							...(parentRunId ? { parentRunId } : {}),
							currentStep: 0,
							steps: steps.map((step) => ({
								agent: step.agent,
								...(step.label ? { label: step.label } : {}),
								status: "pending" as const,
								...(step.sessionFile ? { sessionFile: step.sessionFile } : {}),
							})),
						},
					},
				);
				fgWriter = runHandle.statusWriter;
				execData.foregroundStatusWriter = fgWriter;
			}
		}

		let executionResult: AgentToolResult<Details> | undefined;
		try {
			const asyncResult = runAsyncPath(execData, deps);
			if (asyncResult) return withForkContext(asyncResult, effectiveParams.context);

			// A nested (parentRunId-bearing) dispatch runs while the parent agent is
			// mid-prompt and holding a leaf permit. Park that permit for the span we
			// await descendants so a blocked parent never occupies a leaf slot — this
			// is what keeps the one process-wide pool deadlock-free under nesting.
			// Top-level dispatches (no parentRunId) hold no permit, so park is a no-op.
			if (hasTasks && effectiveParams.tasks) {
				executionResult = withForkContext(
					await parkLeafPermit(parentRunId, () => runParallelPath(execData, deps)),
					effectiveParams.context,
				);
				return executionResult;
			}

			if (hasSingle) {
				executionResult = withForkContext(
					await parkLeafPermit(parentRunId, () => runSinglePath(execData, deps)),
					effectiveParams.context,
				);
				return executionResult;
			}
		} catch (error) {
			executionResult = toExecutionErrorResult(normalizedParams, error);
			return executionResult;
		} finally {
			if (foregroundControl) {
				if (foregroundMode !== "parallel" && fgWriter && runHandle) {
					finalizeRun(runHandle, {
						via: "terminal",
						state: executionResult?.isError ? "failed" : "complete",
						steps:
							executionResult?.details?.results?.map((result) => ({
								status: result.exitCode === 0 ? "complete" : "failed",
								tokens: tokenUsageFromResult(result),
								durationMs: result.progressSummary?.durationMs,
								error: result.error,
							})) ?? [],
					});
					fgWriter.dispose();
				}
				deps.state.foregroundControls.delete(runId);
				if (deps.state.lastForegroundControlId === runId) {
					deps.state.lastForegroundControlId = null;
				}
			}
		}

		return withForkContext(
			{
				content: [{ type: "text", text: "Invalid params" }],
				isError: true,
				details: { mode: "single" as const, results: [] },
			},
			effectiveParams.context,
		);
	};

	return {
		execute: (id, params, signal, onUpdate, ctx) =>
			executeImpl(id, params as InternalSubagentParams, signal, onUpdate, ctx, false),
		executeInternal: (id, params, signal, onUpdate, ctx) => executeImpl(id, params, signal, onUpdate, ctx, true),
		openWorkflowGroup: ({ signal, onUpdate, ctx, requestedAsync }) => {
			deps.state.baseCwd = ctx.cwd;
			deps.state.currentSessionId =
				ctx.sessionManager.getSessionId() ??
				deps.state.currentSessionId ??
				`session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
			const effectiveCwd = ctx.cwd;
			const agents = deps.discoverAgents(effectiveCwd, "both", { includeInternal: true }).agents;
			const parentSessionFile = ctx.sessionManager.getSessionFile() ?? null;
			const provisionalRunId = randomUUID();
			const parentRunId = resolveDispatchParentRunId(ctx);
			const rootRunId = resolveDispatchRootRunId(ctx, provisionalRunId);
			const effectiveAsync = requestedAsync ?? deps.asyncByDefault;
			const workflowDetachedAbort = new AbortController();
			const controlConfig = resolveControlConfig(deps.config.control, undefined);
			const group = openGroup({
				cwd: effectiveCwd,
				...(rootRunId !== provisionalRunId ? { rootRunId } : {}),
				notifyPolicy: "each",
				...(parentRunId ? { parentRunId } : {}),
				...(deps.config.defaultSessionDir
					? { defaultSessionDir: path.resolve(deps.expandTilde(deps.config.defaultSessionDir)) }
					: {}),
				parentSessionFile,
				...(ctx.sessionManager?.getSessionId ? { parentSessionId: ctx.sessionManager.getSessionId() } : {}),
				...(() => {
					const root = resolveDispatchRootSessionId(ctx);
					return root ? { rootSessionId: root } : {};
				})(),
				kind: "workflow",
				source: effectiveAsync ? "async" : "sync",
				mode: "parallel",
			});
			const groupRootRunId = rootRunId === provisionalRunId ? group.runId : rootRunId;
			emitRunAnchor(deps.pi, {
				runId: group.runId,
				rootRunId: groupRootRunId,
				mode: "parallel",
				source: effectiveAsync ? "async" : "sync",
				parentRunId,
			});
			const sessionRoot = group.runRecordDir;
			fs.mkdirSync(sessionRoot, { recursive: true });
			if (effectiveAsync) {
				writeWorkflowGroupState(group.runRecordDir, "running");
				// The workflow is ONE entity: give the widget a group row up front.
				// Children also emit STARTED (below) so the tracker can aggregate
				// phase/progress, but the widget renders only this row.
				safeEmit(SUBAGENT_ASYNC_STARTED_EVENT, {
					id: group.runId,
					runId: group.runId,
					metadata: undefined,
					controlConfig,
					kind: "workflow",
					agent: "workflow",
					cwd: effectiveCwd,
					asyncDir: group.runRecordDir,
				});
			}
			const childResults: Array<{ runId: string; result: SingleResult; index: number }> = [];
			const data: ExecutionContextData = {
				params: {},
				effectiveCwd,
				ctx,
				signal: effectiveAsync ? workflowDetachedAbort.signal : signal,
				onUpdate,
				agents,
				runId: group.runId,
				rootRunId: groupRootRunId,
				shareEnabled: false,
				sessionRoot,
				sessionDirForIndex: (idx?: number) => path.join(sessionRoot, `run-${idx ?? 0}`),
				sessionFileForIndex: (idx?: number) => path.join(sessionRoot, `run-${idx ?? 0}`, "session.jsonl"),
				artifactConfig: { ...DEFAULT_ARTIFACT_CONFIG, enabled: true },
				artifactsDir: getArtifactsDir(parentSessionFile),
				backgroundRequestedWhileClarifying: false,
				effectiveAsync,
				controlConfig,
				intercomBridge: resolveIntercomBridge({
					config: deps.config.intercomBridge,
					context: undefined,
					orchestratorTarget: undefined,
				}),
			};
			return {
				groupRunId: group.runId,
				async: effectiveAsync,
				asyncDir: group.runRecordDir,
				// Park the calling agent's leaf permit while a sync workflow awaits its
				// children (no-op for a top-level workflow with no parent permit).
				parkWhileRunning: <T>(fn: () => Promise<T>) => parkLeafPermit(parentRunId, fn),
				dispatchChild: async ({ role, task, index, phaseIndex, phaseTitle, parallelGroupId, resultSchema }) => {
					const agentConfig = agents.find((agent) => agent.name === role);
					let result: SingleResult | undefined;
					const handle = spawnRun(
						{ agentName: role, task, cwd: effectiveCwd },
						{
							parentRunId: group.runId,
							rootRunId: groupRootRunId,
							notifyPolicy: "each",
							parentSessionFile,
							sessionDir: path.join(sessionRoot, `run-${index}`),
							...(phaseIndex !== undefined ? { phaseIndex } : {}),
							...(phaseTitle ? { phaseTitle } : {}),
							...(parallelGroupId ? { parallelGroupId } : {}),
							...(deps.config.defaultSessionDir
								? { defaultSessionDir: path.resolve(deps.expandTilde(deps.config.defaultSessionDir)) }
								: {}),
							...(ctx.sessionManager?.getSessionId
								? { parentSessionId: ctx.sessionManager.getSessionId() }
								: {}),
							...(() => {
								const root = resolveDispatchRootSessionId(ctx);
								return root ? { rootSessionId: root } : {};
							})(),
							source: effectiveAsync ? "async" : "sync",
							runAgent: async (prepared, layer0Ctx) => {
								// Unknown agent: still resolve through a real child run so the group
								// has a FAILED child row to synthesize from (otherwise a statusless
								// group with no child looks complete on the dashboard).
								if (!agentConfig) {
									const error = `Unknown agent: ${role}`;
									result = {
										agent: role,
										task,
										exitCode: 1,
										messages: [],
										usage: emptyUsage(),
										error,
									};
									return {
										runId: prepared.runId,
										stepIndex: 0,
										state: "failed",
										exitCode: 1,
										outputText: error,
										toolCallCount: 0,
										toolResultCount: 0,
										toolErrorCount: 0,
										durationMs: 0,
										startedAt: Date.now(),
										endedAt: Date.now(),
										sessionFile: prepared.sessionFile,
										error: { message: error },
										usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
									};
								}
								result = await runInProcessChildStep({
									data,
									deps,
									agentConfig,
									task,
									cleanTask: task,
									stepIndex: index,
									cwd: effectiveCwd,
									interruptSignal: layer0Ctx.abortSignal,
									maxSubagentDepth: resolveChildMaxSubagentDepth(
										resolveCurrentMaxSubagentDepth(deps.config.maxSubagentDepth),
										agentConfig.maxSubagentDepth,
									),
									mode: "parallel",
									...(resultSchema ? { resultSchema } : {}),
									layer0: {
										runId: prepared.runId,
										runRecordDir: prepared.runRecordDir,
										sessionFile: prepared.sessionFile,
										rootRunId: groupRootRunId,
									},
									onLayer0StatusUpdate: (patch) =>
										layer0Ctx.statusWriter.enqueue({ ...patch, stepIndex: 0 }),
								});
								return singleResultToChildAgentResult(result, prepared);
							},
							onLifecycle: effectiveAsync
								? (event) => {
										if (event.type === "run.started") {
											safeEmit(SUBAGENT_ASYNC_STARTED_EVENT, {
												id: event.runId,
												runId: event.runId,
												metadata: undefined,
												controlConfig,
												agent: role,
												task: task.slice(0, 50),
												cwd: effectiveCwd,
												asyncDir: event.runRecordDir,
												parentRunId: group.runId,
											});
											return;
										}
										const child = event.result;
										// Workflow children never notify individually: the workflow is ONE
										// entity and sends exactly one completion (with the script's return
										// value) from finishAsync. The event still fires for non-notify
										// consumers (widget liveness, tests).
										safeEmit(SUBAGENT_ASYNC_RUN_COMPLETE_EVENT, {
											id: event.runId,
											runId: event.runId,
											parentRunId: group.runId,
											rootRunId: groupRootRunId,
											metadata: undefined,
											notifyPolicy: "silent",
											agent: role,
											success: child ? child.state === "complete" : false,
											summary: child?.outputText ?? (event.error ? String(event.error) : ""),
											exitCode: child?.exitCode,
											state: child?.state ?? "failed",
											durationMs: child?.durationMs,
											sessionFile: child?.sessionFile ?? event.sessionFile,
											timestamp: event.timestamp,
											taskIndex: index,
											asyncDir: event.runRecordDir,
										});
									}
								: undefined,
						},
					);
					await awaitRun(handle);
					if (!result) throw new Error(`Child agent did not produce a result for ${handle.runId}`);
					childResults.push({ runId: handle.runId, result, index });
					return result;
				},
				failWorkflow: async (message, tags) => {
					// A raw workflow-level error (e.g. the script throws after a successful
					// child) leaves the statusless group with only successful child rows, so
					// dashboard/registry synthesis (computeGroupStatus) would show it complete.
					// Record a synthetic FAILED child so the group synthesizes as failed,
					// without ever writing a group status.json (statusless invariant).
					// Safety net only: if a child already failed (e.g. a WorkflowAgentError
					// from an awaited agent() failure), the group already synthesizes as
					// failed — don't add a redundant second failed row.
					if (childResults.some(({ result: r }) => r.exitCode !== 0 || r.interrupted === true)) return;
					const index = childResults.length;
					let result: SingleResult | undefined;
					const handle = spawnRun(
						{ agentName: "workflow", task: message, cwd: effectiveCwd },
						{
							parentRunId: group.runId,
							rootRunId: groupRootRunId,
							notifyPolicy: "each",
							parentSessionFile,
							sessionDir: path.join(sessionRoot, `run-${index}`),
							...(tags?.phaseIndex !== undefined ? { phaseIndex: tags.phaseIndex } : {}),
							...(tags?.phaseTitle ? { phaseTitle: tags.phaseTitle } : {}),
							...(deps.config.defaultSessionDir
								? { defaultSessionDir: path.resolve(deps.expandTilde(deps.config.defaultSessionDir)) }
								: {}),
							...(ctx.sessionManager?.getSessionId
								? { parentSessionId: ctx.sessionManager.getSessionId() }
								: {}),
							...(() => {
								const root = resolveDispatchRootSessionId(ctx);
								return root ? { rootSessionId: root } : {};
							})(),
							source: effectiveAsync ? "async" : "sync",
							runAgent: async (prepared) => {
								result = {
									agent: "workflow",
									task: message,
									exitCode: 1,
									messages: [],
									usage: emptyUsage(),
									error: message,
								};
								return {
									runId: prepared.runId,
									stepIndex: 0,
									state: "failed",
									exitCode: 1,
									outputText: message,
									toolCallCount: 0,
									toolResultCount: 0,
									toolErrorCount: 0,
									durationMs: 0,
									startedAt: Date.now(),
									endedAt: Date.now(),
									sessionFile: prepared.sessionFile,
									error: { message },
									usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
								};
							},
						},
					);
					await awaitRun(handle);
					if (result) childResults.push({ runId: handle.runId, result, index });
				},
				finishAsync: (success, summary) => {
					if (!effectiveAsync) return;
					writeWorkflowGroupState(group.runRecordDir, success ? "complete" : "failed");
					const ordered = [...childResults].sort((a, b) => a.index - b.index);
					const children = ordered.map(({ runId, result: r, index }) => ({
						id: runId,
						runId,
						dispatchRunId: group.runId,
						stepIndex: index,
						agent: r.agent,
						state: r.interrupted ? "interrupted" : r.exitCode === 0 ? "complete" : "failed",
						success: r.exitCode === 0 && !r.interrupted,
						exitCode: r.exitCode,
						output: getSingleResultOutput(r),
						summary: getSingleResultOutput(r),
						durationMs: r.progressSummary?.durationMs,
						sessionFile: r.sessionFile,
					}));
					safeEmit(
						SUBAGENT_ASYNC_COMPLETE_EVENT,
						buildAsyncAggregateCompletePayload({
							id: group.runId,
							runId: group.runId,
							parentRunId,
							rootRunId: groupRootRunId,
							notifyPolicy: "each",
							success,
							agent: "workflow",
							summary: summary ?? "",
							state: success ? "complete" : "failed",
							results: children,
							children,
							total: childResults.length,
							completed: childResults.filter(({ result }) => result.exitCode === 0 && !result.interrupted)
								.length,
							asyncDir: group.runRecordDir,
							metadata: undefined,
							workflowFields: {
								kind: "workflow",
								agents: ordered.map(({ result }) => result.agent).join(","),
							},
						}),
					);
				},
			};
		},
	};
}
