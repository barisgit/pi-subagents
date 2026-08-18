import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentScope } from "../shared/agents.ts";
import { getArtifactsDir } from "../shared/artifacts.ts";
import { resolveExecutionAgentScope } from "./agent-scope.ts";
import { handleManagementAction } from "../surfaces/agent-management.ts";
import { createForkContextResolver } from "./fork-context.ts";
import { ConcurrencySemaphore } from "./concurrency-semaphore.ts";
import { leafConcurrencyLimit, parkLeafPermit } from "./leaf-concurrency.ts";
import type { ExecutionContextData, ExecutorDeps, InternalSubagentParams } from "./executor-types.ts";
import {
	batchToNotifyPolicy,
	buildAsyncAggregateCompletePayload,
	emitRunAnchor,
	emptyUsage,
	publishSubagentUsage,
	resolveDispatchParentRunId,
	resolveDispatchRootRunId,
	resolveDispatchRootSessionId,
	safeEmit,
	singleResultToChildAgentResult,
	sumUsages,
	terminalStatusStepFromResult,
	validationError,
} from "./executor-helpers.ts";
import { runInProcessChildStep } from "./child-step-runner.ts";
import { applyIntercomBridgeToAgent, resolveIntercomBridge, resolveIntercomSessionTarget } from "./intercom-bridge.ts";
import { resolveControlConfig } from "./subagent-control.ts";
import { resolveChildSessionFile } from "../state/session-paths.ts";
import type { StatusWriter } from "../state/status-writer.ts";
import { getSingleResultOutput } from "../shared/utils.ts";
import { tokenUsageFromUsage } from "../state/usage-totals.ts";
import { inspectSubagentStatus } from "../state/run-status.ts";
import { applyForceTopLevelAsyncOverride } from "./top-level-async.ts";
import {
	spawnRun,
	openGroup,
	awaitRun,
	openRunRecord,
	finalizeRun,
	registerRunController,
	releaseRunController,
	type OpenRunHandle,
} from "./layer0-runs.ts";
import { getLineageForSession } from "../state/lineage.ts";
import type { SubagentToolInput } from "../protocol/schemas.ts";
import type { WorkflowGroupHandle } from "../workflow/workflow.ts";
import { writeWorkflowGroupState } from "../workflow/workflow-group-state.ts";
import { resumeRun } from "./resume-run.ts";
import { runAsyncPath } from "./run-async-path.ts";
import { runParallelPath } from "./run-parallel-path.ts";
import {
	type ArtifactConfig,
	type ForkReuseConfig,
	type SingleResult,
	DEFAULT_ARTIFACT_CONFIG,
	SUBAGENT_ASYNC_COMPLETE_EVENT,
	SUBAGENT_ASYNC_RUN_COMPLETE_EVENT,
	SUBAGENT_ASYNC_STARTED_EVENT,
	resolveChildMaxSubagentDepth,
	type SubagentToolResult,
} from "../protocol/types.ts";
import {
	checkNestedDelegationGuard,
	checkSubagentDepth,
	resolveCurrentMaxSubagentDepth,
} from "../shared/runtime-env.ts";
import {
	validateSubagentToolInput,
	normalizeRunDispatchParams,
	normalizeRepeatedParallelCounts,
	applySharedMessage,
	ALLOWED_CONTROL_ACTIONS,
} from "./dispatch-input.ts";
import {
	validateExecutionInput,
	buildRequestedModeError,
	collectRequestedAgentNames,
	normalizeName,
	resolveForkReuse,
	withForkContext,
	toExecutionErrorResult,
} from "./execution-input.ts";
import {
	getForegroundControl,
	foregroundStatusResult,
	interruptAllAsyncRuns,
	interruptAsyncRun,
} from "./interrupt-control.ts";
import { runSinglePath } from "./run-single-path.ts";

export { validateSubagentToolInput };

function resolveRequestedCwd(runtimeCwd: string, requestedCwd: string | undefined): string {
	return requestedCwd ? path.resolve(runtimeCwd, requestedCwd) : runtimeCwd;
}

export function createSubagentExecutor(deps: ExecutorDeps): {
	execute: (
		id: string,
		params: SubagentToolInput,
		signal: AbortSignal,
		onUpdate: ((r: SubagentToolResult) => void) | undefined,
		ctx: ExtensionContext,
	) => Promise<SubagentToolResult>;
	executeInternal: (
		id: string,
		params: InternalSubagentParams,
		signal: AbortSignal,
		onUpdate: ((r: SubagentToolResult) => void) | undefined,
		ctx: ExtensionContext,
	) => Promise<SubagentToolResult>;
	openWorkflowGroup: (args: {
		toolCallId: string;
		signal: AbortSignal;
		onUpdate?: (r: SubagentToolResult) => void;
		ctx: ExtensionContext;
		requestedAsync?: boolean;
	}) => WorkflowGroupHandle;
} {
	const executeImpl = async (
		_id: string,
		params: InternalSubagentParams,
		signal: AbortSignal,
		onUpdate: ((r: SubagentToolResult) => void) | undefined,
		ctx: ExtensionContext,
		internal: boolean,
	): Promise<SubagentToolResult> => {
		deps.state.baseCwd = ctx.cwd;
		deps.state.foregroundControls ??= new Map();
		deps.state.lastForegroundControlId ??= null;
		if (!internal) {
			const slimValidationError = validateSubagentToolInput(params);
			if (slimValidationError) return slimValidationError;
		}

		const requestCwd = resolveRequestedCwd(ctx.cwd, params.cwd);
		const paramsWithResolvedCwd = { ...params, cwd: requestCwd };
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
				const asyncInterruptResult = await interruptAsyncRun(deps.state, deps.childRegistry, targetRunId);
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
				// like normal dispatch's async resolution — so the two surfaces
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
						resolveDispatchRootSessionId(ctx, deps.state.currentSessionId ?? undefined),
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
		const currentSessionId = ctx.sessionManager.getSessionId();
		const currentLineage = currentSessionId ? getLineageForSession(currentSessionId) : null;

		const normalized = normalizeRepeatedParallelCounts(dispatchParams);
		if (normalized.error) return normalized.error;
		const normalizedParams = normalized.params!;

		const nestedGuard = checkNestedDelegationGuard(collectRequestedAgentNames(normalizedParams), currentLineage);
		if (nestedGuard.blocked) {
			return buildRequestedModeError(normalizedParams, nestedGuard.reason ?? "Nested subagent call blocked.");
		}
		const { blocked, depth, maxDepth } = checkSubagentDepth(deps.config.maxSubagentDepth, currentLineage);
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

		const effectiveParams = applyForceTopLevelAsyncOverride(
			normalizedParams,
			depth,
			deps.config.forceTopLevelAsync === true,
		);

		const scope: AgentScope = resolveExecutionAgentScope(effectiveParams.agentScope);
		const effectiveCwd = effectiveParams.cwd ?? ctx.cwd;
		const parentSessionFile = ctx.sessionManager.getSessionFile() ?? null;
		deps.state.currentSessionId =
			ctx.sessionManager.getSessionId() ?? deps.state.currentSessionId ?? `session-${randomUUID()}`;
		const discoveredAgents = deps.discoverAgents(requestCwd, scope, {
			preset: normalizedParams.preset,
			includeInternal: true,
		}).agents;
		const sessionName = resolveIntercomSessionTarget(deps.pi.getSessionName(), deps.state.currentSessionId);
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
		const calledFromChildSession = currentLineage
			? currentLineage.role === "child"
			: normalizeName(process.env.PI_SUBAGENT_CURRENT_AGENT) !== undefined;
		const resolvedAsync = effectiveParams.async ?? deps.asyncByDefault;
		const backgroundRequestedWhileClarifying =
			!calledFromChildSession && hasTasks && resolvedAsync && effectiveParams.clarify === true;
		// async:true only downgrades to sync when clarify is explicitly true (interactive
		// preview gates the run). Undefined clarify means "no clarify", so it must not
		// suppress async — single/parallel all share this rule.
		const effectiveAsync = calledFromChildSession ? false : resolvedAsync && effectiveParams.clarify !== true;
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
							const root = resolveDispatchRootSessionId(ctx, deps.state.currentSessionId ?? undefined);
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
			? (r: SubagentToolResult) => onUpdate(withForkContext(r, effectiveParams.context))
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
							const root = resolveDispatchRootSessionId(ctx, deps.state.currentSessionId ?? undefined);
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

		let executionResult: SubagentToolResult | undefined;
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
			const details = executionResult?.details;
			const totalUsage = details?.totalUsage;
			if (!parentRunId && details && totalUsage) {
				if (details.mode === "single" || details.mode === "parallel") {
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
						mode: details.workflow ? "workflow" : details.mode,
						source: "sync",
						totalUsage,
						timestamp: Date.now(),
					});
				}
			}
			if (foregroundControl) {
				if (foregroundMode !== "parallel" && fgWriter && runHandle) {
					// An interrupted single is neither a clean complete nor an error failure:
					// its result carries interrupted:true with no isError, so honor that first
					// (mirrors the workflow/group path) instead of falling through to
					// 'complete'. 'interrupted' is a terminal, resumable state.
					const terminalResults = executionResult?.details?.results ?? [];
					const interrupted = terminalResults.some((result) => result.interrupted);
					const totalUsage =
						executionResult?.details?.totalUsage ??
						sumUsages(...terminalResults.map((result) => result.usage));
					const totalTokens = tokenUsageFromUsage(totalUsage);
					const primaryResult = terminalResults[0];
					finalizeRun(runHandle, {
						via: "terminal",
						state: interrupted ? "interrupted" : executionResult?.isError ? "failed" : "complete",
						steps: terminalResults.map(terminalStatusStepFromResult),
						totalUsage,
						...(totalTokens ? { totalTokens } : {}),
						...(primaryResult ? { outputText: getSingleResultOutput(primaryResult) } : {}),
						...(primaryResult?.error ? { error: primaryResult.error } : {}),
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
			const currentSessionId = ctx.sessionManager.getSessionId();
			const currentLineage = currentSessionId ? getLineageForSession(currentSessionId) : null;
			const nestedGuard = checkNestedDelegationGuard([], currentLineage);
			if (nestedGuard.blocked) {
				throw new Error(nestedGuard.reason ?? "Nested subagent call blocked.");
			}
			const { blocked, depth, maxDepth } = checkSubagentDepth(deps.config.maxSubagentDepth, currentLineage);
			if (blocked) {
				throw new Error(
					`Nested subagent call blocked (depth=${depth}, max=${maxDepth}). ` +
						"You are running at the maximum subagent nesting depth.",
				);
			}
			deps.state.baseCwd = ctx.cwd;
			deps.state.currentSessionId = currentSessionId ?? deps.state.currentSessionId ?? `session-${randomUUID()}`;
			const effectiveCwd = ctx.cwd;
			const agents = deps.discoverAgents(effectiveCwd, "both", { includeInternal: true }).agents;
			const parentSessionFile = ctx.sessionManager.getSessionFile() ?? null;
			const provisionalRunId = randomUUID();
			const parentRunId = resolveDispatchParentRunId(ctx);
			const rootRunId = resolveDispatchRootRunId(ctx, provisionalRunId);
			const calledFromChildSession = currentLineage
				? currentLineage.role === "child"
				: normalizeName(process.env.PI_SUBAGENT_CURRENT_AGENT) !== undefined;
			const resolvedAsync = requestedAsync ?? deps.asyncByDefault;
			const effectiveAsync = calledFromChildSession ? false : resolvedAsync;
			const workflowDetachedAbort = new AbortController();
			const activeLimit = leafConcurrencyLimit(deps.config.maxConcurrentAgents);
			const workflowAdmission = new ConcurrencySemaphore(activeLimit);
			const configuredPipelineInFlight = deps.config.workflow?.maxPipelineItemsInFlight;
			const maxPipelineItemsInFlight =
				typeof configuredPipelineInFlight === "number" &&
				Number.isInteger(configuredPipelineInFlight) &&
				configuredPipelineInFlight > 0
					? configuredPipelineInFlight
					: 8;
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
					const root = resolveDispatchRootSessionId(ctx, deps.state.currentSessionId ?? undefined);
					return root ? { rootSessionId: root } : {};
				})(),
				kind: "workflow",
				source: effectiveAsync ? "async" : "sync",
				mode: "parallel",
			});
			if (effectiveAsync) registerRunController(group.runId, workflowDetachedAbort);
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
				maxPipelineItemsInFlight,
				async: effectiveAsync,
				asyncDir: group.runRecordDir,
				// Park the calling agent's leaf permit while a sync workflow awaits its
				// children (no-op for a top-level workflow with no parent permit).
				parkWhileRunning: <T>(fn: () => Promise<T>) => parkLeafPermit(parentRunId, fn),
				dispatchChild: async ({
					role,
					task,
					index,
					phaseIndex,
					phaseTitle,
					parallelGroupId,
					pipeline,
					resultSchema,
					onChildProgress,
				}) => {
					const admissionPermit = await workflowAdmission.acquire(data.signal);
					if (!admissionPermit) {
						throw data.signal.reason instanceof Error ? data.signal.reason : new Error("Workflow aborted");
					}
					if (data.signal.aborted) {
						admissionPermit.release();
						throw data.signal.reason instanceof Error ? data.signal.reason : new Error("Workflow aborted");
					}
					try {
						const childGuard = checkNestedDelegationGuard([role], currentLineage);
						if (childGuard.blocked) {
							throw new Error(childGuard.reason ?? "Nested subagent call blocked.");
						}
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
								...(pipeline ? { pipeline } : {}),
								...(deps.config.defaultSessionDir
									? {
											defaultSessionDir: path.resolve(
												deps.expandTilde(deps.config.defaultSessionDir),
											),
										}
									: {}),
								...(ctx.sessionManager?.getSessionId
									? { parentSessionId: ctx.sessionManager.getSessionId() }
									: {}),
								...(() => {
									const root = resolveDispatchRootSessionId(
										ctx,
										deps.state.currentSessionId ?? undefined,
									);
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
											usage: {
												input: 0,
												output: 0,
												cacheRead: 0,
												cacheWrite: 0,
												cost: 0,
												turns: 0,
											},
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
											resolveCurrentMaxSubagentDepth(
												deps.config.maxSubagentDepth,
												currentLineage,
											),
											agentConfig.maxSubagentDepth,
										),
										mode: "parallel",
										...(resultSchema ? { resultSchema } : {}),
										...(onChildProgress
											? {
													// Sync workflow live update: surface the running child's per-event
													// progress so the workflow widget repaints mid-run instead of
													// freezing between childStarted and childSettled.
													onUpdate: (update: SubagentToolResult) => {
														const live = update.details?.progress?.[0];
														if (live) onChildProgress(live);
													},
												}
											: {}),
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
					} finally {
						admissionPermit.release();
					}
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
								const root = resolveDispatchRootSessionId(
									ctx,
									deps.state.currentSessionId ?? undefined,
								);
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
					releaseRunController(group.runId);
					if (!effectiveAsync) return;
					writeWorkflowGroupState(group.runRecordDir, success ? "complete" : "failed");
					const ordered = [...childResults].sort((a, b) => a.index - b.index);
					const totalUsage = sumUsages(...ordered.map(({ result }) => result.usage));
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
					if (!parentRunId) {
						publishSubagentUsage(deps.pi, deps.state, {
							runId: group.runId,
							rootRunId: groupRootRunId,
							...(() => {
								const rootSessionId = resolveDispatchRootSessionId(
									ctx,
									deps.state.currentSessionId ?? undefined,
								);
								return rootSessionId ? { rootSessionId } : {};
							})(),
							mode: "workflow",
							source: "async",
							totalUsage,
							timestamp: Date.now(),
						});
					}
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
