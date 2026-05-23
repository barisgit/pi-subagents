import * as fs from "node:fs";
import * as path from "node:path";
import { ASYNC_NO_POLL_GUIDANCE } from "./async-guidance.ts";
import { formatDuration, formatTokens, shortenPath } from "./formatters.ts";
import { type ActivityState, type AsyncStatus, type RunDisplayState, type TokenUsage } from "./types.ts";
import type { RunPhase } from "./run-phase.ts";
import { DEFAULT_CONTROL_CONFIG, deriveActivityState } from "./subagent-control.ts";
import { deriveRunDisplayState } from "./run-liveness.ts";
import { readStatus } from "./utils.ts";
import { readAllEntries, type RunsRegistryEntry } from "./runs-registry.ts";

export interface AsyncRunStepSummary {
	index: number;
	agent: string;
	label?: string;
	status: string;
	activityState?: ActivityState;
	displayState?: RunDisplayState;
	/** Current execution phase mirrored from status.steps[i].live. */
	phase?: RunPhase;
	/** Milliseconds since epoch when the step's current phase was entered. */
	phaseStartedAt?: number;
	lastActivityAt?: number;
	currentTool?: string;
	currentToolStartedAt?: number;
	durationMs?: number;
	tokens?: TokenUsage;
	skills?: string[];
	model?: string;
	attemptedModels?: string[];
	error?: string;
	// Theme color token for the agent name; mirrored from status.steps[i].live.color.
	color?: string;
}

export interface AsyncRunSummary {
	id: string;
	asyncDir: string;
	// charter nested-subagent-display: dashboard hierarchy parent link.
	parentRunId?: string;
	label?: string;
	state: "queued" | "running" | "complete" | "failed" | "paused" | "lost";
	activityState?: ActivityState;
	displayState?: RunDisplayState;
	lastActivityAt?: number;
	currentTool?: string;
	currentToolStartedAt?: number;
	mode: "single" | "chain" | "parallel";
	cwd?: string;
	startedAt: number;
	lastUpdate?: number;
	endedAt?: number;
	runnerHeartbeatAt?: number;
	/** Current execution phase mirrored from status.json. */
	phase?: RunPhase;
	/** Milliseconds since epoch when the current phase was entered. */
	phaseStartedAt?: number;
	currentStep?: number;
	steps: AsyncRunStepSummary[];
	sessionDir?: string;
	outputFile?: string;
	totalTokens?: TokenUsage;
	sessionFile?: string;
}

export interface AsyncRunListOptions {
	states?: Array<AsyncRunSummary["state"]>;
	limit?: number;
}

export interface AsyncRunOverlayData {
	active: AsyncRunSummary[];
	recent: AsyncRunSummary[];
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isNotFoundError(error: unknown): boolean {
	return typeof error === "object"
		&& error !== null
		&& "code" in error
		&& (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isAsyncRunDir(root: string, entry: string): boolean {
	const entryPath = path.join(root, entry);
	try {
		return fs.statSync(entryPath).isDirectory();
	} catch (error) {
		if (isNotFoundError(error)) return false;
		throw new Error(`Failed to inspect async run path '${entryPath}': ${getErrorMessage(error)}`, {
			cause: error instanceof Error ? error : undefined,
		});
	}
}

function outputFileMtime(outputFile: string | undefined): number | undefined {
	if (!outputFile) return undefined;
	try {
		return fs.statSync(outputFile).mtimeMs;
	} catch {
		return undefined;
	}
}

function deriveAsyncActivityState(asyncDir: string, status: AsyncStatus): { activityState?: ActivityState; lastActivityAt?: number } {
	if (status.state !== "running") return { activityState: status.activityState, lastActivityAt: status.lastActivityAt };
	const outputPath = status.outputFile ? (path.isAbsolute(status.outputFile) ? status.outputFile : path.join(asyncDir, status.outputFile)) : undefined;
	const currentStep = typeof status.currentStep === "number" ? status.steps?.[status.currentStep] : undefined;
	const lastActivityAt = status.lastActivityAt ?? outputFileMtime(outputPath) ?? currentStep?.lastActivityAt ?? currentStep?.startedAt ?? status.startedAt;
	return {
		lastActivityAt,
		activityState: status.activityState ?? deriveActivityState({
			config: DEFAULT_CONTROL_CONFIG,
			startedAt: status.startedAt,
			lastActivityAt,
		}),
	};
}

export function statusToSummary(asyncDir: string, status: AsyncStatus & { cwd?: string }): AsyncRunSummary {
	const { activityState, lastActivityAt } = deriveAsyncActivityState(asyncDir, status);
	const id = status.runId || path.basename(asyncDir);
	const displayState = deriveRunDisplayState({
		state: status.state,
		activityState,
		currentTool: status.currentTool,
		lastActivityAt,
		lastUpdate: status.lastUpdate,
		runnerHeartbeatAt: status.runnerHeartbeatAt,
	});
	return {
		id,
		asyncDir,
		// charter nested-subagent-display: copy persisted parentRunId for readers.
		...(status.parentRunId ? { parentRunId: status.parentRunId } : {}),
		...(status.label ? { label: status.label } : {}),
		state: status.state,
		activityState,
		...(displayState ? { displayState } : {}),
		lastActivityAt,
		currentTool: status.currentTool,
		currentToolStartedAt: status.currentToolStartedAt,
		mode: status.mode,
		cwd: status.cwd,
		startedAt: status.startedAt,
		lastUpdate: status.lastUpdate,
		endedAt: status.endedAt,
		runnerHeartbeatAt: status.runnerHeartbeatAt,
		...(status.phase !== undefined ? { phase: status.phase } : {}),
		...(status.phaseStartedAt !== undefined ? { phaseStartedAt: status.phaseStartedAt } : {}),
		currentStep: status.currentStep,
		steps: (status.steps ?? []).map((step, index) => {
			const stepActivityState = step.activityState ?? (step.status === "running" ? activityState : undefined);
			const stepLastActivityAt = step.lastActivityAt ?? (step.status === "running" ? lastActivityAt : undefined);
			const stepDisplayState = displayState === "lost" && step.status === "running"
				? "lost"
				: deriveRunDisplayState({
					state: step.status,
					activityState: stepActivityState,
					currentTool: step.currentTool,
					lastActivityAt: stepLastActivityAt,
					lastUpdate: status.lastUpdate,
					runnerHeartbeatAt: status.runnerHeartbeatAt,
				});
			return {
				index,
				agent: step.agent ?? "",
				...(step.label ? { label: step.label } : {}),
				status: step.status,
				...(stepActivityState ? { activityState: stepActivityState } : {}),
				...(stepDisplayState ? { displayState: stepDisplayState } : {}),
				...(stepLastActivityAt ? { lastActivityAt: stepLastActivityAt } : {}),
				...(step.currentTool ? { currentTool: step.currentTool } : {}),
				...(step.currentToolStartedAt ? { currentToolStartedAt: step.currentToolStartedAt } : {}),
				...(step.durationMs !== undefined ? { durationMs: step.durationMs } : {}),
				...(step.tokens ? { tokens: step.tokens } : {}),
				...(step.skills ? { skills: step.skills } : {}),
				...(step.model ? { model: step.model } : {}),
				...(step.attemptedModels ? { attemptedModels: step.attemptedModels } : {}),
				...(step.error ? { error: step.error } : {}),
				...(step.live?.phase !== undefined ? { phase: step.live.phase } : {}),
				...(step.live?.phaseStartedAt !== undefined ? { phaseStartedAt: step.live.phaseStartedAt } : {}),
				...(step.live?.color ? { color: step.live.color } : {}),
			};
		}),
		...(status.sessionDir ? { sessionDir: status.sessionDir } : {}),
		...(status.outputFile ? { outputFile: status.outputFile } : {}),
		...(status.totalTokens ? { totalTokens: status.totalTokens } : {}),
		...(status.sessionFile ? { sessionFile: status.sessionFile } : {}),
	};
}

export function sortRuns(runs: AsyncRunSummary[]): AsyncRunSummary[] {
	const rank = (state: AsyncRunSummary["state"]): number => {
		switch (state) {
			case "running": return 0;
			case "queued": return 1;
		case "lost": return 2;
		case "failed": return 2;
		case "paused": return 2;
		case "complete": return 3;
		}
	};
	return [...runs].sort((a, b) => {
		const byState = rank(a.state) - rank(b.state);
		if (byState !== 0) return byState;
		// Stable order by spawn time (newest first). Using updatedAt makes rows leap
		// every poll tick as activity bumps them up; startedAt is the natural mental
		// model for users tracking 'the run I just spawned'.
		return b.startedAt - a.startedAt;
	});
}

export function listAsyncRuns(asyncDirRoot: string, options: AsyncRunListOptions = {}): AsyncRunSummary[] {
	let entries: string[];
	try {
		entries = fs.readdirSync(asyncDirRoot).filter((entry) => isAsyncRunDir(asyncDirRoot, entry));
	} catch (error) {
		if (isNotFoundError(error)) return [];
		throw new Error(`Failed to list async runs in '${asyncDirRoot}': ${getErrorMessage(error)}`, {
			cause: error instanceof Error ? error : undefined,
		});
	}

	const allowedStates = options.states ? new Set(options.states) : undefined;
	const runs: AsyncRunSummary[] = [];
	for (const entry of entries) {
		const asyncDir = path.join(asyncDirRoot, entry);
		const status = readStatus(asyncDir) as (AsyncStatus & { cwd?: string }) | null;
		if (!status) continue;
		const summary = statusToSummary(asyncDir, status);
		if (allowedStates && !allowedStates.has(summary.state)) continue;
		runs.push(summary);
	}

	const sorted = sortRuns(runs);
	return options.limit !== undefined ? sorted.slice(0, options.limit) : sorted;
}

// Registry-backed reader. Single source of truth for run discovery: enumerates
// the runs-index.jsonl registry instead of scanning a temp dir. Both sync and
// async runs appear as equal first-class entries.
export function listRunsFromRegistry(options: { states?: AsyncRunSummary["state"][]; limit?: number } = {}): AsyncRunSummary[] {
	const entries = readAllEntries();
	const allowedStates = options.states ? new Set(options.states) : undefined;
	const runs: AsyncRunSummary[] = [];
	const seen = new Set<string>();
	for (const entry of entries) {
		if (seen.has(entry.runId)) continue;
		seen.add(entry.runId);
		const summary = readSummaryForEntry(entry);
		if (!summary) continue;
		if (allowedStates && !allowedStates.has(summary.state)) continue;
		runs.push(summary);
	}
	const sorted = sortRuns(runs);
	return options.limit !== undefined ? sorted.slice(0, options.limit) : sorted;
}

export function listRunsFromRegistryForOverlay(recentLimit = 5): AsyncRunOverlayData {
	const all = listRunsFromRegistry();
	const recent = all
		.filter((run) => run.state === "complete" || run.state === "failed" || run.state === "paused")
		.sort((a, b) => b.startedAt - a.startedAt)
		.slice(0, recentLimit);
	return {
		active: all.filter((run) => run.state === "queued" || run.state === "running" || run.state === "lost"),
		recent,
	};
}

function readSummaryForEntry(entry: RunsRegistryEntry): AsyncRunSummary | null {
	const status = readStatus(entry.runRecordDir) as (AsyncStatus & { cwd?: string }) | null;
	if (status) return statusToSummary(entry.runRecordDir, status);
	// No status.json yet: synthesize a minimal queued/running stub from the
	// registry entry. Keeps the overlay populated the moment a run is dispatched.
	const agents = entry.agentNames ?? (entry.agentName ? [entry.agentName] : []);
	return {
		id: entry.runId,
		asyncDir: entry.runRecordDir,
		mode: entry.mode,
		state: "queued",
		startedAt: entry.startedAt,
		cwd: entry.cwd,
		currentStep: 0,
		...(entry.label ? { label: entry.label } : {}),
		...(entry.parentRunId ? { parentRunId: entry.parentRunId } : {}),
		steps: agents.map((agent, index) => ({ index, agent, status: "queued" as const })),
	};
}

function formatActivityFacts(input: { activityState?: ActivityState; lastActivityAt?: number; currentTool?: string; currentToolStartedAt?: number }): string | undefined {
	if (input.currentTool && input.currentToolStartedAt) return `tool ${input.currentTool} ${formatDuration(Math.max(0, Date.now() - input.currentToolStartedAt))}`;
	if (!input.lastActivityAt) return input.activityState === "needs_attention" ? "needs attention" : undefined;
	const elapsed = formatDuration(Math.max(0, Date.now() - input.lastActivityAt));
	return input.activityState === "needs_attention" ? `no activity for ${elapsed}` : `active ${elapsed} ago`;
}

function formatStepLine(step: AsyncRunStepSummary): string {
	const parts = [`${step.index + 1}. ${step.agent}`, step.displayState ? `${step.status}/${step.displayState}` : step.status];
	const activity = formatActivityFacts(step);
	if (activity) parts.push(activity);
	if (step.model) parts.push(step.model);
	if (step.durationMs !== undefined) parts.push(formatDuration(step.durationMs));
	if (step.tokens) parts.push(`${formatTokens(step.tokens.total)} tok`);
	return parts.join(" | ");
}

function formatRunHeader(run: AsyncRunSummary): string {
	const stepCount = run.steps.length || 1;
	const completedParallelSteps = run.steps.filter((step) => step.status === "complete" || step.status === "failed" || step.status === "skipped").length;
	const stepLabel = run.mode === "parallel"
		? `tasks ${completedParallelSteps}/${stepCount} complete`
		: run.currentStep !== undefined ? `step ${run.currentStep + 1}/${stepCount}` : `steps ${stepCount}`;
	const cwd = run.cwd ? shortenPath(run.cwd) : shortenPath(run.asyncDir);
	const activity = formatActivityFacts(run);
	const state = run.displayState ? `${run.state}/${run.displayState}` : run.state;
	return `${run.id} | ${state}${activity ? ` | ${activity}` : ""} | ${run.mode} | ${stepLabel} | ${cwd}`;
}

export function formatAsyncRunList(runs: AsyncRunSummary[], heading = "Active async runs"): string {
	if (runs.length === 0) return `No ${heading.toLowerCase()}.`;

	const lines = [`${heading}: ${runs.length}`, ASYNC_NO_POLL_GUIDANCE, ""];
	for (const run of runs) {
		lines.push(`- ${formatRunHeader(run)}`);
		for (const step of run.steps) {
			lines.push(`  ${formatStepLine(step)}`);
		}
		if (run.sessionFile) lines.push(`  session: ${shortenPath(run.sessionFile)}`);
		lines.push("");
	}
	return lines.join("\n").trimEnd();
}
