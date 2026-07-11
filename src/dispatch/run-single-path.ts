import { normalizeAvailableModels, resolveModelCandidate } from "./model-fallback.ts";
import { recordRun } from "../state/run-history.ts";
import { normalizeSkillInput } from "../shared/skills.ts";
import type { ExecutionContextData, ExecutorDeps } from "./executor-types.ts";
import {
	createForegroundControlNotifier,
	emitSyncLifecycleEvent,
	interruptForegroundOnNeedsAttention,
	mirrorForegroundProgressToStatus,
	shapeSingleForegroundResult,
} from "./executor-helpers.ts";
import { runInProcessChildStep } from "./child-step-runner.ts";
import { resolveSubagentIntercomTarget } from "./intercom-bridge.ts";
import { injectSingleOutputInstruction, resolveSingleOutputPath } from "../surfaces/single-output.ts";
import { tokenUsageFromTotal } from "../state/usage-totals.ts";
import { getLineageForSession } from "../state/lineage.ts";
import { createForegroundRunController } from "./foreground-run-controller.ts";
import {
	type AgentProgress,
	type ArtifactPaths,
	SUBAGENT_COMPLETED_EVENT,
	SUBAGENT_FAILED_EVENT,
	SUBAGENT_SPAWN_STARTED_EVENT,
	resolveChildMaxSubagentDepth,
	wrapForkTask,
	type SubagentToolResult,
} from "../protocol/types.ts";
import { resolveCurrentMaxSubagentDepth } from "../shared/runtime-env.ts";

export async function runSinglePath(data: ExecutionContextData, deps: ExecutorDeps): Promise<SubagentToolResult> {
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
	const sessionId = ctx.sessionManager.getSessionId();
	const currentMaxSubagentDepth = resolveCurrentMaxSubagentDepth(
		deps.config.maxSubagentDepth,
		sessionId ? getLineageForSession(sessionId) : null,
	);
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
			? (update: SubagentToolResult) => {
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

	return shapeSingleForegroundResult({
		r,
		runId,
		agent: params.agent!,
		outputPath,
		progress: params.includeProgress ? allProgress : undefined,
		artifacts: allArtifactPaths.length ? { dir: artifactsDir, files: allArtifactPaths } : undefined,
	});
}
