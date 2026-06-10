import { randomUUID } from "node:crypto";
import { readAllEntries, appendRunEntry } from "../state/runs-registry.ts";
import { resolveChildSessionFile } from "../state/session-paths.ts";
import { StatusWriter } from "../state/status-writer.ts";
import type { ChildAgentResult } from "./in-process-executor.ts";

export type Layer0GroupStatus = "running" | "complete" | "failed";
export type Layer0ChildStatus = "pending" | "queued" | "running" | "complete" | "failed" | "interrupted" | string;

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

export function computeGroupStatus(childStatuses: Layer0ChildStatus[]): Layer0GroupStatus {
	if (childStatuses.some((status) => status === "pending" || status === "queued" || status === "running")) return "running";
	if (childStatuses.some((status) => status === "failed" || status === "interrupted")) return "failed";
	return "complete";
}

export function spawnRun(step: Layer0RunStep, opts: SpawnRunOpts): Layer0RunHandle {
	const runId = randomUUID();
	const sessionPaths = resolveChildSessionFile({
		parentCwd: step.cwd,
		parentSessionFile: opts.parentSessionFile ?? null,
		runId,
		stepIndex: 0,
		...(opts.sessionDir ? { sessionDirOverride: opts.sessionDir } : {}),
		...(opts.defaultSessionDir ? { defaultSessionDir: opts.defaultSessionDir } : {}),
	});
	const startedAt = Date.now();
	const statusWriter = new StatusWriter({ runRecordDir: sessionPaths.runRecordDir, runId });
	statusWriter.initialize({
		mode: "single",
		cwd: step.cwd,
		startedAt,
		state: "running",
		currentStep: 0,
		...(step.label ? { label: step.label } : {}),
		...(opts.parentRunId ? { parentRunId: opts.parentRunId } : {}),
		steps: [{ agent: step.agentName, label: step.label, status: "running", startedAt, sessionFile: sessionPaths.sessionFile }],
		sessionFile: sessionPaths.sessionFile,
		sessionDir: sessionPaths.sessionRoot,
	});
	appendRunEntry({
		runId,
		runRecordDir: sessionPaths.runRecordDir,
		mode: "single",
		source: opts.source ?? "sync",
		agentName: step.agentName,
		...(step.label ? { label: step.label } : {}),
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

	const controller = new AbortController();
	controllersByRunId.set(runId, controller);
	const preparedStep: Layer0PreparedRunStep = {
		...step,
		runId,
		stepIndex: 0,
		runRecordDir: sessionPaths.runRecordDir,
		sessionFile: sessionPaths.sessionFile,
	};
	opts.onLifecycle?.({ type: "run.started", runId, runRecordDir: sessionPaths.runRecordDir, sessionFile: sessionPaths.sessionFile, timestamp: startedAt });
	const completed = opts.runAgent(preparedStep, { abortSignal: controller.signal, statusWriter })
		.then(async (result) => {
			opts.onLifecycle?.({ type: "run.completed", runId, runRecordDir: sessionPaths.runRecordDir, sessionFile: sessionPaths.sessionFile, timestamp: Date.now(), result });
			await statusWriter.finalize(result);
			return result;
		}, (error: unknown) => {
			opts.onLifecycle?.({ type: "run.completed", runId, runRecordDir: sessionPaths.runRecordDir, sessionFile: sessionPaths.sessionFile, timestamp: Date.now(), error });
			throw error;
		})
		.finally(() => {
			controllersByRunId.delete(runId);
			statusWriter.dispose();
		});

	return {
		runId,
		runRecordDir: sessionPaths.runRecordDir,
		sessionFile: sessionPaths.sessionFile,
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
