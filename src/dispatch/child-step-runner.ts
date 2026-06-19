import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import type { AgentConfig } from "../shared/agents.ts";
import {
	type AgentProgress,
	type ArtifactConfig,
	type ArtifactPaths,
	type ControlEvent,
	type Details,
	type MaxOutputConfig,
	type SingleResult,
	type Usage,
	DEFAULT_MAX_OUTPUT,
	truncateOutput,
} from "../protocol/types.ts";
import type { ChildAgentResult, StatusPatch } from "../protocol/status-types.ts";
import type { AsyncDispatchStep, ExecutionContextData, ExecutorDeps } from "./executor-types.ts";
import { emptyUsage, getRequestedModeLabel } from "./executor-helpers.ts";
import { prepareChildStep } from "./prepare-child-step.ts";
import { runChildAgent } from "./in-process-executor.ts";
import { resolveSubagentIntercomTarget } from "./intercom-bridge.ts";
import { createActivityTicker } from "./subagent-control.ts";
import { resolveStepBehavior } from "../shared/settings.ts";
import {
	captureSingleOutputSnapshot,
	injectSingleOutputInstruction,
	resolveSingleOutput,
	resolveSingleOutputPath,
} from "../surfaces/single-output.ts";
import { SUBMIT_RESULT_TOOL_NAME } from "../protocol/submit-result.ts";
import { ensureArtifactsDir, getArtifactPaths, writeArtifact, writeMetadata } from "../shared/artifacts.ts";
import { resolveAgentColor } from "../shared/agents.ts";
import { extractTextFromContent, getFinalOutput } from "../shared/utils.ts";
import { tokenUsageFromUsage, totalUsageTokens } from "../state/usage-totals.ts";

export function buildAsyncChildStep(input: {
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
}): AsyncDispatchStep | { error: AgentToolResult<Details> } {
	const { data, deps, agentConfig, stepIndex } = input;
	const rawSkills =
		input.skills !== undefined ? input.skills : resolveStepBehavior(agentConfig, { skills: undefined }).skills;
	const skillNames = data.forkReuse || rawSkills === false ? [] : (rawSkills ?? agentConfig.skills ?? []);
	const outputPath = resolveSingleOutputPath(input.output, data.ctx.cwd, input.cwd);
	const cleanTask = input.task;
	const task = injectSingleOutputInstruction(cleanTask, outputPath);
	const prepared = prepareChildStep({
		data,
		deps,
		agentConfig,
		stepIndex,
		cwd: input.cwd,
		task,
		skillNames,
		intercom: data.intercomBridge.active
			? {
					selfTarget: resolveSubagentIntercomTarget(data.runId, agentConfig.name, stepIndex),
					bridgeTarget: data.intercomBridge.orchestratorTarget,
				}
			: undefined,
		...(outputPath ? { outputPath } : {}),
		...(input.label ? { label: input.label } : {}),
		...(input.modelOverride !== undefined ? { modelOverride: input.modelOverride } : {}),
		maxSubagentDepth: input.maxSubagentDepth,
	});
	if ("error" in prepared) {
		return {
			error: {
				content: [{ type: "text", text: "No model available for child agent." }],
				isError: true,
				details: { mode: getRequestedModeLabel(data.params), results: [] },
			},
		};
	}
	return { step: prepared.step, cleanTask, agentConfig, outputSnapshot: captureSingleOutputSnapshot(outputPath) };
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
	const lines = text
		.split("\n")
		.slice(-10)
		.filter((line) => line.trim());
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

export async function runInProcessChildStep(input: {
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
	onLayer0StatusUpdate?: (patch: StatusPatch) => void;
	/** Workflow-authored result schema for submit_result (workflow path only). */
	resultSchema?: TSchema;
}): Promise<SingleResult> {
	const { data, deps, agentConfig, stepIndex } = input;
	const skillNames = input.skills ?? agentConfig.skills ?? [];
	const prepared = prepareChildStep({
		data,
		deps,
		agentConfig,
		stepIndex,
		cwd: input.cwd,
		task: input.task,
		skillNames,
		intercom:
			input.intercomSessionName || data.intercomBridge.orchestratorTarget
				? { selfTarget: input.intercomSessionName, bridgeTarget: data.intercomBridge.orchestratorTarget }
				: undefined,
		...(input.outputPath ? { outputPath: input.outputPath } : {}),
		...(input.label ? { label: input.label } : {}),
		...(input.modelOverride !== undefined ? { modelOverride: input.modelOverride } : {}),
		maxSubagentDepth: input.maxSubagentDepth,
		...(input.layer0 ? { layer0: input.layer0 } : {}),
		...(input.resultSchema ? { resultSchema: input.resultSchema } : {}),
	});
	if ("error" in prepared) {
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
	const { step, missingSkills, modelRefs } = prepared;
	const primaryModel = step.model;
	const childRunId = step.runId;

	let artifactPathsResult: ArtifactPaths | undefined;
	if (data.artifactConfig.enabled) {
		artifactPathsResult = getArtifactPaths(data.artifactsDir, data.runId, agentConfig.name, stepIndex);
		ensureArtifactsDir(data.artifactsDir);
		if (data.artifactConfig.includeInput !== false)
			writeArtifact(artifactPathsResult.inputPath, `# Task for ${agentConfig.name}\n\n${input.cleanTask}`);
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
					const toolName = typeof record.toolName === "string" ? record.toolName : undefined;
					if (toolName !== SUBMIT_RESULT_TOOL_NAME) {
						progress.toolCount++;
						progress.currentTool = toolName;
						progress.currentToolRawArgs =
							record.args && typeof record.args === "object" && !Array.isArray(record.args)
								? (record.args as Record<string, unknown>)
								: undefined;
						progress.currentToolArgs = progress.currentToolRawArgs
							? JSON.stringify(progress.currentToolRawArgs).slice(0, 200)
							: undefined;
						progress.currentToolStartedAt = now;
					}
					emitUpdate();
				} else if (record.type === "tool_execution_end") {
					if (progress.currentTool) {
						const durationMs =
							progress.currentToolStartedAt !== undefined
								? Math.max(0, now - progress.currentToolStartedAt)
								: undefined;
						progress.recentTools.push({
							tool: progress.currentTool,
							args: progress.currentToolArgs || "",
							rawArgs: progress.currentToolRawArgs,
							endMs: now,
							durationMs,
						});
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
							// Persist live token usage to this child's status.json so nested-child
							// readers (which only see the on-disk status, not in-memory progress)
							// show running token counts instead of ~0 until finalize.
							const liveTokens = tokenUsageFromUsage(usage);
							if (liveTokens)
								input.onLayer0StatusUpdate?.({ runId: childRunId, stepIndex, tokens: liveTokens });
						}
						appendProgressOutput(progress, extractTextFromContent(message.content));
					}
					emitUpdate();
				}
			},
			onStatusUpdate: (patch) => {
				applyStatusPatchToProgress(patch);
				input.onLayer0StatusUpdate?.(patch);
			},
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

function childResultToSingleResult(
	childResult: ChildAgentResult,
	input: {
		resultShell: SingleResult;
		progress: AgentProgress;
		startedAt: number;
		artifactPathsResult?: ArtifactPaths;
		artifactConfig: ArtifactConfig;
		maxOutput?: MaxOutputConfig;
		outputPath?: string;
		outputSnapshot?: ReturnType<typeof captureSingleOutputSnapshot>;
	},
): SingleResult {
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
		if (input.artifactConfig.includeOutput !== false)
			writeArtifact(input.artifactPathsResult.outputPath, result.finalOutput ?? "");
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
		const truncationResult = truncateOutput(
			result.finalOutput ?? "",
			{ ...DEFAULT_MAX_OUTPUT, ...input.maxOutput },
			input.artifactPathsResult?.outputPath,
		);
		if (truncationResult.truncated) result.truncation = truncationResult;
	}
	return result;
}
