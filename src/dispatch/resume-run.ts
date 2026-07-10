import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { PersistedRunStatus, PersistedRunStep } from "../protocol/status-types.ts";
import {
	type ChildAgentHandle,
	type ChildAgentResult,
	type ChildAgentStep,
	type ChildAgentRegistry,
	dispatchAsyncChild,
} from "./in-process-executor.ts";
import { StatusWriter } from "../state/status-writer.ts";
import { isRunnerHardDead } from "../state/run-liveness.ts";
import { getSingleResultOutput, readStatus } from "../shared/utils.ts";
import { sumTokenUsages, tokenUsageFromTotal, tokenUsageFromUsage, totalUsageTokens } from "../state/usage-totals.ts";
import { readAllEntries, type RunsRegistryEntry } from "../state/runs-registry.ts";
import { evictCompletionDedupeForRunId } from "../state/completion-dedupe.ts";
import { logger } from "../shared/logger.ts";
import { getLineageForSession } from "../state/lineage.ts";
import { createForegroundRunController } from "./foreground-run-controller.ts";
import { registerRunController, releaseRunController } from "./layer0-runs.ts";
import {
	type Details,
	type SingleResult,
	type SubagentState,
	type TokenUsage,
	type Usage,
	SUBAGENT_COMPLETED_EVENT,
	SUBAGENT_ASYNC_COMPLETE_EVENT,
	SUBAGENT_ASYNC_STARTED_EVENT,
	SUBAGENT_FAILED_EVENT,
	SUBAGENT_SPAWN_STARTED_EVENT,
	normalizeAgentIdentity,
	resolveChildMaxSubagentDepth,
} from "../protocol/types.ts";
import {
	checkNestedDelegationGuard,
	checkSubagentDepth,
	resolveCurrentMaxSubagentDepth,
} from "../shared/runtime-env.ts";
import type { ExecutionContextData, ExecutorDeps, ForegroundControlRef } from "./executor-types.ts";
import {
	asyncStartedResult,
	createForegroundControlNotifier,
	emitSyncLifecycleEvent,
	interruptForegroundOnNeedsAttention,
	mirrorForegroundProgressToStatus,
	safeEmit,
	shapeSingleForegroundResult,
	sumUsages,
	terminalStatusStepFromResult,
	validationError,
} from "./executor-helpers.ts";
import { buildAsyncChildStep, runInProcessChildStep } from "./child-step-runner.ts";

function parseChildRunId(id: string): { dispatchRunId: string; stepIndex?: number } {
	const match = id.match(/^(.*):(\d+)$/);
	if (!match) return { dispatchRunId: id };
	return { dispatchRunId: match[1]!, stepIndex: Number(match[2]) };
}

function persistedTokenBaseline(status: PersistedRunStatus): TokenUsage | undefined {
	const stepTokens = sumTokenUsages(...(status.steps ?? []).map((step) => step.tokens));
	const usageTokens = tokenUsageFromUsage(status.totalUsage);
	let baseline: TokenUsage | undefined;
	for (const candidate of [status.totalTokens, usageTokens, stepTokens]) {
		if (candidate && (!baseline || candidate.total > baseline.total)) baseline = candidate;
	}
	return baseline;
}

function usageFromTokenBaseline(tokens: TokenUsage): Usage {
	const unclassified = Math.max(0, tokens.total - totalUsageTokens(tokens));
	return {
		input: tokens.input,
		output: tokens.output + unclassified,
		...(tokens.cacheRead !== undefined ? { cacheRead: tokens.cacheRead } : {}),
		...(tokens.cacheWrite !== undefined ? { cacheWrite: tokens.cacheWrite } : {}),
		cost: 0,
		turns: 0,
	};
}

function resumedUsageTotals(status: PersistedRunStatus, usage: Usage | undefined) {
	const previousTotalTokens = persistedTokenBaseline(status);
	const previousTotalUsage = status.totalUsage
		? {
				...status.totalUsage,
				output:
					status.totalUsage.output +
					Math.max(0, (previousTotalTokens?.total ?? 0) - totalUsageTokens(status.totalUsage)),
			}
		: previousTotalTokens
			? usageFromTokenBaseline(previousTotalTokens)
			: undefined;
	return {
		totalUsage: sumUsages(previousTotalUsage, usage),
		totalTokens: sumTokenUsages(previousTotalTokens, tokenUsageFromUsage(usage)),
	};
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

export function resolveResumeTarget(runId: string, stepIndex = 0, requestingRootSessionId?: string): ResumeTarget {
	const entry = readAllEntries().find((candidate) => candidate.runId === runId);
	if (!entry) throw new Error(`Unknown runId '${runId}'.`);
	const recordedRootSessionId = entry.rootSessionId ?? entry.parentSessionId;
	if (!recordedRootSessionId) {
		throw new Error(
			`Run ${runId} has no root-session ownership metadata and cannot be resumed safely after restart.`,
		);
	}
	if (!requestingRootSessionId) {
		throw new Error(
			`Run ${runId} belongs to root session ${recordedRootSessionId}; the current root session is unavailable.`,
		);
	}
	if (recordedRootSessionId !== requestingRootSessionId) {
		throw new Error(
			`Run ${runId} belongs to root session ${recordedRootSessionId}, not the current root session ${requestingRootSessionId}. Resume it from its owning root session.`,
		);
	}
	if (entry.mode === "parallel")
		throw new Error(`Run ${runId} is a parallel group; resume an individual child runId instead.`);
	const status = readStatus(entry.runRecordDir);
	if (!status) throw new Error(`No status.json found for runId '${runId}' at ${entry.runRecordDir}.`);
	const step = status.steps?.[stepIndex];
	// Prefer the targeted step's own session file: async parallel status stores the run-level
	// `sessionFile` as step 0's file, so a non-zero stepIndex must read the per-step file first
	// or it would silently reopen step 0's session.
	const sessionFile =
		step?.sessionFile ?? status.sessionFile ?? path.join(entry.runRecordDir, `run-${stepIndex}`, "session.jsonl");
	// Require a NON-EMPTY session.jsonl: an empty run-N/ (early-interrupt before any
	// turn was recorded) has nothing to resume, so treat it as missing.
	if (!fs.existsSync(sessionFile) || fs.statSync(sessionFile).size === 0)
		throw new Error(
			`Session file for run ${runId} is missing at ${sessionFile}; cannot resume without the original session.`,
		);
	const agentName =
		step?.agent ?? entry.agentName ?? entry.agentNames?.[stepIndex] ?? entry.agentNames?.[0] ?? "unknown";
	return {
		runId,
		sessionFile,
		runRecordDir: entry.runRecordDir,
		agentName,
		cwd: status.cwd ?? entry.cwd,
		...((status.parentRunId ?? entry.parentRunId) ? { parentRunId: status.parentRunId ?? entry.parentRunId } : {}),
		rootRunId: entry.rootRunId ?? entry.runId,
		startedAt: status.startedAt ?? entry.startedAt,
		state: status.state,
		status,
		registryEntry: entry,
	};
}

export function assertResumableTarget(target: Pick<ResumeTarget, "runId" | "state" | "status">): void {
	// Reject only a genuinely live run: state 'running' with a fresh heartbeat.
	// Every terminal state (complete/failed/interrupted/lost/paused) is resumable,
	// and a dead-'running' record (ungraceful kill a cross-session sweep has not
	// yet finalized) is resumable too.
	if (target.state === "running" && !isRunnerHardDead(target.status)) {
		throw new Error(`Run ${target.runId} is still running; wait for it to finish or interrupt it before resuming.`);
	}
}

const resumeInFlight = new Set<string>();

async function postResumeMessage(
	handle: ChildAgentHandle,
	runId: string,
	message: string,
): Promise<AgentToolResult<Details> | null> {
	try {
		await handle.session.sendUserMessage(message, { deliverAs: "steer" });
		return null;
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		return validationError(`Failed to resume run ${runId}: ${errorMessage}`);
	}
}

async function resumeRun(
	state: SubagentState,
	childRegistry: ChildAgentRegistry,
	runId: string,
	message: string,
	asyncMode: boolean | undefined,
	requestingRootSessionId: string | undefined,
	data: ExecutionContextData,
	deps: ExecutorDeps,
): Promise<AgentToolResult<Details>> {
	const currentSessionId = data.ctx.sessionManager.getSessionId() ?? undefined;
	const currentLineage = currentSessionId ? getLineageForSession(currentSessionId) : null;
	const depthGuard = checkSubagentDepth(deps.config.maxSubagentDepth, currentLineage);
	if (depthGuard.blocked) {
		return validationError(
			`Nested subagent call blocked (depth=${depthGuard.depth}, max=${depthGuard.maxDepth}). ` +
				"You are running at the maximum subagent nesting depth.",
		);
	}
	const delegationGuard = checkNestedDelegationGuard([], currentLineage);
	if (delegationGuard.blocked) {
		return validationError(delegationGuard.reason ?? "Nested subagent call blocked.");
	}
	const calledFromChildSession = currentLineage
		? currentLineage.role === "child"
		: normalizeAgentIdentity(process.env.PI_SUBAGENT_CURRENT_AGENT) !== undefined;
	if (asyncMode === true && calledFromChildSession) {
		return validationError("Async resume is only allowed from the host session.");
	}
	const authorizeTarget = (agentName: string | undefined): AgentToolResult<Details> | null => {
		const targetGuard = checkNestedDelegationGuard(
			agentName ? [agentName] : ["__unresolved_resume_target__"],
			currentLineage,
		);
		if (!targetGuard.blocked) return null;
		return validationError(
			agentName
				? (targetGuard.reason ?? "Nested subagent call blocked.")
				: "Nested subagent call blocked because the resume target could not be authorized.",
		);
	};
	const parsed = parseChildRunId(runId);
	const tracked = state.asyncJobs.get(parsed.dispatchRunId);
	// Key the in-flight guard by the canonical target (dispatchRunId + step), not the raw caller
	// id, so aliases like `runId` and `runId:0` cannot bypass the guard and double-open the session.
	const resumeKey = `${parsed.dispatchRunId}:${parsed.stepIndex ?? 0}`;
	if (resumeInFlight.has(resumeKey)) return validationError(`Resume already in progress for run ${runId}.`);
	const handles = childRegistry.list().filter((handle) => handle.runId === parsed.dispatchRunId);
	if (parsed.stepIndex === undefined) {
		if (
			(tracked?.mode && tracked.mode !== "single") ||
			handles.length > 1 ||
			(handles.length === 1 && handles[0]!.stepIndex !== 0)
		) {
			return validationError("`id` must be a runId, not batchId");
		}
	} else if (
		(tracked?.mode && tracked.mode === "single") ||
		(handles.length === 1 && handles[0]!.stepIndex === 0 && handles[0]!.runId === parsed.dispatchRunId)
	) {
		return validationError(`No resumable run found for '${runId}'.`);
	}
	const handle =
		parsed.stepIndex === undefined
			? handles[0]
			: handles.find((candidate) => candidate.stepIndex === parsed.stepIndex);
	if (handle) {
		const targetAgent =
			tracked?.agents?.[parsed.stepIndex ?? 0] ??
			childRegistry.getRunView(parsed.dispatchRunId)?.steps[parsed.stepIndex ?? 0]?.agent;
		const authorizationError = authorizeTarget(targetAgent);
		if (authorizationError) return authorizationError;
		const error = await postResumeMessage(handle, runId, message);
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
		target = resolveResumeTarget(parsed.dispatchRunId, parsed.stepIndex ?? 0, requestingRootSessionId);
		assertResumableTarget(target);
	} catch (error) {
		const messageText = error instanceof Error ? error.message : String(error);
		return validationError(messageText);
	}
	const authorizationError = authorizeTarget(target.agentName);
	if (authorizationError) return authorizationError;
	const agentConfig = data.agents.find((agent) => agent.name === target.agentName) ?? data.agents[0];
	if (!agentConfig) return validationError(`No agent config available to resume run ${runId}.`);
	const configAuthorizationError = authorizeTarget(agentConfig.name);
	if (configAuthorizationError) return configAuthorizationError;
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
		maxSubagentDepth: resolveChildMaxSubagentDepth(
			resolveCurrentMaxSubagentDepth(deps.config.maxSubagentDepth, currentLineage),
			agentConfig.maxSubagentDepth,
		),
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
	const statusWriter = new StatusWriter({
		runRecordDir: target.runRecordDir,
		runId: target.runId,
		flushPolicy: asyncMode === false ? "terminal" : "eager",
	});
	// Resume reseeds the activity/heartbeat clocks to now so the inactivity
	// watchdog measures from the resume moment, not the original run's last
	// activity (startedAt stays immutable for duration semantics).
	const resumedAt = Date.now();
	const resumeCount = (target.status.resumeCount ?? 0) + 1;
	const resumeBaseline = resumedUsageTotals(target.status, undefined);
	const previousResumeStep = target.status.steps?.[step.stepIndex];
	statusWriter.initialize({
		mode: target.status.mode,
		state: "running",
		startedAt: target.startedAt,
		lastActivityAt: resumedAt,
		runnerHeartbeatAt: resumedAt,
		resumedAt,
		resumeCount,
		...(target.status.totalUsage || resumeBaseline.totalTokens ? { totalUsage: resumeBaseline.totalUsage } : {}),
		...(resumeBaseline.totalTokens ? { totalTokens: resumeBaseline.totalTokens } : {}),
		cwd: target.cwd,
		...(target.parentRunId ? { parentRunId: target.parentRunId } : {}),
		currentStep: step.stepIndex,
		sessionFile: target.sessionFile,
		sessionDir: target.runRecordDir,
		steps: target.status.steps?.map((statusStep, index) => {
			const isResumedStep = index === step.stepIndex;
			return {
				...statusStep,
				status: isResumedStep ? "running" : statusStep.status,
				startedAt: statusStep.startedAt ?? target.startedAt,
				...(isResumedStep
					? { endedAt: undefined, durationMs: undefined, error: undefined, lastActivityAt: resumedAt }
					: {}),
				sessionFile: statusStep.sessionFile ?? (isResumedStep ? target.sessionFile : undefined),
			};
		}) ?? [
			{
				agent: target.agentName,
				status: "running",
				startedAt: target.startedAt,
				lastActivityAt: resumedAt,
				sessionFile: target.sessionFile,
			},
		],
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
		const fg = createForegroundRunController(foregroundControl, {
			mirror: (firstProgress, index) => {
				const resumeLiveTokens = tokenUsageFromTotal(firstProgress?.tokens);
				const resumedStepTokens = sumTokenUsages(previousResumeStep?.tokens, resumeLiveTokens);
				const resumedTotalTokens = sumTokenUsages(resumeBaseline.totalTokens, resumeLiveTokens);
				const previousLive = previousResumeStep?.live;
				const toolCallCount =
					(previousLive?.toolCallCount ?? previousLive?.toolCount ?? 0) + (firstProgress?.toolCount ?? 0);
				const resumedLive = {
					toolCallCount,
					toolCount: toolCallCount,
					tokens: resumedStepTokens?.total,
				};
				const statusStepPatch = target.status.steps?.map((_, stepIdx) =>
					stepIdx === step.stepIndex
						? {
								agent: firstProgress?.agent ?? target.agentName,
								status: firstProgress?.status ?? "running",
								startedAt: previousResumeStep?.startedAt ?? target.startedAt,
								lastActivityAt: firstProgress?.lastActivityAt,
								currentTool: firstProgress?.currentTool,
								currentToolStartedAt: firstProgress?.currentToolStartedAt,
								...(resumedStepTokens ? { tokens: resumedStepTokens } : {}),
								live: resumedLive,
							}
						: {},
				) ?? [
					{
						agent: firstProgress?.agent ?? target.agentName,
						status: firstProgress?.status ?? "running",
						startedAt: target.startedAt,
						lastActivityAt: firstProgress?.lastActivityAt,
						currentTool: firstProgress?.currentTool,
						currentToolStartedAt: firstProgress?.currentToolStartedAt,
						...(resumedStepTokens ? { tokens: resumedStepTokens } : {}),
						live: resumedLive,
					},
				];
				mirrorForegroundProgressToStatus(
					statusWriter,
					firstProgress,
					index,
					statusStepPatch,
					foregroundControl.executionStartedAt,
					resumedTotalTokens,
				);
			},
		});
		fg.beginStep(target.agentName, step.stepIndex, (reason?: string) => {
			if (interruptController.signal.aborted) return false;
			interruptController.abort(reason ?? "interrupt requested");
			foregroundControl.currentActivityState = undefined;
			foregroundControl.updatedAt = Date.now();
			return true;
		});
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
			fg.applyProgress(
				target.agentName,
				firstProgress?.index ?? step.stepIndex,
				firstProgress,
				update.details?.results?.[0]?.finalOutput,
			);
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
				layer0: {
					runId: target.runId,
					runRecordDir: target.runRecordDir,
					sessionFile: target.sessionFile,
					rootRunId: target.rootRunId,
				},
			});
			fg.finalizeStep(step.stepIndex, {
				progress: result.progress,
				finalOutput: getSingleResultOutput(result),
			});
			emitSyncLifecycleEvent(deps.pi, result.exitCode === 0 ? SUBAGENT_COMPLETED_EVENT : SUBAGENT_FAILED_EVENT, {
				...eventPayload,
				exitCode: result.exitCode,
				error: result.error,
			});
			// Same result shape as a normal sync single dispatch: the parent gets the
			// agent's output and the finished widget renders a single result card, not
			// a bland management row. Shared shaping helper prevents call-site drift.
			return shapeSingleForegroundResult({
				r: result,
				runId: target.runId,
				agent: target.agentName,
			});
		} catch (error) {
			failureMessage = error instanceof Error ? error.message : String(error);
			emitSyncLifecycleEvent(deps.pi, SUBAGENT_FAILED_EVENT, {
				...eventPayload,
				exitCode: 1,
				error: failureMessage,
			});
			return validationError(`Failed to resume run ${runId}: ${failureMessage}`);
		} finally {
			const terminalState = result?.interrupted
				? "interrupted"
				: result?.exitCode === 0 && !failureMessage
					? "complete"
					: "failed";
			const previousStep = target.status.steps?.[step.stepIndex];
			const resultPatch = result ? terminalStatusStepFromResult(result) : undefined;
			const previousLive = previousStep?.live;
			const resultLive = resultPatch?.live;
			const toolCallCount =
				(previousLive?.toolCallCount ?? previousLive?.toolCount ?? 0) + (resultLive?.toolCallCount ?? 0);
			const terminalPatch: Partial<PersistedRunStep> = resultPatch
				? {
						...resultPatch,
						status: terminalState,
						...(failureMessage ? { error: failureMessage } : {}),
						tokens: sumTokenUsages(previousStep?.tokens, resultPatch.tokens),
						live: {
							...resultLive,
							toolCallCount,
							toolResultCount: (previousLive?.toolResultCount ?? 0) + (resultLive?.toolResultCount ?? 0),
							toolErrorCount: (previousLive?.toolErrorCount ?? 0) + (resultLive?.toolErrorCount ?? 0),
							toolCount: toolCallCount,
							tokens:
								(previousLive?.tokens ?? previousStep?.tokens?.total ?? 0) +
								(resultLive?.tokens ?? resultPatch.tokens?.total ?? 0),
						},
					}
				: { status: "failed", error: failureMessage };
			const totals = result ? resumedUsageTotals(target.status, result.usage) : undefined;
			statusWriter.finalizeTerminal({
				state: terminalState,
				// Only the resumed step is finalized; siblings echo their existing
				// fields so finalizeTerminal's force-overrides become no-ops
				// (a patchless `{}` would flip siblings to the run-level end state).
				steps: target.status.steps?.map((existingStep, index) =>
					index === step.stepIndex
						? {
								...existingStep,
								...terminalPatch,
								endedAt: undefined,
								durationMs: terminalPatch.durationMs,
							}
						: existingStep,
				) ?? [terminalPatch],
				...(result && totals
					? { totalUsage: totals.totalUsage, outputText: getSingleResultOutput(result) }
					: {}),
				...(totals?.totalTokens ? { totalTokens: totals.totalTokens } : {}),
				...(failureMessage || result?.error ? { error: failureMessage ?? result?.error } : {}),
				sessionFile: result?.sessionFile ?? target.sessionFile,
			});
			statusWriter.dispose();
			deps.state.foregroundControls.delete(target.runId);
			if (deps.state.lastForegroundControlId === target.runId) deps.state.lastForegroundControlId = null;
			resumeInFlight.delete(resumeKey);
		}
	}
	const detachedAbort = new AbortController();
	// Same invariant as the async dispatch paths: this resume does not go
	// through spawnRun, so its detached controller must live in the shared
	// layer0 map or the resumed run is uninterruptible after a reload.
	registerRunController(target.runId, detachedAbort);
	const asyncCtx = {
		extensionCtx: data.ctx,
		abortSignal: detachedAbort.signal,
		onStatusUpdate: (patch: Parameters<StatusWriter["enqueue"]>[0]) => {
			const resumedStepTokens =
				patch.stepIndex === step.stepIndex
					? sumTokenUsages(previousResumeStep?.tokens, patch.tokens)
					: patch.tokens;
			const resumedTotalTokens = patch.tokens
				? sumTokenUsages(resumeBaseline.totalTokens, patch.tokens)
				: undefined;
			statusWriter.enqueue({
				...patch,
				...(resumedStepTokens ? { tokens: resumedStepTokens } : {}),
				...(resumedTotalTokens ? { totalTokens: resumedTotalTokens } : {}),
			});
		},
		registry: deps.childRegistry,
		pi: deps.pi,
	};
	const childHandle = dispatchAsyncChild(step, asyncCtx);
	const finalize = async () => {
		let result: ChildAgentResult | undefined;
		try {
			result = await childHandle.completed;
			const previousStep = target.status.steps?.[step.stepIndex];
			const previousLive = previousStep?.live;
			const persistedResult = {
				...result,
				toolCallCount: (previousLive?.toolCallCount ?? previousLive?.toolCount ?? 0) + result.toolCallCount,
				toolResultCount: (previousLive?.toolResultCount ?? 0) + result.toolResultCount,
				toolErrorCount: (previousLive?.toolErrorCount ?? 0) + result.toolErrorCount,
			};
			const totals = resumedUsageTotals(target.status, result.usage);
			const stepTokens = sumTokenUsages(previousStep?.tokens, tokenUsageFromUsage(result.usage));
			await statusWriter.finalize(persistedResult, {
				totalUsage: totals.totalUsage,
				...(stepTokens ? { stepTokens } : {}),
			});
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
			releaseRunController(target.runId);
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
	void completed.catch((error) =>
		logger.warn("disk resume failed after dispatch", {
			runId,
			error: error instanceof Error ? error.message : String(error),
		}),
	);
	return asyncStartedResult({
		mode: "single",
		runId: target.runId,
		asyncDir: target.runRecordDir,
		text: `Async resume: ${target.agentName} [${target.runId}]`,
	});
}

export { resumeRun };
