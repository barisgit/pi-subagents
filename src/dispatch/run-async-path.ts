import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { type AgentConfig, resolveAgentColor } from "../shared/agents.ts";
import { normalizeAvailableModels, resolveModelCandidate } from "./model-fallback.ts";
import { normalizeSkillInput } from "../shared/skills.ts";
import {
	type ChildAgentHandle,
	type ChildAgentResult,
	type ChildAgentStep,
	dispatchAsyncChild,
} from "./in-process-executor.ts";
import type { StatusWriter } from "../state/status-writer.ts";
import { formatRunHandle } from "../state/run-shape.ts";
import { getLineageForSession } from "../state/lineage.ts";
import { resolveChildCwd } from "../shared/utils.ts";
import {
	spawnRun,
	openGroup,
	openRunRecord,
	finalizeRun,
	registerRunController,
	releaseRunController,
} from "./layer0-runs.ts";
import { logger } from "../shared/logger.ts";
import {
	type Details,
	type Usage,
	SUBAGENT_ASYNC_COMPLETE_EVENT,
	SUBAGENT_ASYNC_RUN_COMPLETE_EVENT,
	SUBAGENT_ASYNC_STARTED_EVENT,
	resolveTopLevelParallelMaxTasks,
	resolveChildMaxSubagentDepth,
	wrapForkTask,
} from "../protocol/types.ts";
import { resolveCurrentMaxSubagentDepth } from "../shared/runtime-env.ts";
import type { AsyncDispatchStep, ExecutionContextData, ExecutorDeps, TaskParam } from "./executor-types.ts";
import {
	addUsageInto,
	asyncStartedResult,
	batchToNotifyPolicy,
	buildAsyncAggregateCompletePayload,
	buildParallelModeError,
	buildParallelWorktreeTaskCwdError,
	emitRunAnchor,
	emptyUsage,
	publishSubagentUsage,
	resolveDispatchParentRunId,
	resolveDispatchRootRunId,
	resolveDispatchRootSessionId,
	safeEmit,
} from "./executor-helpers.ts";
import { buildAsyncChildStep } from "./child-step-runner.ts";
import { resolveSingleOutput } from "../surfaces/single-output.ts";

export function childCompletionRunId(dispatchRunId: string, stepIndex: number, total: number): string {
	return total > 1 ? `${dispatchRunId}:${stepIndex}` : dispatchRunId;
}

export function runAsyncPath(data: ExecutionContextData, deps: ExecutorDeps): AgentToolResult<Details> | null {
	const { params, effectiveCwd, agents, ctx, effectiveAsync, controlConfig } = data;
	const hasTasks = (params.tasks?.length ?? 0) > 0;
	const hasSingle = !hasTasks && Boolean(params.agent);
	if (!effectiveAsync) return null;

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
	const availableModels = normalizeAvailableModels(ctx.modelRegistry.getAvailable());
	const currentProvider = ctx.model?.provider;
	const currentSessionId = ctx.sessionManager?.getSessionId?.();
	const currentMaxSubagentDepth = resolveCurrentMaxSubagentDepth(
		deps.config.maxSubagentDepth,
		currentSessionId ? getLineageForSession(currentSessionId) : null,
	);
	const parentRunId = resolveDispatchParentRunId(ctx);
	const rootRunId = resolveDispatchRootRunId(ctx, runId);
	const steps: AsyncDispatchStep[] = [];
	let mode: "single" | "parallel" = "single";
	let runLabel = params.label;

	if (hasSingle) {
		const agentConfig = agents.find((x) => x.name === params.agent);
		if (!agentConfig)
			return {
				content: [{ type: "text", text: `Unknown agent: ${params.agent}` }],
				isError: true,
				details: { mode: "single" as const, results: [] },
			};
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
			modelOverride: resolveModelCandidate(
				(params.model as string | undefined) ?? agentConfig.model,
				availableModels,
				currentProvider,
			),
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
			if (!agentConfig)
				return {
					content: [{ type: "text", text: `Unknown agent: ${task.agent}` }],
					isError: true,
					details: { mode: "parallel" as const, results: [] },
				};
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
	}

	const first = steps[0];
	if (!first) return null;
	if (mode === "parallel" && hasTasks) {
		const rootSessionId = resolveDispatchRootSessionId(ctx, deps.state.currentSessionId ?? undefined);
		const parentSessionId = ctx.sessionManager?.getSessionId?.();
		const notifyPolicy = batchToNotifyPolicy(params.batch);
		const group = openGroup({
			cwd: effectiveCwd,
			...(rootRunId !== runId ? { rootRunId } : {}),
			notifyPolicy,
			...(runLabel ? { label: runLabel } : {}),
			...(parentRunId ? { parentRunId } : {}),
			...(params.sessionDir ? { sessionDir: path.resolve(deps.expandTilde(params.sessionDir)) } : {}),
			...(deps.config.defaultSessionDir
				? { defaultSessionDir: path.resolve(deps.expandTilde(deps.config.defaultSessionDir)) }
				: {}),
			parentSessionFile: ctx.sessionManager.getSessionFile() ?? null,
			...(parentSessionId ? { parentSessionId } : {}),
			...(rootSessionId ? { rootSessionId } : {}),
			source: "async",
			mode: "parallel",
		});
		const groupRunId = group.runId;
		const groupRootRunId = rootRunId === runId ? groupRunId : rootRunId;
		emitRunAnchor(deps.pi, {
			runId: groupRunId,
			rootRunId: groupRootRunId,
			mode: "parallel",
			source: "async",
			parentRunId,
		});
		const asyncDetachedAbort = new AbortController();
		// This dispatch does not go through spawnRun, so the detached controller
		// must be registered in the shared layer0 map here or a reload leaves the
		// group uninterruptible (the per-activation childRegistry dies on reload).
		registerRunController(groupRunId, asyncDetachedAbort);
		// spawnRun reserves the run record + handle eagerly (so we still return all N
		// handles immediately). The per-process leaf-concurrency pool inside
		// startChildAgent bounds how many children run leaf sessions at once.
		const childRuns = steps.map((item, originalStepIndex) => {
			const handle = spawnRun(
				{
					agentName: item.step.agentName,
					task: item.step.task,
					cwd: item.step.cwd,
					...(item.step.label ? { label: item.step.label } : {}),
				},
				{
					parentRunId: groupRunId,
					rootRunId: groupRootRunId,
					notifyPolicy: "each",
					parentSessionFile: ctx.sessionManager.getSessionFile() ?? null,
					...(params.sessionDir ? { sessionDir: path.resolve(deps.expandTilde(params.sessionDir)) } : {}),
					...(deps.config.defaultSessionDir
						? { defaultSessionDir: path.resolve(deps.expandTilde(deps.config.defaultSessionDir)) }
						: {}),
					...(rootSessionId ? { rootSessionId } : {}),
					...(parentSessionId ? { parentSessionId } : {}),
					source: "async",
					runAgent: async (prepared, layer0Ctx) => {
						// A child can be interrupted before it launches
						// (subagent interrupt aborts the registry controller for its runId).
						// Honor that here so it never launches a leaf session.
						const registrySignal = deps.childRegistry.signalForRun(prepared.runId);
						const childAbortSignal = AbortSignal.any([asyncDetachedAbort.signal, layer0Ctx.abortSignal]);
						if (registrySignal.aborted || childAbortSignal.aborted) {
							const now = Date.now();
							return {
								runId: prepared.runId,
								stepIndex: 0,
								state: "interrupted",
								exitCode: 1,
								outputText: "",
								toolCallCount: 0,
								toolResultCount: 0,
								toolErrorCount: 0,
								durationMs: 0,
								startedAt: now,
								endedAt: now,
								sessionFile: prepared.sessionFile,
								error: { message: "Child agent interrupted before start", reason: "interrupted" },
							} satisfies ChildAgentResult;
						}
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
							abortSignal: childAbortSignal,
							onStatusUpdate: (patch) => layer0Ctx.statusWriter.enqueue({ ...patch, stepIndex: 0 }),
							registry: deps.childRegistry,
							pi: deps.pi,
						});
						return await childHandle.completed;
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
				},
			);
			return { item, originalStepIndex, handle };
		});

		void (async () => {
			logger.info("finalizeAsync: awaiting layer0 parallel handles", { runId: groupRunId });
			try {
				const settled = await Promise.allSettled(childRuns.map((child) => child.handle.completed));
				const results = settled.flatMap((entry) => (entry.status === "fulfilled" ? [entry.value] : []));
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
						return [
							{
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
							},
						];
					})
					.sort((a, b) => a.stepIndex - b.stepIndex);
				if (!parentRunId) {
					publishSubagentUsage(deps.pi, deps.state, {
						runId: groupRunId,
						rootRunId: groupRootRunId,
						...(() => {
							const rootSessionId = resolveDispatchRootSessionId(
								ctx,
								deps.state.currentSessionId ?? undefined,
							);
							return rootSessionId ? { rootSessionId } : {};
						})(),
						mode: "parallel",
						source: "async",
						totalUsage,
						timestamp: Date.now(),
					});
				}
				safeEmit(
					SUBAGENT_ASYNC_COMPLETE_EVENT,
					buildAsyncAggregateCompletePayload({
						id: groupRunId,
						runId: groupRunId,
						parentRunId,
						rootRunId: groupRootRunId,
						notifyPolicy,
						success: finalResult?.state === "complete",
						agent: steps.map(({ step }) => step.agentName).join(","),
						summary: finalResult?.outputText ?? "",
						state: finalResult?.state,
						results: childResults,
						children: childResults,
						total: childResults.length,
						completed: childResults.filter((child) => child.state === "complete").length,
						asyncDir: group.runRecordDir,
						metadata: params.metadata,
						syncFields: {
							exitCode: finalResult?.exitCode,
							durationMs: finalResult?.durationMs,
							sessionFile: finalResult?.sessionFile,
							shareUrl: finalResult?.shareUrl,
							result: finalResult,
							totalUsage,
							batch: params.batch === true,
							batchId: groupRunId,
						},
					}),
				);
			} catch (err) {
				logger.error(
					"finalizeAsync: layer0 parallel threw",
					err instanceof Error ? err : new Error(String(err)),
					{ runId: groupRunId },
				);
			} finally {
				releaseRunController(groupRunId);
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
		return asyncStartedResult({
			mode,
			runId: groupRunId,
			asyncDir: group.runRecordDir,
			text: handleText,
			children: childDetails,
		});
	}
	const runRecordDir = first.step.runRecordDir;
	const startedAt = Date.now();
	const asyncParentSessionId = ctx.sessionManager?.getSessionId ? ctx.sessionManager.getSessionId() : undefined;
	const asyncRootSessionId = resolveDispatchRootSessionId(ctx, deps.state.currentSessionId ?? undefined);
	const initializeMeta = {
		mode,
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
	};
	const runHandle = openRunRecord(
		{
			agentName: first.step.agentName,
			task: first.step.task,
			cwd: effectiveCwd,
			...(runLabel ? { label: runLabel } : {}),
		},
		{
			runId,
			runRecordDir,
			sessionFile: first.step.sessionFile,
			rootRunId,
			...(parentRunId ? { parentRunId } : {}),
			...(asyncParentSessionId ? { parentSessionId: asyncParentSessionId } : {}),
			...(asyncRootSessionId ? { rootSessionId: asyncRootSessionId } : {}),
			source: "async",
			variant: "async-detached",
			initialize: initializeMeta,
		},
	);
	const statusWriter = runHandle.statusWriter;
	// Seed metadata for the registry's in-memory RunView mirror (async-only). Same
	// StatusMeta as status.json plus the session-hierarchy + dir fields RunView carries.
	const runViewSeed = {
		...initializeMeta,
		state: "queued" as const,
		...(asyncParentSessionId ? { parentSessionId: asyncParentSessionId } : {}),
		...(asyncRootSessionId ? { rootSessionId: asyncRootSessionId } : {}),
		asyncDir: runRecordDir,
	};
	emitRunAnchor(deps.pi, { runId, rootRunId, mode, source: "async", parentRunId });

	// Async children deliberately do NOT receive the parent turn's AbortSignal.
	// They survive ESC/cancel of the parent turn (matching the stated semantics:
	// "spawn async and hand control back; Pi wakes the parent when children finish").
	// Cancellation is still possible via childRegistry per-run controllers, exposed
	// through subagent({ action: "interrupt", runId }) and { runId: "all" }.
	const asyncDetachedAbort = new AbortController();
	// This dispatch does not go through spawnRun, so the detached controller
	// must be registered in the shared layer0 map here or a reload leaves the
	// run uninterruptible (the per-activation childRegistry dies on reload).
	registerRunController(runId, asyncDetachedAbort);
	const asyncCtx = {
		extensionCtx: ctx,
		abortSignal: asyncDetachedAbort.signal,
		onStatusUpdate: (patch: Parameters<StatusWriter["enqueue"]>[0]) => statusWriter.enqueue(patch),
		registry: deps.childRegistry,
		runViewSeed,
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
			for (const entry of settled) {
				if (entry.status !== "fulfilled" || entry.value.exitCode !== 0) continue;
				const step = steps.find((candidate) => candidate.step.stepIndex === entry.value.stepIndex);
				if (!step?.step.outputPath) continue;
				entry.value.outputText = resolveSingleOutput(
					step.step.outputPath,
					entry.value.outputText,
					step.outputSnapshot,
				).fullOutput;
			}
			const results = settled.flatMap((entry) => (entry.status === "fulfilled" ? [entry.value] : []));
			finalResult = results.find((result) => result.state !== "complete") ?? results.at(-1);
			if (!finalResult && settled[0]?.status === "rejected") {
				const now = Date.now();
				finalResult = {
					runId,
					stepIndex: 0,
					state: "failed",
					exitCode: 1,
					outputText: "",
					toolCallCount: 0,
					toolResultCount: 0,
					toolErrorCount: 0,
					durationMs: now - startedAt,
					startedAt,
					endedAt: now,
					sessionFile: first.step.sessionFile,
					error: { message: String(settled[0].reason) },
				};
			}
			// Canonical run-level usage aggregate across all child agents (single,
			// or each step of parallel/parallel). For single mode this is just the
			// final result's usage; for parallel/parallel we sum across results since
			// each step is its own ChildAgentResult with its own usage.
			const totalUsage: Usage = emptyUsage();
			if (mode === "parallel") {
				for (const entry of settled) {
					if (entry.status !== "fulfilled") continue;
					if (entry.value.usage) addUsageInto(totalUsage, entry.value.usage as Usage);
				}
			} else if (finalResult?.usage) {
				addUsageInto(totalUsage, finalResult.usage as Usage);
			}
			if (finalResult) finalizeRun(runHandle, { via: "result", result: finalResult, totalUsage });
			logger.info("finalizeAsync: emitting COMPLETE", {
				runId,
				success: finalResult?.state === "complete",
				state: finalResult?.state,
			});
			const completeAgent =
				mode === "parallel" ? steps.map(({ step }) => step.agentName).join(",") : first.step.agentName;
			const childResults = settled
				.flatMap((entry) => (entry.status === "fulfilled" ? [entry.value] : []))
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
			if (!parentRunId) {
				publishSubagentUsage(deps.pi, deps.state, {
					runId,
					rootRunId,
					...(() => {
						const rootSessionId = resolveDispatchRootSessionId(
							ctx,
							deps.state.currentSessionId ?? undefined,
						);
						return rootSessionId ? { rootSessionId } : {};
					})(),
					mode,
					source: "async",
					totalUsage,
					timestamp: Date.now(),
				});
			}
			safeEmit(
				SUBAGENT_ASYNC_COMPLETE_EVENT,
				buildAsyncAggregateCompletePayload({
					id: runId,
					runId,
					parentRunId,
					rootRunId,
					notifyPolicy: batchToNotifyPolicy(params.batch),
					success: finalResult?.state === "complete",
					agent: completeAgent,
					summary: finalResult?.outputText ?? "",
					state: finalResult?.state,
					results: childResults,
					children: childResults,
					total: childResults.length,
					completed: childResults.filter((child) => child.state === "complete").length,
					asyncDir: runRecordDir,
					metadata: params.metadata,
					syncFields: {
						exitCode: finalResult?.exitCode,
						durationMs: finalResult?.durationMs,
						sessionFile: finalResult?.sessionFile,
						shareUrl: finalResult?.shareUrl,
						result: finalResult,
						totalUsage,
						batch: params.batch === true,
						batchId: runId,
					},
				}),
			);
		} catch (err) {
			logger.error("finalizeAsync: threw", err instanceof Error ? err : new Error(String(err)), { runId });
		} finally {
			releaseRunController(runId);
			statusWriter.dispose();
			deps.childRegistry.delete(runId);
		}
	};

	// Only the single-dispatch path reaches here; parallel (hasTasks) returns above.
	const handlesPromise: Promise<ChildAgentHandle[]> = Promise.resolve([dispatchAsyncChild(first.step, asyncCtx)]);
	void finalizeAsync(handlesPromise);

	safeEmit(SUBAGENT_ASYNC_STARTED_EVENT, {
		id: runId,
		runId,
		metadata: params.metadata,
		controlConfig,
		agent: first.step.agentName,
		task: first.cleanTask.slice(0, 50),
		cwd: effectiveCwd,
		asyncDir: runRecordDir,
	});

	const handleText =
		mode === "single"
			? `Async: ${first.step.agentName} [${runId}]`
			: `Async parallel: ${formatRunHandle({ mode: "parallel", agents: steps.map(({ step }) => step.agentName), style: "verbose" })} [${runId}]`;
	return asyncStartedResult({ mode, runId, asyncDir: runRecordDir, text: handleText });
}
