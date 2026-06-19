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

// 0.75 SDK: tools are referenced by string name; the session resolves builtins and
// extension-registered tools against its _toolRegistry. The `tools` option at
// createAgentSession is the allowlist that gates _both_ builtins AND extension tools
// (via _refreshToolRegistry's isAllowedTool check). So we pass the full requested name
// list unfiltered; extension tools like ast_grep/fetch/mcp/scan_files register during
// session_start and only pass the gate if their name is in this list.
import { logger } from "../shared/logger.ts";
import { pushPendingChildLineage, setChildLineage } from "../state/lineage.ts";
import { advanceRunPhase, initialRunPhaseState, type RunPhaseState } from "../state/run-phase.ts";
import {
	SUBAGENT_PHASE_CHANGE_EVENT,
	SUBAGENT_STUCK_EVENT,
	type ControlConfig,
	type SubagentLineage,
	type SubagentPhaseChangePayload,
	type SubagentStuckPayload,
} from "../protocol/types.ts";
import type {
	ChildAgentExitState,
	ChildAgentResult,
	ChildUsage,
	RunPhase,
	StatusPatch,
} from "../protocol/status-types.ts";
export type {
	ChildAgentExitState,
	ChildAgentResult,
	ChildUsage,
	RunPhase,
	StatusPatch,
} from "../protocol/status-types.ts";
import {
	extractSubmitResultEnvelope,
	fallbackSubmitResultEnvelope,
	hasSubmitResultToolResult,
	SUBMIT_RESULT_REPROMPT,
	SUBMIT_RESULT_TOOL_NAME,
	type SubmitResultEnvelope,
} from "../protocol/submit-result.ts";
import { ChildAgentRegistry } from "./child-agent-registry.ts";
import type { ChildAgentContext, ChildAgentHandle } from "./child-agent-registry.ts";
import { acquireLeafPermit } from "./leaf-concurrency.ts";
export { ChildAgentRegistry } from "./child-agent-registry.ts";
export type { ChildAgentContext, ChildAgentHandle, RunViewSeed } from "./child-agent-registry.ts";
import type { ChildAgentStep, ResolvedAgentConfig } from "./executor-types.ts";
export type { ChildAgentStep, ResolvedAgentConfig } from "./executor-types.ts";

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

export function emitPhaseChange(
	pi: PhaseEventHandlerOptions["pi"] | undefined,
	payload: SubagentPhaseChangePayload,
): void {
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

interface LegacyPhaseTickerOptions {
	runId: string;
	stepIndex: number;
	onStatusUpdate: (patch: StatusPatch) => void;
	intervalMs?: number;
	quietThresholdMs?: number;
	now?: () => number;
	setIntervalFn?: typeof setInterval;
	clearIntervalFn?: typeof clearInterval;
	stuckThresholdMs?: number;
	onStuck?: (payload: SubagentStuckPayload) => void;
}

type LegacyPhaseTickerHandle = PhaseTickerHandle & { notifyEvent(now: number): void };

export function createPhaseTicker(options: PhaseTickerOptions): PhaseTickerHandle;
export function createPhaseTicker(
	getPhaseState: () => RunPhaseState,
	options: LegacyPhaseTickerOptions,
	initialNow?: number,
): LegacyPhaseTickerHandle;
export function createPhaseTicker(
	optionsOrGetPhaseState: PhaseTickerOptions | (() => RunPhaseState),
	legacyOptions?: LegacyPhaseTickerOptions,
	initialNow?: number,
): PhaseTickerHandle | LegacyPhaseTickerHandle {
	const now =
		legacyOptions?.now ??
		(typeof optionsOrGetPhaseState === "function" ? undefined : optionsOrGetPhaseState.now) ??
		Date.now;
	let legacyLastEventAt = initialNow ?? now();
	const options: PhaseTickerOptions =
		typeof optionsOrGetPhaseState === "function"
			? {
					intervalMs: legacyOptions?.intervalMs,
					quietMs: legacyOptions?.quietThresholdMs,
					stuckThresholdMs: legacyOptions?.stuckThresholdMs,
					getPhaseState: optionsOrGetPhaseState,
					getLastEventAt: () => legacyLastEventAt,
					onStatusUpdate: legacyOptions!.onStatusUpdate,
					onStuck: legacyOptions?.onStuck,
					now,
					setIntervalFn: legacyOptions?.setIntervalFn,
					clearIntervalFn: legacyOptions?.clearIntervalFn,
					runId: legacyOptions!.runId,
					stepIndex: legacyOptions!.stepIndex,
				}
			: optionsOrGetPhaseState;
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
		notifyEvent(now: number): void {
			legacyLastEventAt = now;
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
	const combinedSignal = combineAbortSignals([
		ctx.abortSignal,
		ctx.registry.signalForRun(step.runId),
		localAbort.signal,
	]);

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
		const releasePermit = await acquireLeafPermit(step.runId);
		try {
			const result = await executeChildAgent(step, teedCtx, combinedSignal, (createdSession) => {
				session = createdSession;
			});
			// Final usage is NOT carried in the patch stream; land it in memory here.
			ctx.registry.finalizeView(step.runId, result);
			return result;
		} finally {
			releasePermit();
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
		session = await createSessionWithFallback(step, ctx);
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

		const shouldRequireSubmitResult =
			step.activeToolNames?.includes("submit_result") === true ||
			step.customTools.some((tool) => tool.name === "submit_result");
		for (
			let reprompt = 0;
			shouldRequireSubmitResult && reprompt < 2 && !hasSubmitResultToolResult(getSessionMessages(session));
			reprompt++
		) {
			const repromptPromise = session.prompt(SUBMIT_RESULT_REPROMPT, {
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
			if (!outputText.trim()) {
				outputText = session.getLastAssistantText?.() ?? "";
			}
		}
		if (shouldRequireSubmitResult) {
			structuredResult = extractSubmitResultEnvelope(getSessionMessages(session));
			if (structuredResult) {
				// result is the parent-visible output. A string passes through; a typed
				// object (workflow-schema'd) is JSON-stringified so the text surface stays
				// a string while workflow scripts read the object off structuredResult.result.
				outputText =
					typeof structuredResult.result === "string"
						? structuredResult.result
						: JSON.stringify(structuredResult.result);
			} else {
				const fallbackText = session.getLastAssistantText?.() || outputText;
				structuredResult = fallbackSubmitResultEnvelope(fallbackText);
				outputText = fallbackText;
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

		const result = baseResult("complete");
		if (step.shareEnabled) {
			try {
				result.shareUrl = await session.exportToHtml();
			} catch (error) {
				result.error = { message: formatError(error) };
			}
		}
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
 * The clone preserves the parent's session header (and therefore sessionId).
 * That's acceptable: fork children are short-lived and not resumed independently;
 * the runRecordDir layout + runs-index.jsonl identify the fork uniquely.
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

/**
 * Marker on globalThis set while we're constructing a child AgentSession.
 * The pi-subagents extension factory checks this to know it's being invoked
 * inside a child session (versus the host) and bail out of host-only wiring
 * (currentPi pin, pi.events listeners, widget state, etc.).
 */
const CHILD_SESSION_FLAG_KEY = "__piSubagentInsideChildSession";
function setChildSessionFlag(value: boolean): void {
	(globalThis as Record<string, unknown>)[CHILD_SESSION_FLAG_KEY] = value;
}

async function createSessionWithFallback(step: ChildAgentStep, ctx: ChildAgentContext): Promise<AgentSession> {
	// Set the child-session flag BEFORE any loader/session work runs. Both
	// `loader.reload()` and `createAgentSession()` invoke every registered
	// extension factory (including this package's), and the factory must see
	// the flag synchronously to skip host wiring.
	setChildSessionFlag(true);

	// Queue this child's lineage so its activate can claim it once it knows its
	// own session id. Depth = parent's depth + 1; we don't have the parent's
	// depth here, but rootSessionId tells charters/consumers how to reconstruct
	// the tree if needed. depth 0 = host, 1 = first-level child, etc.
	const lineage: SubagentLineage = {
		role: "child",
		currentAgent: step.agentName,
		parentAgent: step.parentAgentName ?? null,
		parentSessionId: step.parentSessionId ?? null,
		rootSessionId: step.rootSessionId ?? step.parentSessionId ?? null,
		depth: 1, // minimum; refined by child activate using rootSessionId vs parentSessionId
		runId: step.runId,
		rootRunId: step.rootRunId ?? step.runId,
	};
	pushPendingChildLineage(lineage);
	try {
		const loader = new runtimeDeps.DefaultResourceLoader({
			cwd: step.cwd,
			agentDir: runtimeDeps.getAgentDir(),
			systemPrompt: step.systemPrompt,
			systemPromptOverride: () => step.systemPrompt,
			appendSystemPromptOverride: () => [],
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
				try {
					const childSid = sessionManager.getSessionId();
					if (typeof childSid === "string" && childSid.length > 0) {
						setChildLineage(childSid, lineage);
					}
				} catch {
					// fall back to the pending-queue + activate-claim path
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
					customTools: step.customTools,
					resourceLoader: loader,
					sessionManager,
				});
				return created.session;
			} catch (error) {
				lastError = error;
				if (!isAuthFailure(error) || index === models.length - 1) throw error;
			}
		}
		throw lastError ?? new Error("No model candidates available for child agent");
	} finally {
		setChildSessionFlag(false);
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
	// add per-assistant-message usage, then add any nested subagent
	// tool_result's `details.totalUsage` so the descendant tree bubbles up.
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
		} else if (
			type === "tool_execution_end" &&
			record.toolName === "subagent" &&
			record.result &&
			typeof record.result === "object"
		) {
			const result = record.result as {
				details?: {
					totalUsage?: {
						input?: number;
						output?: number;
						cacheRead?: number;
						cacheWrite?: number;
						cost?: number;
						turns?: number;
					};
				};
			};
			const nested = result.details?.totalUsage;
			if (nested) {
				counters.accumulateUsage.input += nested.input || 0;
				counters.accumulateUsage.output += nested.output || 0;
				counters.accumulateUsage.cacheRead += nested.cacheRead || 0;
				counters.accumulateUsage.cacheWrite += nested.cacheWrite || 0;
				counters.accumulateUsage.cost += nested.cost || 0;
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
		if (toolName !== SUBMIT_RESULT_TOOL_NAME) {
			counters.incrementToolCall();
			patchBody = {
				toolCallDelta: 1,
				activity: { state: "tool_running", toolName, updatedAt: now },
			};
		}
	} else if (type === "tool_execution_end") {
		const toolName = typeof record.toolName === "string" ? record.toolName : undefined;
		// submit_result is the structured-finish call, surfaced via the `finishing`
		// phase rather than a tool line. Skip its result-counting and activity patch
		// symmetrically with tool_execution_start so it never re-sets currentTool nor
		// inflates the tool-result count on the async surface.
		if (toolName !== SUBMIT_RESULT_TOOL_NAME) {
			counters.incrementToolResult();
			const isError = record.isError === true;
			if (isError) counters.incrementToolError();
			patchBody = {
				toolResultDelta: 1,
				...(isError ? { toolErrorDelta: 1 } : {}),
				activity: { state: "running", toolName, updatedAt: now },
			};
		}
	}

	return phaseEvents.handle(event, now, patchBody);
}

function combineAbortSignals(signals: AbortSignal[]): AbortSignal {
	const controller = new AbortController();
	const abort = (signal: AbortSignal) => {
		if (!controller.signal.aborted) controller.abort(signal.reason);
	};
	for (const signal of signals) {
		if (signal.aborted) {
			abort(signal);
			break;
		}
		signal.addEventListener("abort", () => abort(signal), { once: true });
	}
	return controller.signal;
}

function getSessionMessages(session: AgentSession): unknown[] {
	const direct = (session as unknown as { messages?: unknown[] }).messages;
	if (Array.isArray(direct)) return direct;
	const stateMessages = (session as unknown as { state?: { messages?: unknown[] } }).state?.messages;
	return Array.isArray(stateMessages) ? stateMessages : [];
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
