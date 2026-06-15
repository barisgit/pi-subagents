import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../shared/agents.ts";
import { normalizeAvailableModels, resolveModelCandidate } from "./model-fallback.ts";
import { aggregateParallelOutputs, mapConcurrent } from "./parallel-utils.ts";
import { recordRun } from "../state/run-history.ts";
import { resolveStepBehavior } from "../shared/settings.ts";
import { normalizeSkillInput } from "../shared/skills.ts";
import { resolveSubagentIntercomTarget } from "./intercom-bridge.ts";
import { compactForegroundDetails, getSingleResultOutput, resolveChildCwd } from "../shared/utils.ts";
import { interruptRun, spawnRun, awaitRun } from "./layer0-runs.ts";
import { createForegroundRunController } from "./foreground-run-controller.ts";
import {
	type AgentProgress,
	type ArtifactPaths,
	type ControlEvent,
	type Details,
	type ExtensionConfig,
	type SingleResult,
	type SubagentState,
	resolveTopLevelParallelConcurrency,
	resolveTopLevelParallelMaxTasks,
	resolveChildMaxSubagentDepth,
	wrapForkTask,
} from "../protocol/types.ts";
import { resolveCurrentMaxSubagentDepth } from "../shared/runtime-env.ts";
import {
	cleanupWorktrees,
	createWorktrees,
	diffWorktrees,
	formatWorktreeDiffSummary,
	type WorktreeSetup,
} from "./worktree.ts";
import type { ExecutionContextData, ExecutorDeps, TaskParam } from "./executor-types.ts";
import {
	buildParallelModeError,
	buildParallelWorktreeTaskCwdError,
	createForegroundControlNotifier,
	resolveDispatchRootSessionId,
	singleResultToChildAgentResult,
} from "./executor-helpers.ts";
import { runInProcessChildStep } from "./child-step-runner.ts";

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

export function createParallelWorktreeSetup(
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
				setupHook: setupHook ? { hookPath: setupHook, timeoutMs: setupHookTimeoutMs } : undefined,
			}),
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { errorResult: buildParallelModeError(message) };
	}
}

export function resolveParallelTaskCwd(
	task: TaskParam,
	paramsCwd: string | undefined,
	worktreeSetup: WorktreeSetup | undefined,
	index: number,
): string | undefined {
	if (worktreeSetup) return worktreeSetup.worktrees[index]!.agentCwd;
	if (!paramsCwd) return task.cwd;
	return resolveChildCwd(paramsCwd, task.cwd);
}

export function buildParallelWorktreeSuffix(
	worktreeSetup: WorktreeSetup | undefined,
	artifactsDir: string,
	tasks: TaskParam[],
): string {
	if (!worktreeSetup) return "";
	const diffsDir = path.join(artifactsDir, "worktree-diffs");
	const diffs = diffWorktrees(
		worktreeSetup,
		tasks.map((task) => task.agent),
		diffsDir,
	);
	return formatWorktreeDiffSummary(diffs);
}

async function runForegroundParallelTasks(input: ForegroundParallelRunInput): Promise<SingleResult[]> {
	return mapConcurrent(input.tasks, input.concurrencyLimit, async (task, index) => {
		let childRunId = input.runId;
		const fg = createForegroundRunController(input.foregroundControl);
		try {
			const overrideSkills = input.skillOverrides[index];
			const effectiveSkills = overrideSkills === undefined ? input.behaviors[index]?.skills : overrideSkills;
			const taskCwd = resolveParallelTaskCwd(task, input.paramsCwd, input.worktreeSetup, index);
			fg.beginStep(task.agent, index, () => {
				const interrupted = interruptRun(childRunId, { cascade: true }).interruptedRunIds.length > 0;
				if (!interrupted) return false;
				input.foregroundControl!.currentActivityState = undefined;
				input.foregroundControl!.updatedAt = Date.now();
				return true;
			});
			let result: SingleResult | undefined;
			const handle = spawnRun(
				{
					agentName: task.agent,
					task: input.taskTexts[index]!,
					cwd: taskCwd ?? input.ctx.cwd,
					...(task.label ? { label: task.label } : {}),
				},
				{
					parentRunId: input.runId,
					rootRunId: input.rootRunId,
					notifyPolicy: "each",
					parentSessionFile: input.ctx.sessionManager.getSessionFile() ?? null,
					...(input.data.params.sessionDir
						? { sessionDir: path.resolve(input.deps.expandTilde(input.data.params.sessionDir)) }
						: {}),
					...(input.deps.config.defaultSessionDir
						? {
								defaultSessionDir: path.resolve(
									input.deps.expandTilde(input.deps.config.defaultSessionDir),
								),
							}
						: {}),
					...(input.ctx.sessionManager?.getSessionId
						? { parentSessionId: input.ctx.sessionManager.getSessionId() }
						: {}),
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
									fg.markNeedsAttention();
									return;
								}
								input.onControlEvent?.(event);
							},
							intercomSessionName: input.childIntercomTarget?.(task.agent, index),
							modelOverride: input.modelOverrides[index],
							skills: effectiveSkills === false ? [] : effectiveSkills,
							mode: "parallel",
							layer0: {
								runId: prepared.runId,
								runRecordDir: prepared.runRecordDir,
								sessionFile: prepared.sessionFile,
								rootRunId: input.rootRunId,
							},
							onLayer0StatusUpdate: (patch) => layer0Ctx.statusWriter.enqueue({ ...patch, stepIndex: 0 }),
							onUpdate:
								input.onUpdate || input.foregroundControl
									? (progressUpdate) => {
											const stepResults = progressUpdate.details?.results || [];
											const stepProgress = progressUpdate.details?.progress || [];
											if (input.foregroundControl && stepProgress.length > 0) {
												fg.applyProgress(
													task.agent,
													index,
													stepProgress[0],
													stepResults[0]?.finalOutput,
												);
											}
											if (stepResults.length > 0) input.liveResults[index] = stepResults[0];
											if (stepProgress.length > 0) input.liveProgress[index] = stepProgress[0];
											const mergedResults = input.liveResults.filter(
												(result): result is SingleResult => result !== undefined,
											);
											const mergedProgress = input.liveProgress.filter(
												(progress): progress is AgentProgress => progress !== undefined,
											);
											input.onUpdate?.({
												content: progressUpdate.content,
												details: {
													mode: "parallel",
													runId: input.runId,
													results: mergedResults,
													progress: mergedProgress,
													controlEvents: progressUpdate.details?.controlEvents,
												},
											});
										}
									: undefined,
						});
						input.liveResults[index] = result;
						input.liveProgress[index] = result.progress;
						const mergedResults = input.liveResults.filter(
							(result): result is SingleResult => result !== undefined,
						);
						const mergedProgress = input.liveProgress.filter(
							(progress): progress is AgentProgress => progress !== undefined,
						);
						input.onUpdate?.({
							content: [{ type: "text", text: getSingleResultOutput(result) || "(completed)" }],
							details: {
								mode: "parallel",
								runId: input.runId,
								results: mergedResults,
								progress: mergedProgress,
							},
						});
						return singleResultToChildAgentResult(result, prepared);
					},
				},
			);
			await awaitRun(handle);
			if (!result) throw new Error(`Child agent did not produce a result for ${handle.runId}`);
			return result;
		} finally {
			fg.finalizeStep(index);
		}
	});
}

export async function runParallelPath(
	data: ExecutionContextData,
	deps: ExecutorDeps,
): Promise<AgentToolResult<Details>> {
	const { params, effectiveCwd, agents, ctx, runId, artifactsDir, backgroundRequestedWhileClarifying, onUpdate } =
		data;
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
	const availableModels = normalizeAvailableModels(ctx.modelRegistry.getAvailable());
	const taskTexts = tasks.map((t) => t.task);
	const modelOverrides: (string | undefined)[] = tasks.map((t, i) =>
		resolveModelCandidate(t.model ?? agentConfigs[i]?.model, availableModels, currentProvider),
	);
	const skillOverrides: (string[] | false | undefined)[] = tasks.map((t) => normalizeSkillInput(t.skill));

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
			childIntercomTarget: childIntercomTarget
				? (agent, index) => childIntercomTarget(runId, agent, index)
				: undefined,
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
				content: [
					{
						type: "text",
						text: `Parallel run paused after interrupt (${interrupted.agent}). Waiting for explicit next action.`,
					},
				],
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
		const downgradeNote = backgroundRequestedWhileClarifying
			? " (background requested, but clarify kept this run foreground)"
			: "";
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
