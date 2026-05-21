import { constants as fsConstants, copyFileSync, existsSync, mkdirSync } from "node:fs";
import * as path from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import {
	AgentSession,
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
import { logger } from "./logger.ts";
import { pushPendingChildLineage, setChildLineage } from "./lineage.ts";
import type { ControlConfig, SubagentLineage } from "./types.ts";

export interface ResolvedAgentConfig {
	name: string;
	description?: string;
	systemPrompt?: string;
	tools?: string[];
	mcpDirectTools?: string[];
	model?: string;
	fallbackModels?: string[];
	thinking?: string;
	skills?: string[];
	[key: string]: unknown;
}

export interface ChildAgentStep {
	runId: string;
	stepIndex: number;
	agentName: string;
	agentConfig: ResolvedAgentConfig;
	task: string;
	cwd: string;
	model: Model<any>;
	modelCandidates: Model<any>[];
	thinkingLevel?: ThinkingLevel;
	/**
	 * Tool allowlist for the child session.
	 * - undefined: no allowlist (child sees ALL tools registered by pi + extensions)
	 * - string[]: exact allowlist (use empty array for zero tools)
	 */
	activeToolNames: string[] | undefined;
	customTools: ToolDefinition[];
	systemPrompt: string;
	skillsResolved: string[];
	sessionFile: string;
	runRecordDir: string;
	forkReuse?: { sessionFile: string; agentName: string };
	intercom?: { selfTarget?: string; bridgeTarget?: string };
	artifactsDir?: string;
	label?: string;
	parentAgentName?: string;
	parentSessionId?: string;
	rootSessionId?: string;
	maxSubagentDepth: number;
	preset?: string;
	shareEnabled: boolean;
	controlConfig?: ControlConfig;
	outputPath?: string;
}

export interface ChildAgentContext {
	extensionCtx: ExtensionContext;
	abortSignal: AbortSignal;
	onEvent?: (stepIndex: number, e: AgentSessionEvent) => void;
	onStatusUpdate?: (patch: StatusPatch) => void;
	onCompleted?: (result: ChildAgentResult) => void;
	registry: ChildAgentRegistry;
	pi: ExtensionAPI;
}

export type ChildAgentExitState = "complete" | "failed" | "interrupted";

export interface ChildAgentResult {
	runId: string;
	stepIndex: number;
	state: ChildAgentExitState;
	exitCode: 0 | 1;
	outputText: string;
	toolCallCount: number;
	toolResultCount: number;
	toolErrorCount: number;
	durationMs: number;
	startedAt: number;
	endedAt: number;
	sessionFile: string;
	shareUrl?: string;
	error?: { message: string; reason?: string };
}

export interface ChildAgentHandle {
	readonly runId: string;
	readonly stepIndex: number;
	readonly session: AgentSession;
	readonly completed: Promise<ChildAgentResult>;
	abort(reason: string): Promise<void>;
}

export interface StatusPatch {
	runId: string;
	stepIndex: number;
	state?: ChildAgentExitState | "running" | "queued";
	activity?: { state: string; toolName?: string; updatedAt: number };
	liveText?: string;
	toolCallDelta?: number;
	toolResultDelta?: number;
	toolErrorDelta?: number;
	endedAt?: number;
	outputText?: string;
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

export class ChildAgentRegistry {
	private readonly handles = new Map<string, Map<number, ChildAgentHandle>>();
	private readonly controllers = new Map<string, AbortController>();

	signalForRun(runId: string): AbortSignal {
		return this.controllerForRun(runId).signal;
	}

	register(handle: ChildAgentHandle): void {
		this.controllerForRun(handle.runId);
		let byStep = this.handles.get(handle.runId);
		if (!byStep) {
			byStep = new Map();
			this.handles.set(handle.runId, byStep);
		}
		byStep.set(handle.stepIndex, handle);
	}

	get(runId: string): ChildAgentHandle | undefined {
		return this.handles.get(runId)?.values().next().value;
	}

	delete(runId: string, stepIndex?: number): void {
		if (stepIndex === undefined) {
			this.handles.delete(runId);
			this.controllers.delete(runId);
			return;
		}
		const byStep = this.handles.get(runId);
		byStep?.delete(stepIndex);
		if (!byStep || byStep.size === 0) {
			this.handles.delete(runId);
			this.controllers.delete(runId);
		}
	}

	list(): ChildAgentHandle[] {
		return [...this.handles.values()].flatMap((byStep) => [...byStep.values()]);
	}

	snapshot(): { runId: string; stepIndex: number }[] {
		return this.list().map((handle) => ({ runId: handle.runId, stepIndex: handle.stepIndex }));
	}

	async abortAll(reason: string): Promise<void> {
		await Promise.all(this.list().map((handle) => this.abortRun(handle.runId, reason)));
	}

	async abortRun(runId: string, reason: string): Promise<void> {
		const controller = this.controllerForRun(runId);
		if (!controller.signal.aborted) {
			controller.abort(reason);
		}
		await Promise.all([...this.handles.get(runId)?.values() ?? []].map((handle) => handle.abort(reason)));
	}

	private controllerForRun(runId: string): AbortController {
		let controller = this.controllers.get(runId);
		if (!controller) {
			controller = new AbortController();
			this.controllers.set(runId, controller);
		}
		return controller;
	}
}

export function runChildAgent(step: ChildAgentStep, ctx: ChildAgentContext): Promise<ChildAgentResult> {
	return startChildAgent(step, ctx, false).completed;
}

export function dispatchAsyncChild(step: ChildAgentStep, ctx: ChildAgentContext): ChildAgentHandle {
	return startChildAgent(step, ctx, true);
}

function startChildAgent(step: ChildAgentStep, ctx: ChildAgentContext, notifyCompleted: boolean): ChildAgentHandle {
	let session: AgentSession | undefined;
	const localAbort = new AbortController();
	const combinedSignal = combineAbortSignals([
		ctx.abortSignal,
		ctx.registry.signalForRun(step.runId),
		localAbort.signal,
	]);

	const completed = executeChildAgent(step, ctx, combinedSignal, (createdSession) => {
		session = createdSession;
	}).finally(() => {
		ctx.registry.delete(step.runId, step.stepIndex);
	});

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
	if (notifyCompleted) {
		void completed.then((result) => ctx.onCompleted?.(result));
	}
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
			const patch = handleSessionEvent(step, ctx, event, {
				appendOutput: (delta) => {
					outputText += delta;
					return outputText;
				},
				incrementToolCall: () => ++toolCallCount,
				incrementToolResult: () => ++toolResultCount,
				incrementToolError: () => ++toolErrorCount,
			});
			if (patch) ctx.onStatusUpdate?.(patch);
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
		const result = baseResult(state, { message: reason, reason: state === "interrupted" ? abortReason(signal) : undefined });
		ctx.onStatusUpdate?.({
			runId: step.runId,
			stepIndex: step.stepIndex,
			state: result.state,
			endedAt: result.endedAt,
			outputText: result.outputText,
		});
		return result;
	} finally {
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
function seedForkSessionFile(input: { sourcePath: string; targetPath: string; childCwd: string }): void {
	if (existsSync(input.targetPath)) return;
	void input.childCwd;
	mkdirSync(path.dirname(input.targetPath), { recursive: true });
	try {
		copyFileSync(input.sourcePath, input.targetPath, fsConstants.COPYFILE_FICLONE);
	} catch (error) {
		throw new Error(`Fork-reuse: failed to clone session from '${input.sourcePath}' to '${input.targetPath}': ${(error as Error).message}`);
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
	counters: {
		appendOutput(delta: string): string;
		incrementToolCall(): number;
		incrementToolResult(): number;
		incrementToolError(): number;
	},
): StatusPatch | undefined {
	ctx.onEvent?.(step.stepIndex, event);
	const record = event as Record<string, unknown>;
	const type = typeof record.type === "string" ? record.type : undefined;
	const now = Date.now();

	if (type === "text_delta" && typeof record.delta === "string") {
		return {
			runId: step.runId,
			stepIndex: step.stepIndex,
			liveText: counters.appendOutput(record.delta),
			activity: { state: "running", updatedAt: now },
		};
	}

	if (type === "text_end" && typeof record.content === "string") {
		return {
			runId: step.runId,
			stepIndex: step.stepIndex,
			liveText: record.content,
			activity: { state: "running", updatedAt: now },
		};
	}

	if (type === "tool_execution_start") {
		const toolName = typeof record.toolName === "string" ? record.toolName : undefined;
		counters.incrementToolCall();
		return {
			runId: step.runId,
			stepIndex: step.stepIndex,
			toolCallDelta: 1,
			activity: { state: "tool_running", toolName, updatedAt: now },
		};
	}

	if (type === "tool_execution_end") {
		const toolName = typeof record.toolName === "string" ? record.toolName : undefined;
		counters.incrementToolResult();
		const isError = record.isError === true;
		if (isError) counters.incrementToolError();
		return {
			runId: step.runId,
			stepIndex: step.stepIndex,
			toolResultDelta: 1,
			...(isError ? { toolErrorDelta: 1 } : {}),
			activity: { state: "running", toolName, updatedAt: now },
		};
	}

	return undefined;
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
