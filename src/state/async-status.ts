import * as fs from "node:fs";
import * as path from "node:path";
import { ASYNC_NO_POLL_GUIDANCE, formatDuration, formatTokens, shortenPath } from "../shared/formatting.ts";
import type { ActivityState, RunDisplayState, TokenUsage } from "../protocol/types.ts";
import type { PersistedRunStatus } from "../protocol/status-types.ts";
import type { RunPhase } from "./run-phase.ts";
import { DEFAULT_CONTROL_CONFIG, deriveActivityState } from "../shared/control-policy.ts";
import { deriveRunDisplayState } from "./run-liveness.ts";
import { readStatus } from "../shared/utils.ts";
import { readAllEntries, readShardEntries, type RunsRegistryEntry } from "./runs-registry.ts";
import { computeGroupStatus, type Layer0ChildStatus } from "./group-status.ts";
import { readWorkflowGroupState } from "../workflow/workflow-group-state.ts";
import type { RunView, RunViewStep } from "./run-view.ts";

// charter VAL-RUNVIEW-TYPE: AsyncRunSummary/AsyncRunStepSummary are now aliases
// of the canonical RunView/RunViewStep display types. All existing importers
// keep compiling unchanged; the two former interface bodies were unified into
// src/state/run-view.ts.
export type AsyncRunStepSummary = RunViewStep;
export type AsyncRunSummary = RunView;

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
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as NodeJS.ErrnoException).code === "ENOENT"
	);
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

function deriveAsyncActivityState(
	asyncDir: string,
	status: PersistedRunStatus,
): { activityState?: ActivityState; lastActivityAt?: number } {
	if (status.state !== "running")
		return { activityState: status.activityState, lastActivityAt: status.lastActivityAt };
	const outputPath = status.outputFile
		? path.isAbsolute(status.outputFile)
			? status.outputFile
			: path.join(asyncDir, status.outputFile)
		: undefined;
	const currentStep = typeof status.currentStep === "number" ? status.steps?.[status.currentStep] : undefined;
	const lastActivityAt =
		status.lastActivityAt ??
		outputFileMtime(outputPath) ??
		currentStep?.lastActivityAt ??
		currentStep?.startedAt ??
		status.startedAt;
	return {
		lastActivityAt,
		activityState:
			status.activityState ??
			deriveActivityState({
				config: DEFAULT_CONTROL_CONFIG,
				startedAt: status.startedAt,
				lastActivityAt,
				phase: status.phase,
			}),
	};
}

export function statusToRunView(asyncDir: string, status: PersistedRunStatus & { cwd?: string }): AsyncRunSummary {
	const { activityState, lastActivityAt } = deriveAsyncActivityState(asyncDir, status);
	const id = status.runId || path.basename(asyncDir);
	const displayState = deriveRunDisplayState({
		state: status.state,
		activityState,
		currentTool: status.currentTool,
		phase: status.phase,
		phaseStartedAt: status.phaseStartedAt,
		lastActivityAt,
		lastUpdate: status.lastUpdate,
		runnerHeartbeatAt: status.runnerHeartbeatAt,
		runnerPid: status.runnerPid,
		runnerToken: status.runnerToken,
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
		...(status.executionStartedAt !== undefined ? { executionStartedAt: status.executionStartedAt } : {}),
		lastUpdate: status.lastUpdate,
		endedAt: status.endedAt,
		runnerHeartbeatAt: status.runnerHeartbeatAt,
		...(status.resumedAt !== undefined ? { resumedAt: status.resumedAt } : {}),
		resumeCount: status.resumeCount ?? 0,
		...(status.phase !== undefined ? { phase: status.phase } : {}),
		...(status.phaseStartedAt !== undefined ? { phaseStartedAt: status.phaseStartedAt } : {}),
		currentStep: status.currentStep,
		steps: (status.steps ?? []).map((step, index) => {
			const stepActivityState = step.activityState ?? (step.status === "running" ? activityState : undefined);
			const stepLastActivityAt = step.lastActivityAt ?? (step.status === "running" ? lastActivityAt : undefined);
			const stepPhase = step.live?.phase ?? (index === status.currentStep ? status.phase : undefined);
			const stepPhaseStartedAt =
				step.live?.phaseStartedAt ?? (index === status.currentStep ? status.phaseStartedAt : undefined);
			const stepDisplayState =
				displayState === "lost" && step.status === "running"
					? "lost"
					: deriveRunDisplayState({
							state: step.status,
							activityState: stepActivityState,
							currentTool: step.currentTool,
							phase: stepPhase,
							phaseStartedAt: stepPhaseStartedAt,
							lastActivityAt: stepLastActivityAt,
							lastUpdate: status.lastUpdate,
							runnerHeartbeatAt: status.runnerHeartbeatAt,
							runnerPid: status.runnerPid,
							runnerToken: status.runnerToken,
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
		...(status.outputText !== undefined ? { finalOutput: status.outputText } : {}),
		...(status.totalTokens ? { totalTokens: status.totalTokens } : {}),
		...(status.sessionFile ? { sessionFile: status.sessionFile } : {}),
	};
}

export function sortRuns(runs: AsyncRunSummary[]): AsyncRunSummary[] {
	const rank = (state: AsyncRunSummary["state"]): number => {
		switch (state) {
			case "running":
				return 0;
			case "queued":
				return 1;
			case "lost":
				return 2;
			case "failed":
				return 2;
			case "paused":
				return 2;
			case "complete":
				return 3;
			default:
				return 4;
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
		const status = readStatus(asyncDir) as (PersistedRunStatus & { cwd?: string }) | null;
		if (!status) continue;
		const summary = statusToRunView(asyncDir, status);
		if (allowedStates && !allowedStates.has(summary.state)) continue;
		runs.push(summary);
	}

	const sorted = sortRuns(runs);
	return options.limit !== undefined ? sorted.slice(0, options.limit) : sorted;
}

// Registry-backed reader. Single source of truth for run discovery: enumerates
// the runs-index.jsonl registry instead of scanning a temp dir. Both sync and
// async runs appear as equal first-class entries.
export function listRunsFromRegistry(
	options: {
		states?: AsyncRunSummary["state"][];
		limit?: number;
		entries?: RunsRegistryEntry[];
		ownedViews?: Map<string, AsyncRunSummary>;
	} = {},
): AsyncRunSummary[] {
	const entries = options.entries ?? readAllEntries();
	const allowedStates = options.states ? new Set(options.states) : undefined;
	const runs: AsyncRunSummary[] = [];
	const seen = new Set<string>();
	for (const entry of entries) {
		if (seen.has(entry.runId)) continue;
		seen.add(entry.runId);
		const summary = readRunViewForEntry(entry, entries, options.ownedViews);
		if (!summary) continue;
		if (allowedStates && !allowedStates.has(summary.state)) continue;
		runs.push(summary);
	}
	const sorted = sortRuns(runs);
	return options.limit !== undefined ? sorted.slice(0, options.limit) : sorted;
}

export function listRunsFromRegistryForOverlay(
	// undefined means unlimited (the session-scoped overlay shows the whole
	// session); callers that still want a top-N pass an explicit number.
	recentLimit?: number,
	options: { sessionCwd?: string; sessionId?: string } = {},
	ownedViews?: Map<string, AsyncRunSummary>,
): AsyncRunOverlayData {
	const all = options.sessionId
		? listRunsFromRegistry({ entries: readShardEntries(options.sessionId), ...(ownedViews ? { ownedViews } : {}) })
		: listRunsFromRegistry(ownedViews ? { ownedViews } : {});
	// Scope BEFORE the recent-limit slice. Otherwise the top-N most recent
	// completed runs across every project drown out the current session's
	// history and the overlay renders "0 total" even though runs-index.jsonl
	// has matching entries.
	//
	// sessionId is the strict scope: only runs whose tree rooted at the current
	// user session. We match on rootSessionId for nested runs and fall back to
	// parentSessionId for legacy entries that predate the rootSessionId field.
	// sessionCwd is the looser project-scoped fallback when no sessionId is
	// known. In every mode entries with unknown metadata are kept permissively
	// so legacy and in-flight rows do not silently vanish.
	let scoped = all;
	if (options.sessionId) {
		const sid = options.sessionId;
		scoped = scoped.filter((run) => {
			const tag = run.rootSessionId ?? run.parentSessionId;
			return !tag || tag === sid;
		});
	} else if (options.sessionCwd) {
		scoped = scoped.filter((run) => !run.cwd || run.cwd === options.sessionCwd);
	}
	const sortedTerminal = scoped
		.filter(
			(run) =>
				run.state === "complete" ||
				run.state === "failed" ||
				run.state === "paused" ||
				run.state === "interrupted" ||
				run.state === "skipped",
		)
		.sort((a, b) => b.startedAt - a.startedAt);
	const recent = recentLimit === undefined ? sortedTerminal : sortedTerminal.slice(0, recentLimit);
	return {
		active: scoped.filter((run) => run.state === "queued" || run.state === "running" || run.state === "lost"),
		recent,
	};
}

// Synthesized queued stubs are only useful within a narrow post-dispatch
// window before status.json gets written. Beyond this age, an entry without a
// status.json is almost always an orphan: test temp-dir runs that wiped their
// runRecordDir, or runs from sessions that crashed before the first status
// flush. Surfacing thousands of these as live `queued` rows is what produced
// the `subagent({ action: "status" })` wall the user hit.
const QUEUED_STUB_MAX_AGE_MS = 60_000;

export function isQueuedStubRecent(entry: RunsRegistryEntry, now = Date.now()): boolean {
	return now - entry.startedAt <= QUEUED_STUB_MAX_AGE_MS;
}

function registryWorkflowFields(
	entry: RunsRegistryEntry,
): Pick<AsyncRunSummary, "workflow" | "phaseIndex" | "phaseTitle" | "parallelGroupId" | "pipeline"> {
	return {
		...(entry.kind === "workflow" ? { workflow: true } : {}),
		...(entry.phaseIndex !== undefined ? { phaseIndex: entry.phaseIndex } : {}),
		...(entry.phaseTitle ? { phaseTitle: entry.phaseTitle } : {}),
		...(entry.parallelGroupId ? { parallelGroupId: entry.parallelGroupId } : {}),
		...(entry.pipelineId !== undefined &&
		entry.pipelineItemIndex !== undefined &&
		entry.pipelineStageIndex !== undefined
			? {
					pipeline: {
						id: entry.pipelineId,
						itemIndex: entry.pipelineItemIndex,
						stageIndex: entry.pipelineStageIndex,
						...(entry.pipelineItemLabel ? { itemLabel: entry.pipelineItemLabel } : {}),
					},
				}
			: {}),
	};
}

// Per-tick incremental refresh: a terminal run's status.json is immutable
// (finalize writes the last state, then the writer is disposed and the file's
// mtime stops changing), so its derived summary can be cached by runRecordDir
// and reused across reloads without re-reading + re-deriving it every 1Hz tick.
//
// HARD CORRECTNESS GUARD: only TERMINAL summaries are cached. An ACTIVE run's
// displayState is time-relative (deriveRunDisplayState compares Date.now()
// against the cached runnerHeartbeatAt), so it MUST be rebuilt every tick or a
// wedged runner whose status.json stopped updating would be frozen as "working"
// and never cross the 30s hard-dead / 15s stale lost threshold. A wedged run
// keeps status.state==="running" (displayState==="lost" is derived, not
// persisted), so it is never in this set and keeps being re-derived until the
// 10-min reconcile ceiling flips its persisted state.
const CACHEABLE_TERMINAL_STATES: ReadonlySet<AsyncRunSummary["state"]> = new Set([
	"complete",
	"failed",
	"interrupted",
	"skipped",
	"lost",
	// paused is terminal-ish: it sits in the recent/terminal bucket and its
	// status.json is not written while paused (immutable mtime). A resume
	// rewrites status.json, changing mtime+size, which invalidates this entry.
	"paused",
]);
const leafSummaryCache = new Map<string, { mtime: number; size: number; summary: AsyncRunSummary }>();
const LEAF_SUMMARY_CACHE_CAP = 1000;

// Visible to tests so a fresh fixture starts from an empty cache.
export function clearLeafSummaryCacheForTests(): void {
	leafSummaryCache.clear();
}

// Shared by both dashboard leaf builders (readRunViewForEntry here and
// runViewFromRegistryEntry in subagents-status.ts). Returns the pure
// statusToRunView projection (callers spread their own lineage / workflow tags
// on top); null when there is no readable status.json. Terminal results are
// cached by status.json mtime+size; active results are always rebuilt.
export function readLeafRunViewCached(asyncDir: string): AsyncRunSummary | null {
	const statusPath = path.join(asyncDir, "status.json");
	let stat: fs.Stats | undefined;
	try {
		stat = fs.statSync(statusPath);
	} catch {
		// Missing/unreadable status.json: drop any stale cache entry and let the
		// caller fall back to group synthesis / orphan handling (matches the prior
		// readStatus===null behavior). An active run whose file vanished is NOT
		// served from cache here, which is what keeps a wedged run from freezing.
		leafSummaryCache.delete(statusPath);
		return null;
	}
	const cached = leafSummaryCache.get(statusPath);
	if (cached && cached.mtime === stat.mtimeMs && cached.size === stat.size) return cached.summary;
	const status = readStatus(asyncDir) as (PersistedRunStatus & { cwd?: string }) | null;
	if (!status) {
		leafSummaryCache.delete(statusPath);
		return null;
	}
	const summary = statusToRunView(asyncDir, status);
	if (CACHEABLE_TERMINAL_STATES.has(summary.state)) {
		leafSummaryCache.set(statusPath, { mtime: stat.mtimeMs, size: stat.size, summary });
		if (leafSummaryCache.size > LEAF_SUMMARY_CACHE_CAP) {
			const firstKey = leafSummaryCache.keys().next().value;
			if (firstKey) leafSummaryCache.delete(firstKey);
		}
	} else {
		// Never let a prior terminal cache entry shadow a now-active rebuild, and
		// never insert an active (time-relative) summary.
		leafSummaryCache.delete(statusPath);
	}
	return summary;
}

// Shared group-synthesis seam for both dashboard builders (readRunViewForEntry
// here and runViewFromRegistryEntry in subagents-status.ts). Given the group
// entry and its already-decorated child summaries, computes the group state
// (with the workflow running-override gated on a computed "complete"), the
// max-child endedAt, and the synthesized group object. The `extras` knob adds
// the overlay-only fields B carries (currentStep:0 always, lastUpdate alongside
// endedAt); A omits them. A mutant inside this body must shift BOTH builders.
export function buildGroupSummary(
	entry: RunsRegistryEntry,
	childSummaries: AsyncRunSummary[],
	options: { extras?: boolean } = {},
): AsyncRunSummary {
	let state = computeGroupStatus(childSummaries.map((child) => child.state as Layer0ChildStatus));
	// A statusless async workflow group with no children yet (or all children
	// complete) computes "complete" even while the orchestrator is still running
	// before/between agent() calls. The running marker corrects ONLY that gap;
	// it must never mask a child-synthesized "failed" (e.g. failWorkflow's
	// synthetic failed child), so gate the override on a computed "complete".
	if (entry.kind === "workflow" && state === "complete") {
		const lifecycle = readWorkflowGroupState(entry.runRecordDir);
		if (lifecycle === "running") state = "running";
	}
	const childEndedAt = childSummaries
		.map((child) => child.endedAt)
		.filter((endedAt): endedAt is number => typeof endedAt === "number");
	const endedAt = state === "running" || childEndedAt.length === 0 ? undefined : Math.max(...childEndedAt);
	const sessionLineage = {
		...(entry.parentSessionId ? { parentSessionId: entry.parentSessionId } : {}),
		...(entry.rootSessionId ? { rootSessionId: entry.rootSessionId } : {}),
	};
	return {
		id: entry.runId,
		asyncDir: entry.runRecordDir,
		mode: entry.mode,
		state,
		startedAt: entry.startedAt,
		...(options.extras ? { currentStep: 0 } : {}),
		...(endedAt !== undefined ? (options.extras ? { endedAt, lastUpdate: endedAt } : { endedAt }) : {}),
		cwd: entry.cwd,
		...(entry.label ? { label: entry.label } : {}),
		...(entry.parentRunId ? { parentRunId: entry.parentRunId } : {}),
		...sessionLineage,
		...registryWorkflowFields(entry),
		steps: [],
	};
}

export function readRunViewForEntry(
	entry: RunsRegistryEntry,
	entries: RunsRegistryEntry[] = readAllEntries(),
	ownedViews?: Map<string, AsyncRunSummary>,
): AsyncRunSummary | null {
	// Owned in-process runs resolve their leaf from the registry memory mirror;
	// everything else hydrates from status.json (the post-reload / foreign source).
	const leaf = ownedViews?.get(entry.runId) ?? readLeafRunViewCached(entry.runRecordDir);
	const sessionLineage = {
		...(entry.parentSessionId ? { parentSessionId: entry.parentSessionId } : {}),
		...(entry.rootSessionId ? { rootSessionId: entry.rootSessionId } : {}),
	};
	if (leaf) return { ...leaf, ...sessionLineage, ...registryWorkflowFields(entry) };
	const children = entries.filter((candidate) => candidate.parentRunId === entry.runId);
	const isGroup = entry.mode === "parallel" && ((!entry.agentName && !entry.agentNames) || children.length > 0);
	if (isGroup) {
		const childSummaries = children
			.map((child) => {
				const summary = readRunViewForEntry(child, entries, ownedViews);
				return summary ? { ...summary, ...registryWorkflowFields(child) } : null;
			})
			.filter((child): child is AsyncRunSummary => Boolean(child));
		return buildGroupSummary(entry, childSummaries);
	}
	// No status.json on disk. Either (a) the run was dispatched within the last
	// few seconds and the writer hasn't flushed yet — keep the stub so the
	// overlay reflects the spawn immediately — or (b) the entry is an orphan
	// whose runRecordDir is gone. Drop orphans so the registry's append-only
	// history doesn't masquerade as live work.
	if (!isQueuedStubRecent(entry)) return null;
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
		...sessionLineage,
		...registryWorkflowFields(entry),
		steps: agents.map((agent, index) => ({ index, agent, status: "queued" as const })),
	};
}

function formatActivityFacts(input: {
	activityState?: ActivityState;
	lastActivityAt?: number;
	currentTool?: string;
	currentToolStartedAt?: number;
}): string | undefined {
	if (input.currentTool && input.currentToolStartedAt !== undefined)
		return `tool ${input.currentTool} ${formatDuration(Math.max(0, Date.now() - input.currentToolStartedAt))}`;
	if (input.lastActivityAt === undefined)
		return input.activityState === "needs_attention" ? "needs attention" : undefined;
	const elapsed = formatDuration(Math.max(0, Date.now() - input.lastActivityAt));
	return input.activityState === "needs_attention" ? `no activity for ${elapsed}` : `active ${elapsed} ago`;
}

function formatStepLine(step: AsyncRunStepSummary): string {
	const parts = [
		`${step.index + 1}. ${step.agent}`,
		step.displayState ? `${step.status}/${step.displayState}` : step.status,
	];
	const activity = formatActivityFacts(step);
	if (activity) parts.push(activity);
	if (step.model) parts.push(step.model);
	if (step.durationMs !== undefined) parts.push(formatDuration(step.durationMs));
	if (step.tokens) parts.push(`${formatTokens(step.tokens.total)} tok`);
	return parts.join(" | ");
}

function isTerminalState(state: string): boolean {
	return (
		state === "complete" ||
		state === "failed" ||
		state === "interrupted" ||
		state === "skipped" ||
		state === "paused"
	);
}

function formatRunHeader(run: AsyncRunSummary, children: AsyncRunSummary[] = []): string {
	const isParallelGroup = run.mode === "parallel" && children.length > 0;
	const modeLabel = run.workflow ? "workflow" : run.mode;
	const stepCount = isParallelGroup ? children.length : run.steps.length || 1;
	const completedParallelSteps = isParallelGroup
		? children.filter((child) => isTerminalState(child.state)).length
		: run.steps.filter(
				(step) => step.status === "complete" || step.status === "failed" || step.status === "skipped",
			).length;
	const stepLabel =
		run.mode === "parallel"
			? `tasks ${completedParallelSteps}/${stepCount} complete`
			: run.currentStep !== undefined
				? `step ${run.currentStep + 1}/${stepCount}`
				: `steps ${stepCount}`;
	const cwd = run.cwd ? shortenPath(run.cwd) : shortenPath(run.asyncDir ?? "");
	const activity = formatActivityFacts(run);
	const state = run.displayState ? `${run.state}/${run.displayState}` : run.state;
	return `${run.id} | ${state}${activity ? ` | ${activity}` : ""} | ${modeLabel} | ${stepLabel} | ${cwd}`;
}

function isGroupRun(run: AsyncRunSummary, children: AsyncRunSummary[]): boolean {
	return run.mode === "parallel" && (run.steps.length === 0 || children.length > 0);
}

function formatChildRunLine(run: AsyncRunSummary): string {
	const step = run.steps[0];
	const agent = step?.agent || "unknown";
	const parts = [run.id, agent, run.label, run.displayState ? `${run.state}/${run.displayState}` : run.state];
	const activity = formatActivityFacts({
		activityState: run.activityState,
		lastActivityAt: run.lastActivityAt,
		currentTool: run.currentTool,
		currentToolStartedAt: run.currentToolStartedAt,
	});
	if (activity) parts.push(activity);
	if (step?.model) parts.push(step.model);
	const durationMs = step?.durationMs ?? (run.endedAt !== undefined ? run.endedAt - run.startedAt : undefined);
	if (durationMs !== undefined) parts.push(formatDuration(durationMs));
	const tokens = step?.tokens ?? run.totalTokens;
	if (tokens) parts.push(`${formatTokens(tokens.total)} tok`);
	return parts.filter((part): part is string => Boolean(part)).join(" | ");
}

export function workflowPhaseLabel(run: Pick<AsyncRunSummary, "phaseIndex" | "phaseTitle">): string {
	if (run.phaseIndex === undefined) return "";
	const label = `Phase ${run.phaseIndex}`;
	const title = dedupePhaseTitle(run.phaseTitle);
	return title ? `${label}: ${title}` : label;
}

// Scripts often name phases "Phase 1: recon"; phase labels already render the
// index, so strip a leading "Phase N" from the title to avoid "Phase 1: Phase 1: recon".
export function dedupePhaseTitle(title: string | undefined): string | undefined {
	if (!title) return title;
	const stripped = title.replace(/^phase\s*\d+\s*[:·-]?\s*/i, "");
	return stripped.length > 0 ? stripped : title;
}

export function sortedWorkflowChildren(children: AsyncRunSummary[]): AsyncRunSummary[] {
	return children
		.map((child, index) => ({ child, index }))
		.sort((a, b) => {
			const phaseA = a.child.phaseIndex ?? Number.MAX_SAFE_INTEGER;
			const phaseB = b.child.phaseIndex ?? Number.MAX_SAFE_INTEGER;
			if (phaseA !== phaseB) return phaseA - phaseB;
			const groupA = a.child.parallelGroupId ?? "";
			const groupB = b.child.parallelGroupId ?? "";
			const byGroup = groupA.localeCompare(groupB);
			return byGroup || a.index - b.index;
		})
		.map(({ child }) => child);
}

function appendWorkflowChildLines(lines: string[], children: AsyncRunSummary[]): void {
	let lastPhaseKey: number | undefined;
	for (const child of sortedWorkflowChildren(children)) {
		if (child.phaseIndex !== lastPhaseKey) {
			lastPhaseKey = child.phaseIndex;
			if (!(child.phaseIndex === 0 && !child.phaseTitle)) {
				const label = workflowPhaseLabel(child);
				if (label) lines.push(`  ${label}`);
			}
		}
		const prefix = child.parallelGroupId ? `[${child.parallelGroupId}] ` : "";
		lines.push(`  - ${prefix}${formatChildRunLine(child)}`);
	}
}

export function formatAsyncRunList(runs: AsyncRunSummary[], heading = "Subagent runs"): string {
	if (runs.length === 0) return `No ${heading.toLowerCase()}.`;

	const lines = [`${heading}: ${runs.length}`, ASYNC_NO_POLL_GUIDANCE, ""];
	const runIds = new Set(runs.map((run) => run.id));
	const childrenByParent = new Map<string, AsyncRunSummary[]>();
	for (const run of runs) {
		if (!run.parentRunId || !runIds.has(run.parentRunId)) continue;
		const siblings = childrenByParent.get(run.parentRunId) ?? [];
		siblings.push(run);
		childrenByParent.set(run.parentRunId, siblings);
	}
	const childIds = new Set<string>();
	for (const [parentId, children] of childrenByParent.entries()) {
		const parent = runs.find((run) => run.id === parentId);
		const ordered = parent?.workflow
			? sortedWorkflowChildren(children)
			: [...children].sort((a, b) => b.startedAt - a.startedAt);
		children.splice(0, children.length, ...ordered);
		for (const child of children) childIds.add(child.id);
	}
	for (const run of runs) {
		if (childIds.has(run.id)) continue;
		const children = childrenByParent.get(run.id) ?? [];
		lines.push(`- ${formatRunHeader(run, children)}`);
		if (isGroupRun(run, children)) {
			if (run.workflow) appendWorkflowChildLines(lines, children);
			else for (const child of children) lines.push(`  - ${formatChildRunLine(child)}`);
		} else {
			for (const step of run.steps) {
				lines.push(`  ${formatStepLine(step)}`);
			}
		}
		if (run.sessionFile) lines.push(`  session: ${shortenPath(run.sessionFile)}`);
		lines.push("");
	}
	return lines.join("\n").trimEnd();
}
