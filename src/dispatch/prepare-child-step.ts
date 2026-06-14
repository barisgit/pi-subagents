import * as path from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../shared/agents.ts";
import type { ResolvedSkill } from "../shared/skills.ts";
import { buildModelCandidates, resolveModelRef } from "./model-fallback.ts";
import { buildSkillInjection, resolveSkillsWithFallback } from "../shared/skills.ts";
import { appendSubmitResultSystemInstruction } from "../protocol/submit-result.ts";
import { resolveChildSessionFile } from "../state/session-paths.ts";
import type { ChildAgentStep } from "./in-process-executor.ts";
import { resolveChildTools, resolveDispatchRootSessionId, type ExecutionContextData, type ExecutorDeps } from "./subagent-executor.ts";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];
function applyThinkingSuffix(model: string | undefined, thinking: string | undefined): string | undefined {
	if (!model || !thinking || thinking === "off") return model;
	const colonIdx = model.lastIndexOf(":");
	if (colonIdx !== -1 && THINKING_LEVELS.includes(model.substring(colonIdx + 1))) return model;
	return `${model}:${thinking}`;
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

function resolveModelFromRef(ref: string | undefined, models: Model<any>[], fallback: Model<any> | undefined, modelRegistry?: ExtensionContext["modelRegistry"]): Model<any> | undefined {
	return resolveModelRef(ref, models, fallback, (provider, id) => modelRegistry?.find?.(provider, id));
}

/**
 * Shared child-step preparer: the single source of truth for the
 * `ChildAgentStep` object literal that was previously duplicated between
 * `buildAsyncChildStep` (async dispatch) and `runInProcessChildStep`
 * (foreground/in-process run). Owns model resolution, skill resolution,
 * systemPrompt assembly, child session-path resolution, tool resolution, and
 * the step literal itself. The four per-call differences are parameterized via
 * the input: the already-resolved `task`, the caller-computed `intercom`
 * object, the resolved `outputPath`, the normalized `skillNames`, and an
 * optional `layer0` override (foreground layer-0 reuses its run's
 * runId/sessionFile/runRecordDir/rootRunId). On model-resolution failure it
 * returns the `{ error: "no-model" }` sentinel and each caller maps it to its
 * own return shape.
 */
export type PrepareChildStepResult =
	| { step: ChildAgentStep; resolvedSkills: ResolvedSkill[]; missingSkills: string[]; modelRefs: string[] }
	| { error: "no-model" };

export function prepareChildStep(input: {
	data: ExecutionContextData;
	deps: ExecutorDeps;
	agentConfig: AgentConfig;
	stepIndex: number;
	cwd: string;
	/** Final task string (output instruction already injected by the caller). */
	task: string;
	/** Final skill names to resolve (caller-specific normalization already applied). */
	skillNames: string[];
	/** Caller-computed intercom target object, or undefined for no intercom. */
	intercom?: { selfTarget?: string; bridgeTarget?: string };
	outputPath?: string;
	label?: string;
	modelOverride?: string;
	maxSubagentDepth: number;
	/** Foreground layer-0 override for run identity + session paths. */
	layer0?: { runId: string; sessionFile: string; runRecordDir: string; rootRunId: string };
}): PrepareChildStepResult {
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
	const primaryModel = resolveModelFromRef(parsedPrimary.modelRef, availableModels, data.ctx.model, data.ctx.modelRegistry);
	if (!primaryModel) {
		return { error: "no-model" };
	}
	const modelCandidates = modelRefs.slice(1)
		.map((ref) => resolveModelFromRef(splitModelThinking(applyThinkingSuffix(ref, agentConfig.thinking), agentConfig.thinking).modelRef, availableModels, undefined, data.ctx.modelRegistry))
		.filter((model): model is Model<any> => Boolean(model));
	const { resolved: resolvedSkills, missing: missingSkills } = data.forkReuse
		? { resolved: [] as ResolvedSkill[], missing: [] as string[] }
		: resolveSkillsWithFallback(input.skillNames, input.cwd, data.ctx.cwd);
	const skillInjection = buildSkillInjection(resolvedSkills);
	const systemPromptBase = data.forkReuse ? "" : agentConfig.systemPrompt?.trim() || "";
	const systemPromptWithSkills = skillInjection ? (systemPromptBase ? `${systemPromptBase}\n\n${skillInjection}` : skillInjection) : systemPromptBase;
	// Fork-reuse keeps an empty systemPrompt to preserve the inherited session's prompt; don't clobber it.
	// Those children still get the finish contract from the always-present submit_result tool description.
	const systemPrompt = data.forkReuse ? systemPromptWithSkills : appendSubmitResultSystemInstruction(systemPromptWithSkills);
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
		runId: input.layer0?.runId ?? data.runId,
		stepIndex,
		agentName: agentConfig.name,
		agentConfig: agentConfig as unknown as ChildAgentStep["agentConfig"],
		task: input.task,
		cwd: input.cwd,
		model: primaryModel,
		modelCandidates,
		thinkingLevel: parsedPrimary.thinkingLevel,
		activeToolNames,
		customTools,
		systemPrompt,
		skillsResolved: resolvedSkills.map((skill) => skill.name),
		sessionFile: input.layer0?.sessionFile ?? sessionPaths.sessionFile,
		runRecordDir: input.layer0?.runRecordDir ?? sessionPaths.runRecordDir,
		...(data.forkReuse && data.sessionFileForIndex(stepIndex) ? { forkReuse: { sessionFile: data.sessionFileForIndex(stepIndex)!, agentName: data.forkReuse.agentName } } : {}),
		...(input.intercom ? { intercom: input.intercom } : {}),
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
	return { step, resolvedSkills, missingSkills, modelRefs };
}
