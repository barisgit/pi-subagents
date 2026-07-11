import { constants as fsConstants, copyFileSync, existsSync, mkdirSync } from "node:fs";
import * as path from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
	type AgentSessionEvent,
	type ExtensionAPI,
	type ExtensionContext,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

// Pi SDK contract: tools are referenced by string name; the session resolves builtins and
// extension-registered tools against its _toolRegistry. The `tools` option at
// createAgentSession is the allowlist that gates _both_ builtins AND extension tools
// (via _refreshToolRegistry's isAllowedTool check). So we pass the full requested name
// list unfiltered; extension tools like ast_grep/fetch/mcp/scan_files register during
// session_start and only pass the gate if their name is in this list.
import { logger } from "../shared/logger.ts";
import { runInChildSessionContext } from "../shared/child-session-context.ts";
import {
	getLineageForSession,
	pushPendingChildLineage,
	removeChildLineageBindings,
	removePendingChildLineage,
	setChildLineage,
} from "../state/lineage.ts";
import { advanceRunPhase, initialRunPhaseState, type RunPhaseState } from "../state/run-phase.ts";
import {
	SUBAGENT_PHASE_CHANGE_EVENT,
	SUBAGENT_STUCK_EVENT,
	type ControlConfig,
	type SubagentLineage,
	type SubagentPhaseChangePayload,
	type SubagentStuckPayload,
	normalizeAgentIdentity,
} from "../protocol/types.ts";
import type {
	ChildAgentExitState,
	ChildAgentResult,
	ChildUsage,
	RunPhase,
	StatusPatch,
} from "../protocol/status-types.ts";
export type { ChildAgentResult, StatusPatch } from "../protocol/status-types.ts";
import {
	fallbackSubmitResultEnvelope,
	hasOutputBlock,
	OUTPUT_REPROMPT,
	parseOutputEnvelope,
	schemaReprompt,
	type SubmitResultEnvelope,
} from "../protocol/output-contract.ts";
import { ChildAgentRegistry } from "./child-agent-registry.ts";
import type { ChildAgentContext, ChildAgentHandle } from "./child-agent-registry.ts";
import { addUsageInto, nestedSubagentUsageFromToolEvent } from "./executor-helpers.ts";
import { acquireLeafPermit } from "./leaf-concurrency.ts";
export { ChildAgentRegistry } from "./child-agent-registry.ts";
export type { ChildAgentContext, ChildAgentHandle } from "./child-agent-registry.ts";
import type { ChildAgentStep, ResolvedAgentConfig } from "./executor-types.ts";
export type { ChildAgentStep } from "./executor-types.ts";

type StatusPatchBody = Omit<StatusPatch, "runId" | "stepIndex">;

export interface PhaseEventHandlerOptions {
	runId: string;
	stepIndex: number;
	onStatusUpdate?: (patch: StatusPatch) => void;
	initialNow?: number;
	pi?: { events?: { emit(event: string, payload: unknown): void } };
}

export interface PhaseEventHandler {
	handle(event: AgentSessionEvent, now?: number, patch?: StatusPatchBody): StatusPatch | undefined;
	getState(): RunPhaseState;
}

function emitPhaseChange(pi: PhaseEventHandlerOptions["pi"] | undefined, payload: SubagentPhaseChangePayload): void {
	try {
		const events = pi?.events;
		if (!events || typeof events.emit !== "function") {
			logger.debug("Parent pi.events unavailable for phase-change event", {
				runId: payload.runId,
				stepIndex: payload.stepIndex,
				phase: payload.phase,
			});
			return;
		}
		events.emit(SUBAGENT_PHASE_CHANGE_EVENT, payload);
	} catch (error) {
		logger.debug("Failed to emit phase-change event on parent pi.events", {
			runId: payload.runId,
			stepIndex: payload.stepIndex,
			phase: payload.phase,
			error: formatError(error),
		});
	}
}

export function createPhaseEventHandler(options: PhaseEventHandlerOptions): PhaseEventHandler {
	let phaseState = initialRunPhaseState(options.initialNow ?? Date.now());

	return {
		handle(event: AgentSessionEvent, now = Date.now(), patchBody?: StatusPatchBody): StatusPatch | undefined {
			const nextState = advanceRunPhase(phaseState, event, now);
			phaseState = nextState;

			const transitioned = nextState.previousPhase !== undefined;
			if (!transitioned && patchBody === undefined) return undefined;
			if (transitioned) {
				emitPhaseChange(options.pi, {
					runId: options.runId,
					stepIndex: options.stepIndex,
					phase: nextState.phase,
					previousPhase: nextState.previousPhase,
					...(nextState.toolName !== undefined ? { toolName: nextState.toolName } : {}),
					ts: now,
				} satisfies SubagentPhaseChangePayload);
			}

			const patch: StatusPatch = {
				runId: options.runId,
				stepIndex: options.stepIndex,
				...(patchBody ?? {}),
				phase: nextState.phase,
				phaseStartedAt: nextState.phaseStartedAt,
				runnerHeartbeatAt: now,
				...(nextState.toolName !== undefined ? { toolName: nextState.toolName } : {}),
			};
			options.onStatusUpdate?.(patch);
			return patch;
		},
		getState(): RunPhaseState {
			return phaseState;
		},
	};
}

export interface PhaseTickerOptions {
	runId: string;
	stepIndex: number;
	intervalMs?: number;
	quietMs?: number;
	stuckThresholdMs?: number;
	getPhaseState: () => RunPhaseState;
	getLastEventAt: () => number;
	onStatusUpdate: (patch: StatusPatch) => void;
	onStuck?: (payload: SubagentStuckPayload) => void;
	now?: () => number;
	setIntervalFn?: typeof setInterval;
	clearIntervalFn?: typeof clearInterval;
}

export interface PhaseTickerHandle {
	stop(): void;
}

export function createPhaseTicker(options: PhaseTickerOptions): PhaseTickerHandle {
	const intervalMs = options.intervalMs ?? 5_000;
	const quietMs = options.quietMs ?? 4_000;
	const stuckThresholdMs = options.stuckThresholdMs ?? 60_000;
	const nowFn = options.now ?? Date.now;
	const setIntervalFn = options.setIntervalFn ?? setInterval;
	const clearIntervalFn = options.clearIntervalFn ?? clearInterval;
	let stopped = false;
	let stuckPhase: RunPhase | undefined;
	let stuckPhaseStartedAt: number | undefined;
	let stuckEmitted = false;

	const timer = setIntervalFn(() => {
		try {
			if (stopped) return;
			const currentNow = nowFn();
			const phaseState = options.getPhaseState();
			if (phaseState.phase === "idle" || phaseState.phase === "paused") {
				stuckPhase = undefined;
				stuckPhaseStartedAt = undefined;
				stuckEmitted = false;
			} else {
				if (stuckPhase !== phaseState.phase || stuckPhaseStartedAt !== phaseState.phaseStartedAt) {
					stuckPhase = phaseState.phase;
					stuckPhaseStartedAt = phaseState.phaseStartedAt;
					stuckEmitted = false;
				}
				const sinceMs = currentNow - phaseState.phaseStartedAt;
				if (!stuckEmitted && sinceMs >= stuckThresholdMs) {
					stuckEmitted = true;
					try {
						options.onStuck?.({
							runId: options.runId,
							stepIndex: options.stepIndex,
							phase: phaseState.phase,
							sinceMs,
							...(phaseState.toolName !== undefined ? { toolName: phaseState.toolName } : {}),
						});
					} catch (error) {
						logger.debug("Phase ticker stuck event failed", {
							runId: options.runId,
							stepIndex: options.stepIndex,
							phase: phaseState.phase,
							error: formatError(error),
						});
					}
				}
			}

			options.onStatusUpdate({
				runId: options.runId,
				stepIndex: options.stepIndex,
				runnerHeartbeatAt: currentNow,
			});

			if (currentNow - options.getLastEventAt() <= quietMs) return;

			options.onStatusUpdate({
				runId: options.runId,
				stepIndex: options.stepIndex,
				phase: phaseState.phase,
				phaseStartedAt: phaseState.phaseStartedAt,
				runnerHeartbeatAt: currentNow,
				...(phaseState.toolName !== undefined ? { toolName: phaseState.toolName } : {}),
			});
		} catch (error) {
			logger.debug("Phase ticker heartbeat failed", {
				runId: options.runId,
				stepIndex: options.stepIndex,
				error: formatError(error),
			});
		}
	}, intervalMs);
	const unref = (timer as { unref?: () => void }).unref;
	if (typeof unref === "function") unref.call(timer);

	return {
		stop(): void {
			if (stopped) return;
			stopped = true;
			clearIntervalFn(timer);
		},
	};
}

interface ExecutorRuntimeDeps {
	createAgentSession: typeof createAgentSession;
	DefaultResourceLoader: typeof DefaultResourceLoader;
	getAgentDir: typeof getAgentDir;
	SessionManager: Pick<typeof SessionManager, "open">;
}

let runtimeDeps: ExecutorRuntimeDeps = {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
};

export function __setChildAgentExecutorDepsForTest(deps: Partial<ExecutorRuntimeDeps>): () => void {
	const previous = runtimeDeps;
	runtimeDeps = { ...runtimeDeps, ...deps };
	return () => {
		runtimeDeps = previous;
	};
}

export function runChildAgent(step: ChildAgentStep, ctx: ChildAgentContext): Promise<ChildAgentResult> {
	return startChildAgent(step, ctx).completed;
}

export function dispatchAsyncChild(step: ChildAgentStep, ctx: ChildAgentContext): ChildAgentHandle {
	return startChildAgent(step, ctx);
}

function startChildAgent(step: ChildAgentStep, ctx: ChildAgentContext): ChildAgentHandle {
	let session: AgentSession | undefined;
	const localAbort = new AbortController();
	const combinedAbort = combineAbortSignals([
		ctx.abortSignal,
		ctx.registry.signalForRun(step.runId),
		localAbort.signal,
	]);
	const combinedSignal = combinedAbort.signal;

	// Seed the registry's in-memory RunView mirror from dispatch metadata. Only
	// the async paths thread runViewSeed, so this naturally gates to async (sync
	// foreground stays disk-only this VAL). seedRunView is idempotent.
	if (ctx.runViewSeed) ctx.registry.seedRunView(step.runId, ctx.runViewSeed);

	// TEE the patch stream at this single chokepoint: every patch that reaches the
	// status.json writer (ctx.onStatusUpdate) ALSO updates the registry mirror,
	// with no duplicate and no missed patch. Covers sync + all async paths since
	// they all funnel through startChildAgent.
	const teedCtx: ChildAgentContext = {
		...ctx,
		onStatusUpdate: (patch: StatusPatch) => {
			ctx.registry.applyStatusPatch(patch);
			ctx.onStatusUpdate?.(patch);
		},
	};

	// Gate leaf execution on the one per-process concurrency pool. Acquire is the
	// first await INSIDE the completed-promise chain so the handle below is still
	// constructed and returned synchronously (the async contract hands back all N
	// handles before any child runs). The permit is released when the leaf settles.
	const completed = (async () => {
		const releasePermit = await acquireLeafPermit(step.runId, combinedSignal);
		try {
			const result = await executeChildAgent(step, teedCtx, combinedSignal, (createdSession) => {
				session = createdSession;
			});
			// Final usage is NOT carried in the patch stream; land it in memory here.
			ctx.registry.finalizeView(step.runId, result);
			return result;
		} finally {
			releasePermit?.();
			// Drop this child's listeners from the long-lived source signals so
			// completed children do not accumulate on the parent tool signal.
			combinedAbort.dispose();
			ctx.registry.delete(step.runId, step.stepIndex);
		}
	})();

	const handle: ChildAgentHandle = {
		runId: step.runId,
		stepIndex: step.stepIndex,
		get session() {
			if (!session) throw new Error(`Child agent session for ${step.runId} is not ready yet`);
			return session;
		},
		completed,
		async abort(reason: string): Promise<void> {
			if (!localAbort.signal.aborted) localAbort.abort(reason);
			await session?.abort();
		},
	};

	ctx.registry.register(handle);
	return handle;
}

async function executeChildAgent(
	step: ChildAgentStep,
	ctx: ChildAgentContext,
	signal: AbortSignal,
	onSession: (session: AgentSession) => void,
): Promise<ChildAgentResult> {
	const startedAt = Date.now();
	let endedAt = startedAt;
	let outputText = "";
	let toolCallCount = 0;
	let toolResultCount = 0;
	let toolErrorCount = 0;
	let unsubscribe: (() => void) | undefined;
	let session: AgentSession | undefined;
	let structuredResult: SubmitResultEnvelope | undefined;
	let ticker: PhaseTickerHandle | undefined;
	const usage: ChildUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
	const phaseEvents = createPhaseEventHandler({
		runId: step.runId,
		stepIndex: step.stepIndex,
		initialNow: startedAt,
		pi: ctx.pi,
	});

	const baseResult = (state: ChildAgentExitState, error?: { message: string; reason?: string }): ChildAgentResult => {
		endedAt = Date.now();
		return {
			runId: step.runId,
			stepIndex: step.stepIndex,
			state,
			exitCode: state === "complete" ? 0 : 1,
			outputText: outputText.trim(),
			toolCallCount,
			toolResultCount,
			toolErrorCount,
			durationMs: endedAt - startedAt,
			startedAt,
			endedAt,
			sessionFile: step.sessionFile,
			usage: { ...usage },
			...(structuredResult ? { structuredResult } : {}),
			...(error ? { error } : {}),
		};
	};

	try {
		if (signal.aborted) {
			const result = baseResult("interrupted", {
				message: `Child agent interrupted: ${abortReason(signal)}`,
				reason: abortReason(signal),
			});
			ctx.onStatusUpdate?.({
				runId: step.runId,
				stepIndex: step.stepIndex,
				state: result.state,
				endedAt: result.endedAt,
				outputText: result.outputText,
			});
			return result;
		}
		ctx.onStatusUpdate?.({
			runId: step.runId,
			stepIndex: step.stepIndex,
			state: "running",
			activity: { state: "running", updatedAt: startedAt },
		});

		mkdirSync(path.dirname(step.sessionFile), { recursive: true });
		if (step.forkReuse?.sessionFile) {
			seedForkSessionFile({
				sourcePath: step.forkReuse.sessionFile,
				targetPath: step.sessionFile,
				childCwd: step.cwd,
			});
		}
		session = await runInChildSessionContext(() => createSessionWithFallback(step, ctx));
		onSession(session);
		// Only narrow the active tool set when the agent declared an explicit list.
		// If activeToolNames is undefined, the session keeps the default (all tools).
		if (step.activeToolNames !== undefined) {
			session.setActiveToolsByName(step.activeToolNames);
		}
		unsubscribe = session.subscribe((event) => {
			const patch = handleSessionEvent(step, ctx, event, phaseEvents, {
				appendOutput: (delta) => {
					outputText += delta;
					return outputText;
				},
				incrementToolCall: () => ++toolCallCount,
				incrementToolResult: () => ++toolResultCount,
				incrementToolError: () => ++toolErrorCount,
				accumulateUsage: usage,
			});
			if (patch) ctx.onStatusUpdate?.(patch);
		});
		ticker = createPhaseTicker({
			runId: step.runId,
			stepIndex: step.stepIndex,
			getPhaseState: () => phaseEvents.getState(),
			getLastEventAt: () => phaseEvents.getState().lastPhaseTickAt,
			onStatusUpdate: (patch) => ctx.onStatusUpdate?.(patch),
			onStuck: (payload) => {
				try {
					ctx.pi?.events?.emit(SUBAGENT_STUCK_EVENT, payload);
				} catch (error) {
					logger.debug("Failed to emit stuck event on parent pi.events", {
						runId: payload.runId,
						stepIndex: payload.stepIndex,
						phase: payload.phase,
						error: formatError(error),
					});
				}
			},
		});

		const promptPromise = session.prompt(step.task, { expandPromptTemplates: false, source: "extension" });
		const aborted = await promptOrAbort(promptPromise, signal);
		if (aborted) {
			await session.abort();
			const result = baseResult("interrupted", {
				message: `Child agent interrupted: ${abortReason(signal)}`,
				reason: abortReason(signal),
			});
			ctx.onStatusUpdate?.({
				runId: step.runId,
				stepIndex: step.stepIndex,
				state: result.state,
				endedAt: result.endedAt,
				outputText: result.outputText,
			});
			return result;
		}
		await promptPromise;

		if (!outputText.trim()) {
			outputText = session.getLastAssistantText?.() ?? "";
		}

		// The output contract is unconditional for every child: the final assistant
		// message must end with a trailing <output>...</output> block carrying the
		// result. The former submit_result tool is gone, so the source is the final
		// assistant TEXT (getLastAssistantText), not a toolResult. The accumulated
		// outputText is the streamed-delta fallback when no last-assistant text exists.
		const activeSession = session;
		const finalAssistantText = (): string => activeSession.getLastAssistantText?.() || outputText;
		for (
			let reprompt = 0;
			reprompt < 2 && !parseOutputEnvelope(finalAssistantText(), step.resultSchema).ok;
			reprompt++
		) {
			const text = finalAssistantText();
			const repromptMessage =
				step.resultSchema && hasOutputBlock(text) ? schemaReprompt(step.resultSchema) : OUTPUT_REPROMPT;
			const repromptPromise = session.prompt(repromptMessage, {
				expandPromptTemplates: false,
				source: "extension",
			});
			const repromptAborted = await promptOrAbort(repromptPromise, signal);
			if (repromptAborted) {
				await session.abort();
				const result = baseResult("interrupted", {
					message: `Child agent interrupted: ${abortReason(signal)}`,
					reason: abortReason(signal),
				});
				ctx.onStatusUpdate?.({
					runId: step.runId,
					stepIndex: step.stepIndex,
					state: result.state,
					endedAt: result.endedAt,
					outputText: result.outputText,
				});
				return result;
			}
			await repromptPromise;
		}
		{
			// Codec at the finish boundary: extract the LAST <output> block and resolve it.
			// Three outcomes: (1) valid -> structured result (a typed object is
			// JSON-stringified for the text surface while workflow scripts read the object
			// off structuredResult.result); (2) a schema was required but the block is
			// missing/invalid after reprompts -> FAIL CLOSED (exit 1, reason
			// "schema_validation") so the workflow throws rather than receive unvalidated
			// text; (3) no schema (default string contract) -> text fallback.
			const text = finalAssistantText();
			const parsed = parseOutputEnvelope(text, step.resultSchema);
			if (parsed.ok) {
				structuredResult = parsed.envelope;
				outputText =
					typeof structuredResult.result === "string"
						? structuredResult.result
						: JSON.stringify(structuredResult.result);
			} else if (step.resultSchema) {
				outputText = text;
				const result = baseResult("failed", {
					message: "Child agent output did not match the required schema.",
					reason: "schema_validation",
				});
				ctx.onStatusUpdate?.({
					runId: step.runId,
					stepIndex: step.stepIndex,
					state: result.state,
					endedAt: result.endedAt,
					outputText: result.outputText,
				});
				return result;
			} else {
				structuredResult = fallbackSubmitResultEnvelope(text);
				outputText = text;
			}
		}

		// Detect provider-level failures that the SDK swallows.
		//
		// When the upstream provider returns an error response (e.g. cursor proxy
		// replying "500 Not logged in" during a token-bootstrap race), the SDK
		// records an assistant message with `stopReason: "error"` and an empty
		// content array, retries internally, and ultimately resolves
		// `session.prompt()` without throwing. The naive read of that is "success":
		// no exception, no aborted signal. The honest read is "the model produced
		// nothing usable." We downgrade those runs to `failed` with the actual
		// provider errorMessage so the parent agent sees a real exit code instead
		// of a misleading 5/5-succeeded summary.
		const providerFailure = detectProviderFailure(session, outputText, toolCallCount);
		if (providerFailure) {
			const result = baseResult("failed", {
				message: providerFailure,
				reason: "provider_error",
			});
			ctx.onStatusUpdate?.({
				runId: step.runId,
				stepIndex: step.stepIndex,
				state: result.state,
				endedAt: result.endedAt,
				outputText: result.outputText,
			});
			return result;
		}

		let shareUrl: string | undefined;
		let shareError: { message: string } | undefined;
		if (step.shareEnabled) {
			try {
				shareUrl = await session.exportToHtml();
			} catch (error) {
				shareError = { message: formatError(error) };
			}
		}

		// An interrupt acknowledged after the prompt settled (e.g. mid-export) must
		// win over a success report: promptOrAbort only races prompts, so recheck
		// the signal here before committing to "complete". A child that genuinely
		// finished before the abort was signaled has already passed this point.
		if (signal.aborted) {
			await session.abort();
			const result = baseResult("interrupted", {
				message: `Child agent interrupted: ${abortReason(signal)}`,
				reason: abortReason(signal),
			});
			ctx.onStatusUpdate?.({
				runId: step.runId,
				stepIndex: step.stepIndex,
				state: result.state,
				endedAt: result.endedAt,
				outputText: result.outputText,
			});
			return result;
		}

		const result = baseResult("complete");
		if (shareUrl !== undefined) result.shareUrl = shareUrl;
		if (shareError) result.error = shareError;
		ctx.onStatusUpdate?.({
			runId: step.runId,
			stepIndex: step.stepIndex,
			state: result.state,
			endedAt: result.endedAt,
			outputText: result.outputText,
		});
		return result;
	} catch (error) {
		const reason = formatError(error);
		const state: ChildAgentExitState = signal.aborted ? "interrupted" : "failed";
		const result = baseResult(state, {
			message: reason,
			reason: state === "interrupted" ? abortReason(signal) : undefined,
		});
		ctx.onStatusUpdate?.({
			runId: step.runId,
			stepIndex: step.stepIndex,
			state: result.state,
			endedAt: result.endedAt,
			outputText: result.outputText,
		});
		return result;
	} finally {
		ticker?.stop();
		unsubscribe?.();
		session?.dispose();
	}
}

/**
 * Seed a fork child's session.jsonl from the parent's session file.
 *
 * Uses APFS/btrfs/xfs reflink (copy-on-write) via fs.constants.COPYFILE_FICLONE
 * so the clone is O(1) and shares blocks with the parent until either file is
 * modified. The fork's session.jsonl appears as a full standalone file but
 * consumes disk only for divergent blocks (i.e. the fork's new appends).
 *
 * On filesystems without reflink support (ext4, NTFS, etc.), Node falls back
 * to a regular copy. Sessions in the multi-MB range pay a real disk cost there;
 * APFS (default macOS) and btrfs/xfs make this free.
 *
 * The source branch was already created by SessionManager.createBranchedSession,
 * so its header has a fresh sessionId distinct from the parent plus a
 * parentSession link. The clone preserves that already-branched identity in the
 * child's canonical run file.
 *
 * Idempotent: if the target already exists (e.g. a retry after a transient
 * failure), the existing file is preserved.
 */

/**
 * Inspect a session's recorded messages after `prompt()` resolves and return a
 * provider-error description when the SDK swallowed an upstream failure.
 *
 * Triggers when EVERY assistant message in the session has `stopReason === "error"`
 * AND the agent produced no usable output (no text, no tool calls). That pattern
 * indicates the SDK exhausted its internal retries on a provider error and
 * resolved the prompt with empty content rather than throwing — e.g. the cursor
 * proxy returning "500 Not logged in" during a token-bootstrap race.
 *
 * Returns the first non-empty `errorMessage` from the session's assistant
 * messages, or a generic fallback. Returns undefined when the run looks healthy
 * (at least one assistant message succeeded, or the agent did real work).
 */
function detectProviderFailure(session: AgentSession, outputText: string, toolCallCount: number): string | undefined {
	if (outputText.trim().length > 0) return undefined;
	if (toolCallCount > 0) return undefined;
	const messages = session.messages;
	if (!messages || messages.length === 0) return undefined;
	let sawAssistant = false;
	let firstErrorMessage: string | undefined;
	for (const msg of messages) {
		if (msg.role !== "assistant") continue;
		sawAssistant = true;
		const stopReason = (msg as { stopReason?: string }).stopReason;
		if (stopReason !== "error") return undefined;
		if (!firstErrorMessage) {
			const em = (msg as { errorMessage?: string }).errorMessage;
			if (typeof em === "string" && em.trim()) firstErrorMessage = em.trim();
		}
	}
	if (!sawAssistant) return undefined;
	return firstErrorMessage ?? "Provider returned no usable response (all assistant messages errored)";
}

function seedForkSessionFile(input: { sourcePath: string; targetPath: string; childCwd: string }): void {
	if (existsSync(input.targetPath)) return;
	void input.childCwd;
	mkdirSync(path.dirname(input.targetPath), { recursive: true });
	try {
		copyFileSync(input.sourcePath, input.targetPath, fsConstants.COPYFILE_FICLONE);
	} catch (error) {
		throw new Error(
			`Fork-reuse: failed to clone session from '${input.sourcePath}' to '${input.targetPath}': ${(error as Error).message}`,
		);
	}
}

async function createSessionWithFallback(step: ChildAgentStep, ctx: ChildAgentContext): Promise<AgentSession> {
	const parentLineage = step.parentSessionId ? getLineageForSession(step.parentSessionId) : null;
	const depth = parentLineage
		? parentLineage.depth + 1
		: (() => {
				const envParentDepth = Number(process.env.PI_SUBAGENT_DEPTH ?? "0");
				return Number.isFinite(envParentDepth) ? envParentDepth + 1 : 1;
			})();
	const canDelegate = step.agentConfig.canDelegate === true;
	const allowedDelegateAgents = step.agentConfig.allowedDelegateAgents
		? [
				...new Set(
					step.agentConfig.allowedDelegateAgents
						.map((agent) => normalizeAgentIdentity(agent))
						.filter((agent): agent is string => Boolean(agent)),
				),
			]
		: undefined;
	// Queue this child's lineage so its activate can claim it once it knows its
	// own session id.
	const lineage: SubagentLineage = {
		role: "child",
		currentAgent: step.agentName,
		parentAgent:
			normalizeAgentIdentity(parentLineage?.currentAgent) ?? normalizeAgentIdentity(step.parentAgentName) ?? null,
		parentSessionId: step.parentSessionId ?? null,
		rootSessionId: parentLineage?.rootSessionId ?? step.rootSessionId ?? step.parentSessionId ?? null,
		depth,
		runId: step.runId,
		rootRunId: step.rootRunId ?? step.runId,
		canDelegate,
		...(allowedDelegateAgents ? { allowedDelegateAgents } : {}),
		maxSubagentDepth: step.maxSubagentDepth,
	};
	pushPendingChildLineage(lineage, step.sessionFile);
	try {
		const loader = new runtimeDeps.DefaultResourceLoader({
			cwd: step.cwd,
			agentDir: runtimeDeps.getAgentDir(),
			systemPrompt: step.systemPrompt,
			systemPromptOverride: () => step.systemPrompt,
			appendSystemPromptOverride: (base: string[]) =>
				step.systemPromptAppend ? [...base, step.systemPromptAppend] : base,
		});
		await loader.reload();

		const models = uniqueModels([step.model, ...step.modelCandidates]);
		let lastError: unknown;
		for (let index = 0; index < models.length; index++) {
			const model = models[index]!;
			try {
				// Open the session manager up front so we can resolve the child's
				// session id and register lineage by sid synchronously, before any
				// activate inside the child can run. This bypasses the activate-time
				// race where the SDK's session_start may already have fired by the
				// time the extension attaches its listener.
				const sessionManager = runtimeDeps.SessionManager.open(step.sessionFile);
				let childSid: string | undefined;
				try {
					const resolvedSessionId = sessionManager.getSessionId();
					if (typeof resolvedSessionId === "string" && resolvedSessionId.length > 0) {
						childSid = resolvedSessionId;
					}
				} catch {
					// fall back to the pending-queue + activate-claim path
				}
				if (childSid) {
					setChildLineage(childSid, lineage, step.sessionFile);
					removePendingChildLineage(lineage);
				}

				const created = await runtimeDeps.createAgentSession({
					cwd: step.cwd,
					agentDir: runtimeDeps.getAgentDir(),
					modelRegistry: ctx.extensionCtx.modelRegistry,
					model,
					thinkingLevel: step.thinkingLevel,
					scopedModels: models.map((candidate) => ({ model: candidate, thinkingLevel: step.thinkingLevel })),
					// Pass undefined to leave _allowedToolNames unset (= all tools).
					// Pass a list to restrict to exactly those names.
					tools: step.activeToolNames,
					resourceLoader: loader,
					sessionManager,
				});
				return created.session;
			} catch (error) {
				lastError = error;
				if (!isAuthFailure(error) || index === models.length - 1) throw error;
				removeChildLineageBindings(lineage);
				pushPendingChildLineage(lineage, step.sessionFile);
			}
		}
		throw lastError ?? new Error("No model candidates available for child agent");
	} catch (error) {
		removePendingChildLineage(lineage);
		removeChildLineageBindings(lineage);
		throw error;
	}
}

function handleSessionEvent(
	step: ChildAgentStep,
	ctx: ChildAgentContext,
	event: AgentSessionEvent,
	phaseEvents: PhaseEventHandler,
	counters: {
		appendOutput(delta: string): string;
		incrementToolCall(): number;
		incrementToolResult(): number;
		incrementToolError(): number;
		accumulateUsage?: ChildUsage;
	},
): StatusPatch | undefined {
	ctx.onEvent?.(step.stepIndex, event);
	const record = event as Record<string, unknown>;
	const type = typeof record.type === "string" ? record.type : undefined;
	const now = Date.now();
	let patchBody: StatusPatchBody | undefined;

	// Token + cost accumulation. Equivalent to subagent-executor's sync path:
	// add per-assistant-message usage, then add any nested subagent usage so
	// the descendant tree bubbles up.
	if (counters.accumulateUsage) {
		if (type === "message_end" && record.message && typeof record.message === "object") {
			const msg = record.message as {
				role?: string;
				usage?: {
					input?: number;
					output?: number;
					cacheRead?: number;
					cacheWrite?: number;
					cost?: { total?: number };
				};
			};
			if (msg.role === "assistant" && msg.usage) {
				const u = msg.usage;
				counters.accumulateUsage.input += u.input || 0;
				counters.accumulateUsage.output += u.output || 0;
				counters.accumulateUsage.cacheRead += u.cacheRead || 0;
				counters.accumulateUsage.cacheWrite += u.cacheWrite || 0;
				counters.accumulateUsage.cost += u.cost?.total || 0;
				counters.accumulateUsage.turns += 1;
			}
		} else if (type === "tool_execution_end") {
			const nested = nestedSubagentUsageFromToolEvent(record);
			if (nested) {
				addUsageInto(counters.accumulateUsage, nested);
			}
		}
	}

	if (type === "text_delta" && typeof record.delta === "string") {
		patchBody = {
			liveText: counters.appendOutput(record.delta),
			activity: { state: "running", updatedAt: now },
		};
	} else if (type === "text_end" && typeof record.content === "string") {
		patchBody = {
			liveText: record.content,
			activity: { state: "running", updatedAt: now },
		};
	} else if (type === "tool_execution_start") {
		const toolName = typeof record.toolName === "string" ? record.toolName : undefined;
		counters.incrementToolCall();
		patchBody = {
			toolCallDelta: 1,
			activity: { state: "tool_running", toolName, updatedAt: now },
		};
	} else if (type === "tool_execution_end") {
		const toolName = typeof record.toolName === "string" ? record.toolName : undefined;
		counters.incrementToolResult();
		const isError = record.isError === true;
		if (isError) counters.incrementToolError();
		patchBody = {
			toolResultDelta: 1,
			...(isError ? { toolErrorDelta: 1 } : {}),
			activity: { state: "running", toolName, updatedAt: now },
		};
	}

	return phaseEvents.handle(event, now, patchBody);
}

function combineAbortSignals(signals: AbortSignal[]): { signal: AbortSignal; dispose: () => void } {
	const controller = new AbortController();
	const listeners = new Map<AbortSignal, () => void>();
	const dispose = () => {
		for (const [signal, listener] of listeners) signal.removeEventListener("abort", listener);
		listeners.clear();
	};
	const abort = (signal: AbortSignal) => {
		if (!controller.signal.aborted) {
			controller.abort(signal.reason);
			dispose();
		}
	};
	for (const signal of signals) {
		if (listeners.has(signal)) continue;
		if (signal.aborted) {
			abort(signal);
			break;
		}
		const listener = () => abort(signal);
		listeners.set(signal, listener);
		signal.addEventListener("abort", listener, { once: true });
	}
	return { signal: controller.signal, dispose };
}

async function promptOrAbort(promptPromise: Promise<void>, signal: AbortSignal): Promise<boolean> {
	return await new Promise<boolean>((resolve) => {
		if (signal.aborted) return resolve(true);
		const onAbort = () => resolve(true);
		signal.addEventListener("abort", onAbort, { once: true });
		promptPromise.then(
			() => {
				signal.removeEventListener("abort", onAbort);
				resolve(false);
			},
			() => {
				signal.removeEventListener("abort", onAbort);
				resolve(false);
			},
		);
	});
}

function uniqueModels(models: Model<any>[]): Model<any>[] {
	const seen = new Set<string>();
	const unique: Model<any>[] = [];
	for (const model of models) {
		const key = `${model.provider}/${model.id}`;
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push(model);
	}
	return unique;
}

function isAuthFailure(error: unknown): boolean {
	const message = formatError(error);
	return /auth(?:entication)?|unauthori[sz]ed|forbidden|api key|token expired|invalid key|no api key/i.test(message);
}

function abortReason(signal: AbortSignal): string {
	const reason = signal.reason;
	if (reason instanceof Error) return reason.message;
	if (typeof reason === "string") return reason;
	return "aborted";
}

function formatError(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}
