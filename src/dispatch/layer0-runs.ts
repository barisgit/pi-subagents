import { randomUUID } from "node:crypto";
import { readAllEntries, appendRunEntry } from "../state/runs-registry.ts";
import { resolveChildSessionFile } from "../state/session-paths.ts";
import { StatusWriter, type StatusMeta } from "../state/status-writer.ts";
import type { ChildAgentResult, PersistedRunStep } from "../protocol/status-types.ts";
import type { TokenUsage, Usage } from "../protocol/types.ts";
import { computeGroupStatus, type Layer0ChildStatus, type Layer0GroupStatus } from "../state/group-status.ts";

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
	| { type: "run.completed"; runId: string; runRecordDir: string; sessionFile: string; timestamp: number; result?: ChildAgentResult; error?: unknown };

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

const controllersByRunId = new Map<string, AbortController>();

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
	const paths = (opts.runRecordDir && opts.sessionFile)
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
	const state = opts.variant === "async-detached" ? "queued" : "running";
	// eager OMITS the flushPolicy field to byte-match today's spawnRun (no flushPolicy) + async (default).
	const statusWriter = new StatusWriter({ runRecordDir: paths.runRecordDir, runId, ...(flushPolicy === "terminal" ? { flushPolicy: "terminal" } : {}) });
	// group-child: if initialize.steps empty, synthesize spawnRun's single running step with resolved sessionFile.
	const initSteps = (opts.variant === "group-child" && (!opts.initialize.steps || opts.initialize.steps.length === 0))
		? [{ agent: step.agentName, label: step.label, status: "running", startedAt, sessionFile: paths.sessionFile }]
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
		...(opts.parentRunId ? { parentRunId: opts.parentRunId } : {}),
		rootRunId: opts.rootRunId ?? runId,
		...(opts.parentSessionId ? { parentSessionId: opts.parentSessionId } : {}),
		...(opts.rootSessionId ? { rootSessionId: opts.rootSessionId } : {}),
		cwd: step.cwd,
		startedAt,
	});
	return { runId, runRecordDir: paths.runRecordDir, sessionFile: paths.sessionFile, startedAt, statusWriter, variant: opts.variant };
}

export type FinalizeRunPayload =
	| { via: "result"; result: ChildAgentResult; totalUsage?: Usage }
	| { via: "terminal"; state: "complete" | "failed"; steps: Array<Partial<PersistedRunStep>>; totalTokens?: TokenUsage };

// finalize ONLY; dispose stays at call sites.
export function finalizeRun(handle: OpenRunHandle, payload: FinalizeRunPayload): void {
	if (payload.via === "terminal") {
		if (handle.variant !== "sync-foreground") throw new Error(`finalizeRun: 'terminal' payload requires sync-foreground variant, got ${handle.variant}`);
		handle.statusWriter.finalizeTerminal({ state: payload.state, steps: payload.steps, ...(payload.totalTokens !== undefined ? { totalTokens: payload.totalTokens } : {}) });
	} else {
		if (handle.variant === "sync-foreground") throw new Error(`finalizeRun: 'result' payload requires group-child or async-detached variant, got ${handle.variant}`);
		void handle.statusWriter.finalize(payload.result, payload.totalUsage !== undefined ? { totalUsage: payload.totalUsage } : undefined);
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
	controllersByRunId.set(runId, controller);
	const preparedStep: Layer0PreparedRunStep = {
		...step,
		runId,
		stepIndex: 0,
		runRecordDir: handle.runRecordDir,
		sessionFile: handle.sessionFile,
	};
	opts.onLifecycle?.({ type: "run.started", runId, runRecordDir: handle.runRecordDir, sessionFile: handle.sessionFile, timestamp: startedAt });
	const completed = opts.runAgent(preparedStep, { abortSignal: controller.signal, statusWriter: handle.statusWriter })
		.then(async (result) => {
			opts.onLifecycle?.({ type: "run.completed", runId, runRecordDir: handle.runRecordDir, sessionFile: handle.sessionFile, timestamp: Date.now(), result });
			finalizeRun(handle, { via: "result", result });
			return result;
		}, (error: unknown) => {
			opts.onLifecycle?.({ type: "run.completed", runId, runRecordDir: handle.runRecordDir, sessionFile: handle.sessionFile, timestamp: Date.now(), error });
			throw error;
		})
		.finally(() => {
			controllersByRunId.delete(runId);
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
