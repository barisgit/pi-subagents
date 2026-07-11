import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { readAllEntries, appendRunEntry } from "../state/runs-registry.ts";
import { readStatus } from "../shared/utils.ts";
import { resolveChildSessionFile } from "../state/session-paths.ts";
import { StatusWriter, type StatusMeta } from "../state/status-writer.ts";
import type { ChildAgentResult, PersistedRunStatus, PersistedRunStep } from "../protocol/status-types.ts";
import type { PipelineMetadata, TokenUsage, Usage } from "../protocol/types.ts";
import { computeGroupStatus, type Layer0ChildStatus, type Layer0GroupStatus } from "../state/group-status.ts";
import { processGlobal } from "../shared/process-global.ts";

export { computeGroupStatus, type Layer0ChildStatus, type Layer0GroupStatus } from "../state/group-status.ts";

export interface Layer0RunStep {
	agentName: string;
	task: string;
	cwd: string;
	label?: string;
}

export interface Layer0PreparedRunStep extends Layer0RunStep {
	runId: string;
	stepIndex: 0;
	runRecordDir: string;
	sessionFile: string;
}

export interface Layer0ExecutorContext {
	abortSignal: AbortSignal;
	statusWriter: StatusWriter;
}

export type Layer0RunAgent = (step: Layer0PreparedRunStep, ctx: Layer0ExecutorContext) => Promise<ChildAgentResult>;

export type NotifyPolicy = "rollup" | "each" | "silent";

export type RunLifecycleEvent =
	| { type: "run.started"; runId: string; runRecordDir: string; sessionFile: string; timestamp: number }
	| {
			type: "run.completed";
			runId: string;
			runRecordDir: string;
			sessionFile: string;
			timestamp: number;
			result?: ChildAgentResult;
			error?: unknown;
	  };

export type RunLifecycleSink = (event: RunLifecycleEvent) => void;

export interface SpawnRunOpts {
	parentRunId?: string;
	rootRunId: string;
	notifyPolicy: NotifyPolicy;
	runAgent: Layer0RunAgent;
	parentSessionFile?: string | null;
	sessionDir?: string;
	defaultSessionDir?: string;
	rootSessionId?: string;
	parentSessionId?: string;
	phaseIndex?: number;
	phaseTitle?: string;
	parallelGroupId?: string;
	pipeline?: PipelineMetadata;
	source?: "sync" | "async";
	onLifecycle?: RunLifecycleSink;
}

export interface Layer0RunHandle {
	runId: string;
	runRecordDir: string;
	sessionFile: string;
	completed: Promise<ChildAgentResult>;
	notifyPolicy: NotifyPolicy;
}

export interface OpenGroupOpts {
	cwd: string;
	parentRunId?: string;
	rootRunId?: string;
	notifyPolicy: NotifyPolicy;
	sessionDir?: string;
	defaultSessionDir?: string;
	parentSessionFile?: string | null;
	rootSessionId?: string;
	parentSessionId?: string;
	kind?: "workflow";
	source?: "sync" | "async";
	mode?: "single" | "parallel";
	label?: string;
}

export interface Layer0GroupHandle {
	runId: string;
	runRecordDir: string;
	notifyPolicy: NotifyPolicy;
}

export interface InterruptRunOpts {
	cascade: boolean;
}

export interface InterruptRunResult {
	interruptedRunIds: string[];
}

// Shared across module instances via processGlobal: interruptRun must find
// controllers registered by a PRE-RELOAD module instance, or a still-running
// async child spawned before the reload becomes uninterruptible.
const controllersByRunId = processGlobal("pi.subagents.runControllers", () => new Map<string, AbortController>());

// Narrow registration seam for dispatch paths that create their own detached
// controllers instead of going through spawnRun (the async dispatch paths).
// Every interruptible run's controller must land in this one shared map, or a
// reload orphans the run: the per-activation childRegistry does not survive a
// reload, so interruptRun's map lookup is the only post-reload abort path.
export function registerRunController(runId: string, controller: AbortController): void {
	controllersByRunId.set(runId, controller);
}

export function releaseRunController(runId: string): void {
	controllersByRunId.delete(runId);
}

export type RunRecordVariant = "group-child" | "sync-foreground" | "async-detached";
// maps: group-child->(eager,running,finalize(result)); sync-foreground->(terminal,running,finalizeTerminal); async-detached->(eager,queued,finalize(result,{totalUsage}))

export interface OpenRunRecordOpts {
	// present=use verbatim (singles); absent=randomUUID()+resolveChildSessionFile (spawnRun)
	runId?: string;
	runRecordDir?: string;
	sessionFile?: string;
	rootRunId?: string;
	parentRunId?: string;
	source?: "sync" | "async";
	parentSessionFile?: string | null;
	sessionDir?: string;
	defaultSessionDir?: string;
	rootSessionId?: string;
	parentSessionId?: string;
	phaseIndex?: number;
	phaseTitle?: string;
	parallelGroupId?: string;
	pipeline?: PipelineMetadata;
	variant: RunRecordVariant;
	// caller-built initialize meta MINUS state; funnel forces state per variant.
	initialize: Omit<StatusMeta, "state">;
}

export interface OpenRunHandle {
	runId: string;
	runRecordDir: string;
	sessionFile: string;
	startedAt: number;
	statusWriter: StatusWriter;
	variant: RunRecordVariant;
}

export function openRunRecord(step: Layer0RunStep, opts: OpenRunRecordOpts): OpenRunHandle {
	const runId = opts.runId ?? randomUUID();
	const paths =
		opts.runRecordDir && opts.sessionFile
			? { runRecordDir: opts.runRecordDir, sessionFile: opts.sessionFile, sessionRoot: opts.runRecordDir }
			: resolveChildSessionFile({
					parentCwd: step.cwd,
					parentSessionFile: opts.parentSessionFile ?? null,
					runId,
					stepIndex: 0,
					...(opts.sessionDir ? { sessionDirOverride: opts.sessionDir } : {}),
					...(opts.defaultSessionDir ? { defaultSessionDir: opts.defaultSessionDir } : {}),
				});
	const startedAt = opts.initialize.startedAt ?? Date.now();
	const flushPolicy: "terminal" | "eager" = opts.variant === "sync-foreground" ? "terminal" : "eager";
	// Every gated child opens "queued": it has a persisted run record before it
	// acquires a leaf permit, so it must NOT look active while blocked on the
	// concurrency pool (a frozen heartbeat on a "running" record drifts to "lost").
	// The instant the child holds a permit and begins its first step, a
	// state:"running" patch flips both the run and the step: group-child via
	// executeChildAgent's onStatusUpdate (in-process-executor), sync-foreground via
	// the foreground progress mirror (mirrorForegroundProgressToStatus).
	const state = "queued";
	// eager OMITS the flushPolicy field to byte-match today's spawnRun (no flushPolicy) + async (default).
	const statusWriter = new StatusWriter({
		runRecordDir: paths.runRecordDir,
		runId,
		...(flushPolicy === "terminal" ? { flushPolicy: "terminal" } : {}),
	});
	// group-child: if initialize.steps empty, synthesize spawnRun's single running step with resolved sessionFile.
	const initSteps =
		opts.variant === "group-child" && (!opts.initialize.steps || opts.initialize.steps.length === 0)
			? [
					{
						agent: step.agentName,
						label: step.label,
						status: "queued",
						startedAt,
						sessionFile: paths.sessionFile,
					},
				]
			: opts.initialize.steps;
	// Router, not normalizer: only group-child relied on the resolved-path default
	// (its recompose passes no sessionFile because the path is minted inside the
	// funnel). sync-foreground passes neither top-level field today and MUST keep
	// status.json free of them; async passes both explicitly so the ?? is inert.
	const sessionDefault = opts.variant === "sync-foreground" ? undefined : paths.sessionFile;
	const sessionDirDefault = opts.variant === "sync-foreground" ? undefined : paths.sessionRoot;
	statusWriter.initialize({
		...opts.initialize,
		steps: initSteps,
		state,
		startedAt,
		sessionFile: opts.initialize.sessionFile ?? sessionDefault,
		sessionDir: opts.initialize.sessionDir ?? sessionDirDefault,
	});
	try {
		appendRunEntry({
			runId,
			runRecordDir: paths.runRecordDir,
			mode: "single",
			source: opts.source ?? "sync",
			agentName: step.agentName,
			...(opts.initialize.label ? { label: opts.initialize.label } : {}),
			...(opts.phaseIndex !== undefined ? { phaseIndex: opts.phaseIndex } : {}),
			...(opts.phaseTitle ? { phaseTitle: opts.phaseTitle } : {}),
			...(opts.parallelGroupId ? { parallelGroupId: opts.parallelGroupId } : {}),
			...(opts.pipeline
				? {
						pipelineId: opts.pipeline.id,
						pipelineItemIndex: opts.pipeline.itemIndex,
						pipelineStageIndex: opts.pipeline.stageIndex,
						...(opts.pipeline.itemLabel ? { pipelineItemLabel: opts.pipeline.itemLabel } : {}),
					}
				: {}),
			...(opts.parentRunId ? { parentRunId: opts.parentRunId } : {}),
			rootRunId: opts.rootRunId ?? runId,
			...(opts.parentSessionId ? { parentSessionId: opts.parentSessionId } : {}),
			...(opts.rootSessionId ? { rootSessionId: opts.rootSessionId } : {}),
			cwd: step.cwd,
			startedAt,
		});
	} catch (error) {
		// The registry is the sole discovery path: a status.json without a global
		// row is an invisible orphan. Roll back the partial commit (best effort)
		// and surface ONE clear error instead of a half-registered run.
		statusWriter.dispose();
		try {
			fs.rmSync(path.join(paths.runRecordDir, "status.json"), { force: true });
		} catch {
			// best-effort cleanup; the registry row is absent so the dir is unreachable anyway
		}
		throw new Error(
			`Failed to register run ${runId} in the runs registry: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error instanceof Error ? error : undefined },
		);
	}
	return {
		runId,
		runRecordDir: paths.runRecordDir,
		sessionFile: paths.sessionFile,
		startedAt,
		statusWriter,
		variant: opts.variant,
	};
}

export type FinalizeRunPayload =
	| { via: "result"; result: ChildAgentResult; totalUsage?: Usage }
	| {
			via: "terminal";
			state: "complete" | "failed" | "interrupted";
			steps: Array<Partial<PersistedRunStep>>;
			totalTokens?: TokenUsage;
			totalUsage?: Usage;
			outputText?: string;
			error?: string;
	  };

// finalize ONLY; dispose stays at call sites.
export function finalizeRun(handle: OpenRunHandle, payload: FinalizeRunPayload): void {
	if (payload.via === "terminal") {
		if (handle.variant !== "sync-foreground")
			throw new Error(`finalizeRun: 'terminal' payload requires sync-foreground variant, got ${handle.variant}`);
		handle.statusWriter.finalizeTerminal({
			state: payload.state,
			steps: payload.steps,
			...(payload.totalTokens !== undefined ? { totalTokens: payload.totalTokens } : {}),
			...(payload.totalUsage !== undefined ? { totalUsage: payload.totalUsage } : {}),
			...(payload.outputText !== undefined ? { outputText: payload.outputText } : {}),
			...(payload.error !== undefined ? { error: payload.error } : {}),
		});
	} else {
		if (handle.variant === "sync-foreground")
			throw new Error(
				`finalizeRun: 'result' payload requires group-child or async-detached variant, got ${handle.variant}`,
			);
		void handle.statusWriter.finalize(
			payload.result,
			payload.totalUsage !== undefined ? { totalUsage: payload.totalUsage } : undefined,
		);
	}
}

export function spawnRun(step: Layer0RunStep, opts: SpawnRunOpts): Layer0RunHandle {
	const handle = openRunRecord(step, {
		...(opts.parentRunId ? { parentRunId: opts.parentRunId } : {}),
		...(opts.rootRunId ? { rootRunId: opts.rootRunId } : {}),
		...(opts.source ? { source: opts.source } : {}),
		parentSessionFile: opts.parentSessionFile ?? null,
		...(opts.sessionDir ? { sessionDir: opts.sessionDir } : {}),
		...(opts.defaultSessionDir ? { defaultSessionDir: opts.defaultSessionDir } : {}),
		...(opts.rootSessionId ? { rootSessionId: opts.rootSessionId } : {}),
		...(opts.parentSessionId ? { parentSessionId: opts.parentSessionId } : {}),
		...(opts.phaseIndex !== undefined ? { phaseIndex: opts.phaseIndex } : {}),
		...(opts.phaseTitle ? { phaseTitle: opts.phaseTitle } : {}),
		...(opts.parallelGroupId ? { parallelGroupId: opts.parallelGroupId } : {}),
		...(opts.pipeline ? { pipeline: opts.pipeline } : {}),
		variant: "group-child",
		initialize: {
			mode: "single",
			cwd: step.cwd,
			startedAt: Date.now(),
			currentStep: 0,
			...(step.label ? { label: step.label } : {}),
			...(opts.parentRunId ? { parentRunId: opts.parentRunId } : {}),
			steps: [],
		},
	});
	const runId = handle.runId;
	const startedAt = handle.startedAt;

	const controller = new AbortController();
	registerRunController(runId, controller);
	const preparedStep: Layer0PreparedRunStep = {
		...step,
		runId,
		stepIndex: 0,
		runRecordDir: handle.runRecordDir,
		sessionFile: handle.sessionFile,
	};
	opts.onLifecycle?.({
		type: "run.started",
		runId,
		runRecordDir: handle.runRecordDir,
		sessionFile: handle.sessionFile,
		timestamp: startedAt,
	});
	const completed = opts
		.runAgent(preparedStep, { abortSignal: controller.signal, statusWriter: handle.statusWriter })
		.then(
			async (result) => {
				opts.onLifecycle?.({
					type: "run.completed",
					runId,
					runRecordDir: handle.runRecordDir,
					sessionFile: handle.sessionFile,
					timestamp: Date.now(),
					result,
				});
				finalizeRun(handle, { via: "result", result });
				return result;
			},
			(error: unknown) => {
				opts.onLifecycle?.({
					type: "run.completed",
					runId,
					runRecordDir: handle.runRecordDir,
					sessionFile: handle.sessionFile,
					timestamp: Date.now(),
					error,
				});
				// A rejected leaf must not leave status.json frozen non-terminal
				// (queued/running forever): finalize the persisted record as failed
				// before the writer is disposed, then rethrow for the awaiting caller.
				const endedAt = Date.now();
				finalizeRun(handle, {
					via: "result",
					result: {
						runId,
						stepIndex: 0,
						state: "failed",
						exitCode: 1,
						outputText: "",
						toolCallCount: 0,
						toolResultCount: 0,
						toolErrorCount: 0,
						durationMs: endedAt - startedAt,
						startedAt,
						endedAt,
						sessionFile: handle.sessionFile,
						error: { message: error instanceof Error ? error.message : String(error) },
					},
				});
				throw error;
			},
		)
		.finally(() => {
			releaseRunController(runId);
			handle.statusWriter.dispose();
		});

	return {
		runId,
		runRecordDir: handle.runRecordDir,
		sessionFile: handle.sessionFile,
		completed,
		notifyPolicy: opts.notifyPolicy,
	};
}

export function openGroup(opts: OpenGroupOpts): Layer0GroupHandle {
	const runId = randomUUID();
	const sessionPaths = resolveChildSessionFile({
		parentCwd: opts.cwd,
		parentSessionFile: opts.parentSessionFile ?? null,
		runId,
		stepIndex: 0,
		...(opts.sessionDir ? { sessionDirOverride: opts.sessionDir } : {}),
		...(opts.defaultSessionDir ? { defaultSessionDir: opts.defaultSessionDir } : {}),
	});
	appendRunEntry({
		runId,
		runRecordDir: sessionPaths.runRecordDir,
		mode: opts.mode ?? "parallel",
		source: opts.source ?? "sync",
		...(opts.kind ? { kind: opts.kind } : {}),
		...(opts.label ? { label: opts.label } : {}),
		...(opts.parentRunId ? { parentRunId: opts.parentRunId } : {}),
		rootRunId: opts.rootRunId ?? runId,
		...(opts.parentSessionId ? { parentSessionId: opts.parentSessionId } : {}),
		...(opts.rootSessionId ? { rootSessionId: opts.rootSessionId } : {}),
		cwd: opts.cwd,
		startedAt: Date.now(),
	});
	return { runId, runRecordDir: sessionPaths.runRecordDir, notifyPolicy: opts.notifyPolicy };
}

export async function awaitRun(handle: Layer0RunHandle): Promise<ChildAgentResult> {
	return handle.completed;
}

export function interruptRun(runId: string, opts: InterruptRunOpts): InterruptRunResult {
	const targetRunIds = new Set<string>([runId]);
	if (opts.cascade) {
		const entries = readAllEntries();
		let added = true;
		while (added) {
			added = false;
			for (const entry of entries) {
				if (entry.parentRunId && targetRunIds.has(entry.parentRunId) && !targetRunIds.has(entry.runId)) {
					targetRunIds.add(entry.runId);
					added = true;
				}
			}
		}
	}

	const interruptedRunIds: string[] = [];
	for (const targetRunId of targetRunIds) {
		const controller = controllersByRunId.get(targetRunId);
		if (!controller || controller.signal.aborted) continue;
		controller.abort(new Error(`Interrupted run ${targetRunId}`));
		interruptedRunIds.push(targetRunId);
	}
	return { interruptedRunIds };
}

export interface AwaitRunTerminalOpts {
	/** Absolute epoch-ms deadline; past it the wait gives up with terminal:false. */
	deadline: number;
	/** Same-activation completion promise (registry handle); preferred over polling. */
	completed?: Promise<ChildAgentResult>;
	/** Run-record dir for the disk-poll source; resolved from the runs registry when omitted. */
	runRecordDir?: string;
	pollIntervalMs?: number;
}

export type AwaitRunTerminalOutcome = { terminal: true; state: string } | { terminal: false };

const RUN_TERMINAL_STATES: ReadonlySet<string> = new Set([
	"complete",
	"failed",
	"interrupted",
	"skipped",
	"paused",
	"lost",
]);

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		timer.unref?.();
	});
}

interface RunTerminalProbe {
	/** False when there is no watchable source at all (no status.json, no registered children). */
	observable: boolean;
	state?: string;
}

function probeRunTerminal(runId: string, runRecordDir: string | undefined): RunTerminalProbe {
	const dir = runRecordDir ?? readAllEntries().find((entry) => entry.runId === runId)?.runRecordDir;
	if (!dir) return { observable: false };
	let status: PersistedRunStatus | null = null;
	try {
		status = readStatus(dir);
	} catch {
		// Transient read failure: the file exists but is momentarily unreadable;
		// keep polling rather than degrading.
		return { observable: true };
	}
	if (status) {
		return RUN_TERMINAL_STATES.has(status.state) ? { observable: true, state: status.state } : { observable: true };
	}
	// Statusless container (parallel/workflow group): the group itself never writes
	// a status.json, so its terminal moment is "every registered child is terminal".
	const children = readAllEntries().filter((entry) => entry.parentRunId === runId);
	if (children.length === 0) return { observable: false };
	const childStates: string[] = [];
	for (const child of children) {
		let childStatus: PersistedRunStatus | null = null;
		try {
			childStatus = readStatus(child.runRecordDir);
		} catch {
			return { observable: true };
		}
		if (!childStatus || !RUN_TERMINAL_STATES.has(childStatus.state)) return { observable: true };
		childStates.push(childStatus.state);
	}
	return {
		observable: true,
		state: childStates.includes("interrupted") ? "interrupted" : computeGroupStatus(childStates),
	};
}

/**
 * Wait until a run reaches a terminal state, bounded by an absolute deadline.
 * Two sources, one helper: a same-activation registry handle resolves through
 * its completed promise; a cross-instance run (post-reload, no reachable
 * promise) is polled from its persisted status.json until terminal. Statusless
 * group containers derive their terminal state from their registered children.
 * A run with no watchable source at all (no run record, no children) returns
 * terminal:false immediately — polling could never observe it flipping.
 */
export async function awaitRunTerminal(runId: string, opts: AwaitRunTerminalOpts): Promise<AwaitRunTerminalOutcome> {
	const pollIntervalMs = opts.pollIntervalMs ?? 250;
	if (opts.completed) {
		const raced = await Promise.race([
			opts.completed.then(
				(result): AwaitRunTerminalOutcome => ({ terminal: true, state: result.state }),
				(): AwaitRunTerminalOutcome => ({
					terminal: true,
					state: probeRunTerminal(runId, opts.runRecordDir).state ?? "failed",
				}),
			),
			sleep(Math.max(0, opts.deadline - Date.now())).then(() => undefined),
		]);
		return raced ?? { terminal: false };
	}
	let probe = probeRunTerminal(runId, opts.runRecordDir);
	if (!probe.observable) return { terminal: false };
	while (probe.state === undefined) {
		const remaining = opts.deadline - Date.now();
		if (remaining <= 0) return { terminal: false };
		await sleep(Math.min(pollIntervalMs, remaining));
		probe = probeRunTerminal(runId, opts.runRecordDir);
	}
	return { terminal: true, state: probe.state };
}
