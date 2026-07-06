import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
	type ChildAgentHandle,
	type ChildAgentResult,
	type ChildAgentStep,
	type ChildAgentRegistry,
	dispatchAsyncChild,
} from "./in-process-executor.ts";
import { StatusWriter } from "../state/status-writer.ts";
import { isRunnerHardDead } from "../state/run-liveness.ts";
import { readStatus } from "../shared/utils.ts";
import { tokenUsageFromTotal } from "../state/usage-totals.ts";
import { readAllEntries, type RunsRegistryEntry } from "../state/runs-registry.ts";
import { evictCompletionDedupeForRunId } from "../state/completion-dedupe.ts";
import { logger } from "../shared/logger.ts";
import { createForegroundRunController } from "./foreground-run-controller.ts";
import { registerRunController, releaseRunController } from "./layer0-runs.ts";
import {
	type Details,
	type SingleResult,
	type SubagentState,
	SUBAGENT_COMPLETED_EVENT,
	SUBAGENT_ASYNC_COMPLETE_EVENT,
	SUBAGENT_ASYNC_STARTED_EVENT,
	SUBAGENT_FAILED_EVENT,
	SUBAGENT_SPAWN_STARTED_EVENT,
} from "../protocol/types.ts";
import { resolveCurrentMaxSubagentDepth } from "../shared/runtime-env.ts";
import type { ExecutionContextData, ExecutorDeps, ForegroundControlRef } from "./executor-types.ts";
import {
	asyncStartedResult,
	createForegroundControlNotifier,
	emitSyncLifecycleEvent,
	interruptForegroundOnNeedsAttention,
	mirrorForegroundProgressToStatus,
	safeEmit,
	shapeSingleForegroundResult,
	tokenUsageFromResult,
	validationError,
} from "./executor-helpers.ts";
import { buildAsyncChildStep, runInProcessChildStep } from "./child-step-runner.ts";

function parseChildRunId(id: string): { dispatchRunId: string; stepIndex?: number } {
	const match = id.match(/^(.*):(\d+)$/);
	if (!match) return { dispatchRunId: id };
	return { dispatchRunId: match[1]!, stepIndex: Number(match[2]) };
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
	data: ExecutionContextData,
	deps: ExecutorDeps,
): Promise<AgentToolResult<Details>> {
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
		target = resolveResumeTarget(parsed.dispatchRunId, parsed.stepIndex ?? 0);
		assertResumableTarget(target);
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
		})) ?? [
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
				const statusStepPatch = target.status.steps?.map((_, stepIdx) =>
					stepIdx === step.stepIndex
						? {
								agent: firstProgress?.agent ?? target.agentName,
								status: firstProgress?.status ?? "running",
								startedAt: target.status.steps?.[step.stepIndex]?.startedAt ?? target.startedAt,
								lastActivityAt: firstProgress?.lastActivityAt,
								currentTool: firstProgress?.currentTool,
								currentToolStartedAt: firstProgress?.currentToolStartedAt,
								...(resumeLiveTokens ? { tokens: resumeLiveTokens } : {}),
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
						...(resumeLiveTokens ? { tokens: resumeLiveTokens } : {}),
					},
				];
				mirrorForegroundProgressToStatus(
					statusWriter,
					firstProgress,
					index,
					statusStepPatch,
					foregroundControl.executionStartedAt,
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
			statusWriter.finalizeTerminal({
				state: result?.exitCode === 0 && !failureMessage ? "complete" : "failed",
				// Only the resumed step is finalized; siblings echo their existing
				// fields so finalizeTerminal's force-overrides become no-ops
				// (a patchless `{}` would flip siblings to the run-level end state).
				steps: target.status.steps?.map((existingStep, index) =>
					index === step.stepIndex
						? {
								status: result?.exitCode === 0 && !failureMessage ? "complete" : "failed",
								tokens: result ? tokenUsageFromResult(result) : undefined,
								durationMs: result?.progressSummary?.durationMs,
								error: result?.error ?? failureMessage,
							}
						: existingStep,
				) ?? [
					{
						status: result?.exitCode === 0 && !failureMessage ? "complete" : "failed",
						tokens: result ? tokenUsageFromResult(result) : undefined,
						durationMs: result?.progressSummary?.durationMs,
						error: result?.error ?? failureMessage,
					},
				],
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
