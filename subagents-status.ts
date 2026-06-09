import * as path from "node:path";
import { colorForAgentName } from "./agents.ts";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { type AsyncRunOverlayData, type AsyncRunSummary, buildGroupSummary, listRunsFromRegistryForOverlay, readLeafSummaryCached, sortRuns, sortedWorkflowChildren, workflowPhaseLabel } from "./async-status.ts";
import { readWorkflowScript } from "./workflow-group-state.ts";
import { previewArgs, readRunTranscript } from "./run-transcript.ts";
import { formatDuration, formatTokens } from "./formatters.ts";
import { findInlineChildRun, multiSpinnerFrame, renderNestedChild, tintAgentName } from "./render.ts";
import { compareRunsForDisplay, deriveRunDisplayState } from "./run-liveness.ts";
import { formatPhase, type RunPhase } from "./run-phase.ts";
import { flatRule, formatScrollInfo, padRight, titledBottomSegment, titledTopSegment } from "./render-helpers.ts";
import { describeAgentLabel, formatShapeBadge } from "./run-shape.ts";
import { type ActivityState, type RunDisplayState, type SubagentState } from "./types.ts";
import { listRunsByRootRunIds, readAllEntries, readShardEntries, type RunsRegistryEntry } from "./runs-registry.ts";

const AUTO_REFRESH_MS = 1000;
// When no run is live (all rows terminal/lost/idle), nothing needs a per-second
// label tick and the derived set rarely changes, so the self-scheduling refresh
// loop backs off to this slower cadence; it restores AUTO_REFRESH_MS the moment
// a live run appears or the structural signature changes.
const IDLE_REFRESH_MS = 5000;
// Hard caps on the split fraction. The pane stretches up to 70% so long agent
// labels + cwd badges fit on wide terminals; 18% keeps the right pane usable.
const LEFT_PANE_CAP = 110;
const MIN_LEFT_PANE = 28;
const MIN_RIGHT_PANE = 24;
const DEFAULT_LEFT_FRACTION = 0.4;
const SPLIT_STEP_COLS = 4;
const MIN_VIEWPORT_HEIGHT = 12;
// Shared legend lives in the left pane's bottom section, charter-picker style.
// Only put keys that work regardless of focus here; pane-specific extras go
// into the bottom-border hint of each side.
const LEGEND_KEY_W = 11;
const LEGEND_ENTRIES: ReadonlyArray<readonly [string, string]> = [
	["tab",       "switch pane"],
	["j/k",       "move/scroll"],
	["g / G",     "top / bottom"],
	["PgUp/PgDn", "page list / scroll"],
	["u / d",     "half-page up / down"],
	["[ / ]",     "resize split"],
	["a",         "all sessions"],
	["enter",     "open session"],
	["q / esc",   "close"],
];
// Only the two titled chrome rows (top border + bottom border) consume vertical
// space inside the overlay region. We fill the rest with body rows so the
// dashboard reads as a true fullscreen page instead of a short floating card.
const CHROME_ROWS = 2;
// Body height adapts to current terminal rows so the dashboard uses the whole
// pane instead of a hardcoded 24 lines.
function computeBodyHeight(tui?: TUI): number {
	const rows = tui?.terminal?.rows ?? process.stdout.rows ?? 32;
	return Math.max(MIN_VIEWPORT_HEIGHT, rows - CHROME_ROWS);
}

type ForegroundControl = SubagentState["foregroundControls"] extends Map<string, infer T> ? T : never;

export interface ForegroundRunSummary {
	id: string;
	asyncDir?: string;
	// charter nested-subagent-display: live sync hierarchy parent link.
	parentRunId?: string;
	state: "running";
	activityState?: ActivityState;
	displayState?: RunDisplayState;
	lastActivityAt?: number;
	currentTool?: string;
	currentToolStartedAt?: number;
	resumedAt?: number;
	resumeCount?: number;
	phase?: RunPhase;
	phaseStartedAt?: number;
	mode: "single" | "parallel" | "chain";
	cwd?: string;
	startedAt: number;
	lastUpdate?: number;
	/** Run-level caller-provided label; populated for single runs and uniform-label parallel runs. */
	label?: string;
	/** Per-step caller-provided labels aligned by index. */
	agentLabels?: string[];
	currentAgent?: string;
	/** Theme color token for tinting the current agent name in the left pane. */
	currentAgentColor?: string;
	currentIndex?: number;
	recentTools?: Array<{ tool: string; args?: string; endMs?: number }>;
	recentOutput?: string[];
	finalOutput?: string;
}

export type LiveRun =
	| { source: "sync"; run: ForegroundRunSummary }
	| { source: "async"; run: AsyncRunSummary };

interface StatusOverlayDeps {
	listRunsForOverlay?: (recentLimit?: number) => AsyncRunOverlayData;
	listForegroundRuns?: () => ForegroundRunSummary[];
	refreshMs?: number;
	leftPaneCap?: number;
	sessionCwd?: string;
	// Current user session id. When set, the overlay scopes strictly to this
	// session's tree (matches rootSessionId/parentSessionId on registry entries).
	// Falls back to cwd scoping when absent.
	sessionId?: string;
	// Branch-aware membership: returns the set of top-level run ids anchored on
	// the CURRENT message-tree branch (via session getBranch()). Re-read each
	// reload so a /tree revert immediately hides abandoned-branch runs. When
	// absent, the overlay falls back to plain session-tree scoping.
	getBranchAnchorRunIds?: () => Set<string>;
}

function entryMatchesOverlayScope(entry: RunsRegistryEntry, scope: { sessionCwd?: string; sessionId?: string }): boolean {
	if (scope.sessionId) {
		const tag = entry.rootSessionId ?? entry.parentSessionId;
		return !tag || tag === scope.sessionId;
	}
	if (scope.sessionCwd) return !entry.cwd || entry.cwd === scope.sessionCwd;
	return true;
}

function registryWorkflowFields(entry: RunsRegistryEntry): Pick<AsyncRunSummary, "workflow" | "phaseIndex" | "phaseTitle" | "parallelGroupId"> {
	return {
		...(entry.kind === "workflow" ? { workflow: true } : {}),
		...(entry.phaseIndex !== undefined ? { phaseIndex: entry.phaseIndex } : {}),
		...(entry.phaseTitle ? { phaseTitle: entry.phaseTitle } : {}),
		...(entry.parallelGroupId ? { parallelGroupId: entry.parallelGroupId } : {}),
	};
}

export function summaryFromRegistryEntry(entry: RunsRegistryEntry, registryEntries?: RunsRegistryEntry[]): AsyncRunSummary {
	// Shared terminal-summary cache with readSummaryForEntry: terminal leaves are
	// reused by status.json mtime+size; active leaves are always rebuilt so the
	// lost-transition keeps firing. See readLeafSummaryCached.
	const summary = readLeafSummaryCached(entry.runRecordDir);
	const lineage = {
		...(entry.parentSessionId ? { parentSessionId: entry.parentSessionId } : {}),
		...(entry.rootSessionId ? { rootSessionId: entry.rootSessionId } : {}),
	};
	if (summary) {
		return {
			...summary,
			...(entry.parentRunId && !summary.parentRunId ? { parentRunId: entry.parentRunId } : {}),
			...lineage,
			...registryWorkflowFields(entry),
		};
	}
	if (!entry.agentName && !entry.agentNames) {
		const entries = registryEntries ?? readAllEntries();
		const children = entries.filter((candidate) => candidate.parentRunId === entry.runId);
		const childSummaries = children.map((child) => ({ ...summaryFromRegistryEntry(child, entries), ...registryWorkflowFields(child) }));
		// Shared group-synthesis seam (state + workflow override + endedAt + group
		// object). The overlay carries currentStep:0 + lastUpdate, so pass extras.
		return buildGroupSummary(entry, childSummaries, { extras: true });
	}
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
		...lineage,
		...registryWorkflowFields(entry),
		steps: agents.map((agent, index) => ({ index, agent, status: "queued" as const })),
	};
}

export function expandOverlayByRootRunId(seed: AsyncRunOverlayData, scope: { sessionCwd?: string; sessionId?: string }): AsyncRunOverlayData {
	const seedIds = new Set([...seed.active, ...seed.recent].map((run) => run.id));
	if (seedIds.size === 0) return seed;

	const registryEntries = scope.sessionId ? readShardEntries(scope.sessionId) : readAllEntries();
	const rootRunIds = new Set<string>();
	for (const entry of registryEntries) {
		if (!seedIds.has(entry.runId) || !entryMatchesOverlayScope(entry, scope)) continue;
		rootRunIds.add(entry.rootRunId ?? entry.runId);
	}
	if (rootRunIds.size === 0) return seed;

	const byId = new Map<string, AsyncRunSummary>();
	for (const run of [...seed.active, ...seed.recent]) byId.set(run.id, run);
	const entries = scope.sessionId
		? registryEntries.filter((entry) => rootRunIds.has(entry.rootRunId ?? entry.runId))
		: listRunsByRootRunIds(rootRunIds);
	for (const entry of entries) {
		// The scoped seed has already proven this root run belongs to the current
		// session. Include the whole run tree by rootRunId so descendants with
		// stale/missing session tags are still rendered under their visible parent.
		byId.set(entry.runId, summaryFromRegistryEntry(entry, entries));
	}

	const all = [...byId.values()];
	return {
		active: all.filter((run) => run.state === "queued" || run.state === "running" || run.state === "lost"),
		recent: all.filter((run) => run.state === "complete" || run.state === "failed" || run.state === "paused" || run.state === "interrupted" || run.state === "skipped"),
	};
}

// Decides whether a run row directly belongs to the current session. Sync runs
// always belong to the current session (they share the in-process cwd). Async
// rows are direct matches only when their own session/cwd metadata matches; the
// overlay separately keeps descendants of matching rows so nested runs with
// stale lineage still render under their visible parent.
export function runMatchesSession(
	run: LiveRun,
	scope: { sessionId?: string; sessionCwd?: string } | string | undefined,
): boolean {
	// Back-compat: previously the second arg was just sessionCwd as a string.
	const { sessionId, sessionCwd } = typeof scope === "string"
		? { sessionId: undefined, sessionCwd: scope }
		: scope ?? {};
	if (!sessionId && !sessionCwd) return true;
	if (run.source === "sync") return true;
	if (sessionId) {
		const tag = run.run.rootSessionId ?? run.run.parentSessionId;
		if (!tag) return false;
		return tag === sessionId;
	}
	const runCwd = run.run.cwd;
	if (!runCwd) return false;
	return runCwd === sessionCwd;
}

function filterRunsToSessionTree(
	runs: LiveRun[],
	scope: { sessionId?: string; sessionCwd?: string },
	anchorRunIds?: Set<string>,
): LiveRun[] {
	if (!scope.sessionId && !scope.sessionCwd) return runs;
	const present = new Set(runs.map((run) => run.run.id));
	const byParent = new Map<string, LiveRun[]>();
	for (const run of runs) {
		const parentRunId = parentRunIdOf(run);
		if (!parentRunId) continue;
		const siblings = byParent.get(parentRunId) ?? [];
		siblings.push(run);
		byParent.set(parentRunId, siblings);
	}

	// A forest-root is a top-level row in the overlay tree: no parentRunId, or a
	// parent that is not itself present in the filtered set. Branch-aware
	// membership is decided ONLY at forest-roots; descendants of an included
	// root always flow in (a nested child is never independently anchored).
	const isForestRoot = (run: LiveRun): boolean => {
		const parentRunId = parentRunIdOf(run);
		return !parentRunId || !present.has(parentRunId);
	};

	const included = new Set<string>();
	const includeWithDescendants = (run: LiveRun): void => {
		if (included.has(run.run.id)) return;
		included.add(run.run.id);
		for (const child of byParent.get(run.run.id) ?? []) includeWithDescendants(child);
	};
	for (const run of runs) {
		if (!isForestRoot(run)) continue;
		if (!runMatchesSession(run, scope)) continue;
		// Tree-aware membership: when an anchor set is supplied, a top-level run is
		// a member only if its branch anchor is on the CURRENT message-tree branch
		// (a /tree revert drops abandoned-branch anchors). When no anchor set is
		// supplied (tests, or before anchors exist), fall back to session match.
		if (anchorRunIds && !anchorRunIds.has(run.run.id)) continue;
		includeWithDescendants(run);
	}
	return runs.filter((run) => included.has(run.run.id));
}

export function foregroundRunsFromState(state: Pick<SubagentState, "foregroundControls"> & { baseCwd?: string }): ForegroundRunSummary[] {
	return Array.from(state.foregroundControls.values())
		.map((control: ForegroundControl) => {
			const displayState = deriveRunDisplayState({
				state: "running",
				activityState: control.currentActivityState,
				currentTool: control.currentTool,
				phase: control.phase,
				phaseStartedAt: control.phaseStartedAt,
				lastActivityAt: control.lastActivityAt,
				lastUpdate: control.updatedAt,
			});
		return {
				id: control.runId,
			...(control.asyncDir ? { asyncDir: control.asyncDir } : {}),
				...(control.parentRunId ? { parentRunId: control.parentRunId } : {}),
				state: "running" as const,
				...(control.currentActivityState ? { activityState: control.currentActivityState } : {}),
				...(displayState ? { displayState } : {}),
			...(control.lastActivityAt !== undefined ? { lastActivityAt: control.lastActivityAt } : {}),
			...(control.currentTool ? { currentTool: control.currentTool } : {}),
			...(control.currentToolStartedAt !== undefined ? { currentToolStartedAt: control.currentToolStartedAt } : {}),
			...(control.phase !== undefined ? { phase: control.phase } : {}),
			...(control.phaseStartedAt !== undefined ? { phaseStartedAt: control.phaseStartedAt } : {}),
			mode: control.mode,
			...(state.baseCwd ? { cwd: state.baseCwd } : {}),
			startedAt: control.startedAt,
			lastUpdate: control.updatedAt,
			...(control.label ? { label: control.label } : {}),
			...(control.agentLabels ? { agentLabels: control.agentLabels } : {}),
			...(control.currentAgent ? { currentAgent: control.currentAgent } : {}),
			...(control.currentAgentColor ? { currentAgentColor: control.currentAgentColor } : {}),
			...(control.currentIndex !== undefined ? { currentIndex: control.currentIndex } : {}),
			...(control.recentTools ? { recentTools: control.recentTools } : {}),
			...(control.recentOutput ? { recentOutput: control.recentOutput } : {}),
				...(control.finalOutput ? { finalOutput: control.finalOutput } : {}),
			};
		})
		.sort((a, b) => b.startedAt - a.startedAt);
}

function runKey(run: LiveRun): string {
	return `${run.source}:${run.run.id}`;
}

// Returns the agent name(s) as a pre-styled string when colors apply, otherwise plain text.
// Parallel runs with heterogeneous agents get per-piece tinting so each name uses its own color.
function runAgentLabel(run: LiveRun, theme: Theme): string {
	if (run.source === "sync") {
		const name = run.run.currentAgent ?? run.run.mode;
		return tintAgentName(name, run.run.currentAgentColor ?? colorForAgentName(name));
	}
	if (run.run.workflow) return tintAgentName("workflow", colorForAgentName("workflow"));
	const steps = run.run.mode === "parallel"
		? run.run.steps.filter((s) => s.agent)
		: run.run.steps;
	const running = run.run.steps.find((step) => step.status === "running");
	const fallbackStep = running ?? run.run.steps[0];
	// Per-step disk-persisted color falls back to the live name -> color map so completed
	// async rows (and any run whose status.json never recorded a step.live.color) still tint.
	const desc = describeAgentLabel({
		mode: run.run.mode,
		agents: steps.map((s) => s.agent),
		agentColors: steps.map((s) => s.color ?? colorForAgentName(s.agent)),
		fallbackName: fallbackStep?.agent ?? run.run.mode,
		fallbackColor: fallbackStep?.color ?? colorForAgentName(fallbackStep?.agent ?? run.run.mode),
	});
	if (desc.kind === "uniformParallel") return tintAgentName(`parallel(${desc.total})`, desc.color);
	if (desc.kind === "mixedParallel") {
		return desc.agents.map((a) => tintAgentName(a.name, a.color)).join(theme.fg("dim", "+"));
	}
	return tintAgentName(desc.name, desc.color);
}

// Multi-step shape badge. 'chain 3/8' for sequential, 'parallel 3/5' for concurrent.
// Empty for single-step runs to keep the left-pane line compact.
function workflowPhaseChip(run: LiveRun): string {
	if (run.source !== "async" || run.run.phaseIndex === undefined) return "";
	const label = `P${run.run.phaseIndex}`;
	return run.run.phaseTitle ? `${label} ${run.run.phaseTitle}` : label;
}

function runShapeBadge(run: LiveRun): string {
	if (run.source === "sync") return "";
	const total = run.run.steps.length;
	// Parallel progress uses done-count; chain progress uses 1-based current step.
	const current = run.run.mode === "parallel"
		? run.run.steps.filter((s) => s.status === "complete" || s.status === "failed" || s.status === "skipped").length
		: (run.run.currentStep ?? 0) + 1;
	return formatShapeBadge({ mode: run.run.mode, total, current });
}

// A run shows a live, ticking elapsed/spinner label iff it is NOT terminal and
// NOT lost — mirrors the freeze logic in runElapsed/runIdentityAge. Terminal
// and lost rows freeze their labels at data-landing time, so they need no
// per-tick repaint. Used to decide whether a coarse clock tick must still fire
// a render (live labels) and whether the refresh interval may back off (no live
// runs => idle).
function runHasLiveLabel(run: LiveRun): boolean {
	if (run.source !== "async") return run.run.state === "running" || run.run.state === "queued";
	const s = run.run.state;
	if (s === "complete" || s === "failed" || s === "interrupted" || s === "skipped" || s === "lost" || s === "paused") return false;
	if (run.run.displayState === "lost") return false;
	return true;
}

// Cheap structural signature of the derived run set that EXCLUDES time-relative
// fields (elapsed/age labels), so an idle tick where only the wall clock moved
// produces an identical signature and is suppressed. Includes everything that
// changes the painted rows: identity, order, state, derived liveness, current
// tool, phase, and step progress. The render-on-diff gate fires a repaint when
// this changes; the coarse-tick path separately keeps live labels advancing.
function overlayRunsSignature(runs: LiveRun[], selectedId: string | undefined, errorMessage: string | undefined): string {
	const parts: string[] = [`sel:${selectedId ?? ""}`, `err:${errorMessage ? 1 : 0}`];
	for (const run of runs) {
		if (run.source === "async") {
			const r = run.run;
			parts.push(`async:${r.id}:${r.state}:${r.displayState ?? ""}:${r.currentTool ?? ""}:${r.phase ?? ""}:${r.currentStep ?? ""}:${r.steps?.length ?? 0}`);
		} else {
			const r = run.run;
			parts.push(`sync:${r.id}:${r.state}:${r.currentTool ?? ""}:${r.currentIndex ?? ""}`);
		}
	}
	return parts.join("|");
}

function runElapsed(run: LiveRun, now: number): string {
	const legStartedAt = run.run.resumedAt ?? run.run.startedAt;
	// Terminal runs (lost/complete/failed) must not keep ticking. lost runs have no
	// endedAt because the child crashed without writing one, so fall back to lastUpdate.
	if (run.source === "async") {
		if (run.run.endedAt) return formatDuration(Math.max(0, run.run.endedAt - legStartedAt));
		// A force-killed run keeps state==='running' on disk but goes displayState==='lost'
		// once its runner heartbeat is stale — freeze the timer on that too, not just on a
		// terminal state, otherwise a dead run keeps ticking.
		if (run.run.state === "lost" || run.run.state === "complete" || run.run.state === "failed" || run.run.state === "interrupted" || run.run.state === "skipped" || run.run.state === "paused" || run.run.displayState === "lost") {
			const frozen = run.run.lastUpdate ?? run.run.startedAt;
			return formatDuration(Math.max(0, frozen - legStartedAt));
		}
	}
	return formatDuration(Math.max(0, now - legStartedAt));
}

function runIdentityAge(run: LiveRun, now: number): string | undefined {
	if ((run.run.resumeCount ?? 0) <= 0) return undefined;
	// Identity age = wall time since the run first started. For a terminal run it
	// must freeze at the end (endedAt, or lastUpdate for a lost run that crashed
	// without one) instead of ticking against `now` forever.
	const isLost = run.run.state === "lost" || run.run.displayState === "lost";
	const frozenEnd = run.source === "async"
		? run.run.endedAt ?? (run.run.state === "complete" || run.run.state === "failed" || run.run.state === "interrupted" || run.run.state === "skipped" || run.run.state === "paused" || isLost ? run.run.lastUpdate : undefined)
		: undefined;
	const end = frozenEnd ?? now;
	return formatDuration(Math.max(0, end - run.run.startedAt));
}

function stateBucket(state: AsyncRunSummary["state"]): number {
	switch (state) {
		case "running": return 0;
		case "queued": return 1;
		case "paused": return 2;
		case "failed": return 3;
		case "complete": return 4;
		default: return 5;
	}
}

function baseSortLiveRuns(runs: LiveRun[]): LiveRun[] {
	return [...runs].sort((a, b) => compareRunsForDisplay({ ...a.run, updatedAt: a.run.lastUpdate }, { ...b.run, updatedAt: b.run.lastUpdate }));
}

function parentRunIdOf(run: LiveRun): string | undefined {
	return run.run.parentRunId;
}

function orderRunsWithChildren(sorted: LiveRun[]): LiveRun[] {
	// charter nested-subagent-display: parent rows immediately precede visible children.
	const byParent = new Map<string, LiveRun[]>();
	const ids = new Set(sorted.map((run) => run.run.id));
	const roots: LiveRun[] = [];
	for (const run of sorted) {
		const parentRunId = parentRunIdOf(run);
		if (parentRunId && ids.has(parentRunId)) {
			const children = byParent.get(parentRunId) ?? [];
			children.push(run);
			byParent.set(parentRunId, children);
		} else {
			roots.push(run);
		}
	}
	const childrenForDisplay = (parent: LiveRun, children: LiveRun[]): LiveRun[] => {
		if (parent.source !== "async" || !parent.run.workflow) return children;
		return children
			.map((child, index) => ({ child, index }))
			.sort((a, b) => {
				const phaseA = a.child.source === "async" ? a.child.run.phaseIndex ?? 0 : 0;
				const phaseB = b.child.source === "async" ? b.child.run.phaseIndex ?? 0 : 0;
				if (phaseA !== phaseB) return phaseA - phaseB;
				const groupA = a.child.source === "async" ? a.child.run.parallelGroupId ?? "" : "";
				const groupB = b.child.source === "async" ? b.child.run.parallelGroupId ?? "" : "";
				if (groupA !== groupB) return groupA.localeCompare(groupB);
				return a.index - b.index;
			})
			.map(({ child }) => child);
	};
	const out: LiveRun[] = [];
	const visit = (run: LiveRun) => {
		out.push(run);
		for (const child of childrenForDisplay(run, byParent.get(run.run.id) ?? [])) visit(child);
	};
	for (const run of roots) visit(run);
	return out;
}

function buildDepthMap(runs: LiveRun[]): Map<string, number> {
	const ids = new Set(runs.map((run) => run.run.id));
	const byId = new Map(runs.map((run) => [run.run.id, run] as const));
	const depths = new Map<string, number>();
	const depthFor = (run: LiveRun, seen = new Set<string>()): number => {
		const cached = depths.get(run.run.id);
		if (cached !== undefined) return cached;
		const parent = parentRunIdOf(run);
		if (!parent || !ids.has(parent) || seen.has(parent)) {
			depths.set(run.run.id, 0);
			return 0;
		}
		seen.add(run.run.id);
		const parentRun = byId.get(parent);
		const depth = parentRun ? Math.min(4, depthFor(parentRun, seen) + 1) : 0;
		depths.set(run.run.id, depth);
		return depth;
	};
	for (const run of runs) depthFor(run);
	return depths;
}

function sortLiveRuns(sync: ForegroundRunSummary[], async: AsyncRunSummary[]): LiveRun[] {
	// Single ordering rule for the dashboard: needs_attention pinned to the very top,
	// then everything strictly by spawn time (newest first). State buckets are NOT
	// used here -- otherwise old failed runs would float above recently completed
	// runs just because 'failed' bucket ranks above 'complete'. The status glyph on
	// each row already communicates state, so bucketing only hurt the mental model.
	const all: LiveRun[] = [];
	for (const run of sync) all.push({ source: "sync", run });
	for (const run of async) all.push({ source: "async", run });
	return orderRunsWithChildren(baseSortLiveRuns(all));
}

function statusGlyph(theme: Theme, state: AsyncRunSummary["state"], activity: ActivityState | undefined, displayState?: RunDisplayState): string {
	if (displayState === "lost") return theme.fg("error", "!");
	if (displayState === "needs_attention" || activity === "needs_attention") return theme.fg("warning", "!");
	switch (state) {
		case "running": return theme.fg("accent", multiSpinnerFrame());
		case "queued": return theme.fg("dim", "○");
		case "paused": return theme.fg("warning", "⏸");
		case "complete": return theme.fg("success", "✓");
		case "failed": return theme.fg("error", "✗");
		case "interrupted": return theme.fg("warning", "■");
		case "skipped": return theme.fg("dim", "·");
		case "lost": return theme.fg("error", "!");
	}
	return theme.fg("dim", "·");
}

function wrapText(text: string, width: number): string[] {
	if (width <= 0) return [];
	const out: string[] = [];
	for (const paragraph of text.split("\n")) {
		if (!paragraph) {
			out.push("");
			continue;
		}
		let line = "";
		for (const word of paragraph.split(/\s+/)) {
			if (!word) continue;
			const candidate = line ? `${line} ${word}` : word;
			if (visibleWidth(candidate) <= width) {
				line = candidate;
				continue;
			}
			if (visibleWidth(word) > width) {
				if (line) out.push(line);
				let rest = word;
				while (visibleWidth(rest) > width) {
					out.push(truncateToWidth(rest, width));
					rest = rest.slice(width);
				}
				line = rest;
				continue;
			}
			out.push(line);
			line = word;
		}
		if (line) out.push(line);
	}
	return out;
}

// Compact cwd badge (rightmost path segment, capped) for any row. Suppressed
// entirely in scoped mode — every visible run shares the current session cwd,
// so repeating it on every row is just noise (`pi-subagents · pi-subagents ·
// pi-subagents …`). Shown only when `forceShow=true`, which the caller sets
// when in `all sessions` mode or when no session cwd is known.
function runCwdBadge(run: LiveRun, forceShow: boolean): string {
	if (!forceShow) return "";
	const cwd = run.run.cwd;
	if (!cwd) return "";
	const base = path.basename(cwd) || cwd;
	return base.length > 22 ? base.slice(0, 21) + "…" : base;
}

// Compact local-time date stamp for completed/lost runs. Today: `HH:MM`,
// yesterday-or-older: `MM-DD HH:MM`. Returns empty for runs that have no
// `endedAt` (running rows already show a live `Xs` elapsed counter).
function runEndedStamp(run: LiveRun): string {
	if (run.source !== "async") return "";
	// A lost run crashed without writing endedAt; its last heartbeat (lastUpdate) is
	// the best estimate of when it died, so stamp that like any other terminal row
	// instead of leaving the tail to fall back to a frozen elapsed duration.
	const isLost = run.run.state === "lost" || run.run.displayState === "lost";
	const ended = run.run.endedAt ?? (isLost ? run.run.lastUpdate : undefined);
	if (typeof ended !== "number" || !Number.isFinite(ended)) return "";
	const d = new Date(ended);
	const now = new Date();
	const sameDay = d.getFullYear() === now.getFullYear()
		&& d.getMonth() === now.getMonth()
		&& d.getDate() === now.getDate();
	const hh = String(d.getHours()).padStart(2, "0");
	const mm = String(d.getMinutes()).padStart(2, "0");
	if (sameDay) return `${hh}:${mm}`;
	const mo = String(d.getMonth() + 1).padStart(2, "0");
	const dd = String(d.getDate()).padStart(2, "0");
	return `${mo}-${dd} ${hh}:${mm}`;
}

export function buildLeftLine(theme: Theme, run: LiveRun, selected: boolean, now: number, width: number, depth = 0, showCwd = false): string {
	const cursor = selected ? theme.fg("accent", "> ") : "  ";
	// charter nested-subagent-display: indent between cursor and glyph keeps cursor aligned.
	const indent = depth > 0 ? theme.fg("dim", `${"  ".repeat(Math.max(0, depth - 1))}└─`) : "";
	// Agentless group rows have no step glyph of their own; keep the hollow group
	// marker while the adjacent status text carries the derived terminal state.
	const glyph = run.source === "async" && run.run.state === "complete" && run.run.steps.length === 0
		? theme.fg("dim", "○")
		: statusGlyph(theme, run.run.state, run.run.activityState, run.run.displayState);
	const agent = runAgentLabel(run, theme);
	// Terminal runs must not advertise a live phase chip (`streaming Xs`,
	// `tool: bash Xs`). Older status.json files written before the
	// status-writer finalize phase-clear may still carry stale phase fields;
	// suppress here so the seconds counter doesn't keep ticking after
	// `complete`/`failed`/`lost`.
	const isTerminal = run.run.state === "complete" || run.run.state === "failed" || run.run.state === "interrupted" || run.run.state === "skipped" || run.run.state === "lost" || run.run.displayState === "lost";
	const phase = workflowPhaseChip(run) || (isTerminal ? "" : formatPhase(run.run.phase, run.run.phaseStartedAt, now, run.run.currentTool));
	// A 'lost' displayState is authoritative over the stale on-disk state: show just
	// 'lost' rather than the confusing 'running/lost' a force-killed run would produce.
	// When an active phase chip is present (`finishing`, `writing`, `tool: bash`), it
	// already conveys what the runner is doing; the `working`/`quiet` displayState
	// discriminant then only adds noise and can contradict it (a run mid-`finishing`
	// whose heartbeat aged past the quiet threshold would read `finishing · running/quiet`).
	// Suppress the discriminant in that case; keep bare `state/displayState` when there's
	// no phase chip (there displayState is the only live-activity signal), and keep `lost`
	// authoritative always.
	const status = run.run.displayState === "lost"
		? "lost"
		: phase && run.run.displayState
			? run.run.state
			: run.run.displayState ? `${run.run.state}/${run.run.displayState}` : run.run.state;
	const elapsed = runElapsed(run, now);
	const identityAge = runIdentityAge(run, now);
	const dateStamp = runEndedStamp(run);
	const badge = runShapeBadge(run);
	const badgePart = badge ? ` · ${theme.fg("dim", badge)}` : "";
	const resumePart = (run.run.resumeCount ?? 0) > 0 ? ` · ${theme.fg("dim", `resumed ${run.run.resumeCount}×`)}` : "";
	// Don't pre-truncate the label here — the final `truncateToWidth(text, width)`
	// below clips the whole row once at the right edge. Pre-truncating produced
	// `tally-v4-showcase ... ...` style double-ellipsis noise.
	const labelPart = run.run.label
		? ` · ${theme.fg("muted", run.run.label)}`
		: "";
	const phasePart = phase ? ` · ${theme.fg("dim", phase)}` : "";
	const cwdBadge = runCwdBadge(run, showCwd);
	const cwdPart = cwdBadge ? ` · ${theme.fg("dim", cwdBadge)}` : "";
	// Elapsed for active runs (`5.2s`), date stamp for terminated runs (`HH:MM`
	// or `MM-DD HH:MM`). Both never apply to the same row.
	const identityPart = identityAge ? ` · ${theme.fg("dim", `age ${identityAge}`)}` : "";
	// Never-resumed rows stay byte-identical to the pre-resume layout: terminal =
	// date stamp only, active = leg elapsed. Resumed rows additionally surface the
	// current-leg elapsed (and identity age) alongside the terminal date stamp.
	const resumed = (run.run.resumeCount ?? 0) > 0;
	const tail = dateStamp
		? (resumed ? ` · ${elapsed}${identityPart} · ${theme.fg("dim", dateStamp)}` : ` · ${theme.fg("dim", dateStamp)}`)
		: ` · ${elapsed}${identityPart}`;
	const text = `${cursor}${indent}${glyph} ${agent}${phasePart} · ${status}${badgePart}${resumePart}${labelPart}${cwdPart}${tail}`;
	// Hard-clip with no ellipsis — the row already ends at the pane border, so an
	// ellipsis adds zero information and steals 1–3 columns of label space.
	return truncateToWidth(text, width, "");
}

function buildChildSummaryLines(theme: Theme, run: LiveRun, width: number, runs: LiveRun[]): string[] {
	const children = runs.filter((candidate) => parentRunIdOf(candidate) === run.run.id);
	if (children.length === 0) return [];
	const agents = children.map((child) => {
		if (child.source === "sync") return child.run.currentAgent ?? child.run.mode;
		return child.run.steps.find((step) => step.agent)?.agent ?? child.run.mode;
	});
	const uniqueAgents = Array.from(new Set(agents.filter(Boolean)));
	const agentWord = children.length === 1 ? "agent" : "agents";
	const suffix = uniqueAgents.length > 0 ? `: ${uniqueAgents.join(", ")}` : "";
	return [theme.fg("dim", truncateToWidth(`${children.length} ${agentWord}${suffix}`, width))];
}

// Cap the script section so a huge orchestration script can't drown the step
// outline below it; the outline is the part that changes while a workflow runs.
const WORKFLOW_SCRIPT_MAX_LINES = 24;

function childTokenTotal(child: AsyncRunSummary): number {
	if (child.totalTokens) return child.totalTokens.total;
	return child.steps.reduce((sum, step) => sum + (step.tokens?.total ?? 0), 0);
}

// Workflow groups get a purpose-built right pane: the SCRIPT that produced the
// orchestration (the workflow's whole identity) followed by a phase-grouped
// step outline synthesized from the child runs. The generic transcript pane is
// useless for groups (the container has no session of its own).
export function buildWorkflowRightLines(theme: Theme, run: AsyncRunSummary, width: number, runs: LiveRun[]): string[] {
	const out: string[] = [];
	const script = run.asyncDir ? readWorkflowScript(run.asyncDir) : undefined;
	if (script) {
		out.push(theme.fg("accent", truncateToWidth("─── Script ───", width)));
		const scriptLines = script.replace(/\t/g, "  ").split("\n");
		// Trim leading/trailing blank lines but keep interior structure verbatim:
		// code must not be word-wrap reflowed.
		while (scriptLines.length > 0 && scriptLines[0]?.trim() === "") scriptLines.shift();
		while (scriptLines.length > 0 && scriptLines[scriptLines.length - 1]?.trim() === "") scriptLines.pop();
		const shown = scriptLines.slice(0, WORKFLOW_SCRIPT_MAX_LINES);
		for (const line of shown) out.push(theme.fg("muted", truncateToWidth(line, width)));
		if (scriptLines.length > shown.length) {
			out.push(theme.fg("dim", truncateToWidth(`… (+${scriptLines.length - shown.length} more lines)`, width)));
		}
	}
	const children = runs
		.filter((candidate): candidate is LiveRun & { source: "async" } => candidate.source === "async" && candidate.run.parentRunId === run.id)
		.map((candidate) => candidate.run);
	if (children.length > 0) {
		if (out.length > 0) out.push("");
		out.push(theme.fg("accent", truncateToWidth("─── Steps ───", width)));
		let lastPhaseKey: number | undefined;
		let shownPhaseHeader = false;
		for (const child of sortedWorkflowChildren(children)) {
			if (child.phaseIndex !== lastPhaseKey || !shownPhaseHeader) {
				lastPhaseKey = child.phaseIndex;
				shownPhaseHeader = true;
				const label = child.phaseIndex === undefined && !child.phaseTitle ? "" : workflowPhaseLabel(child);
				if (label) out.push(theme.fg("muted", truncateToWidth(label, width)));
			}
			const agent = child.steps.find((step) => step.agent)?.agent ?? child.mode;
			const glyph = statusGlyph(theme, child.state, child.activityState, child.displayState);
			// parallelGroupId is a raw UUID; render a compact marker instead of the id.
			const parallelTag = child.parallelGroupId ? theme.fg("dim", "∥ ") : "";
			const stats: string[] = [child.state];
			const end = child.endedAt ?? Date.now();
			stats.push(formatDuration(Math.max(0, end - child.startedAt)));
			const tokens = childTokenTotal(child);
			if (tokens > 0) stats.push(`${formatTokens(tokens)} tok`);
			if (child.state === "running" && child.currentTool) stats.push(`→ ${child.currentTool}`);
			const labelPart = child.label ? ` — ${child.label}` : "";
			const line = `  ${glyph} ${parallelTag}${tintAgentName(agent, colorForAgentName(agent))} · ${stats.join(" · ")}${labelPart}`;
			out.push(truncateToWidth(line, width));
		}
	}
	return out;
}

export function buildRightLines(theme: Theme, run: LiveRun | undefined, width: number, runs: LiveRun[] = []): string[] {
	if (!run) return [theme.fg("dim", "(no events yet)")];
	if (run.source === "async" && run.run.workflow) {
		const workflowLines = buildWorkflowRightLines(theme, run.run, width, runs);
		if (workflowLines.length > 0) return workflowLines;
	}
	const childSummary = buildChildSummaryLines(theme, run, width, runs);
	const asyncDir = run.run.asyncDir;
	if (!asyncDir) return childSummary.length > 0 ? childSummary : [theme.fg("dim", "(no events yet)")];
	const events = readRunTranscript(asyncDir);
	if (events.length === 0) return childSummary.length > 0 ? childSummary : [theme.fg("dim", "(no events yet)")];
	// Shared set so each nested child run is rendered at most once across all steps.
	const rightPaneUsed = new Set<string>();

	// Parallel runs share one run record with N session transcripts, one per step.
	// Render order chronological-within-step
	// so each step reads as a coherent block instead of interleaved noise.
	type Step = { index: number; agent: string; startTs?: number; lines: string[]; final?: string; ended?: boolean; task?: string; label?: string };
	const steps = new Map<number, Step>();
	const ensureStep = (index: number, agent: string): Step => {
		let s = steps.get(index);
		if (!s) {
			s = { index, agent, lines: [] };
			steps.set(index, s);
		}
		if (!s.agent && agent) s.agent = agent;
		return s;
	};

	for (const event of events) {
		if (event.kind === "step-start") {
			const step = ensureStep(event.stepIndex, event.agent);
			if (!step.startTs) step.startTs = event.ts;
			if (event.task && !step.task) step.task = event.task;
			if (event.label && !step.label) step.label = event.label;
			continue;
		}
		if (event.kind === "tool") {
			const step = ensureStep(event.stepIndex, "");
			// charter inline-nested-fix: suppress plain `subagent` raw-args lines in the
			// right pane and recurse into the child run via the shared renderer, mirroring
			// the left-pane/compact-card wiring. Falls back to the plain line when the
			// child hasn't flushed its status.json yet.
			if (event.toolName === "subagent") {
				const isAsync = event.rawArgs?.async === true;
				if (!isAsync) {
					const child = findInlineChildRun(run.run.id, event.rawArgs, rightPaneUsed, event.ts);
					if (child) {
						for (const line of renderNestedChild(child.id, 1, event.rawArgs, rightPaneUsed)) {
							step.lines.push(theme.fg("dim", truncateToWidth(line, width)));
						}
						continue;
					}
				}
			}
			const suffix = event.durationMs !== undefined ? ` · ${event.durationMs}ms` : "";
			const prefix = `→ ${event.toolName}`;
			const argsBudget = Math.max(1, width - visibleWidth(prefix) - 1 - visibleWidth(suffix));
			const argsPreview = event.rawArgs ? previewArgs(event.rawArgs, argsBudget) : event.argsPreview;
			const argsPart = argsPreview ? ` ${argsPreview}` : "";
			const base = `${prefix}${argsPart}`;
			if (suffix) {
				const baseTrim = truncateToWidth(base, Math.max(0, width - visibleWidth(suffix)));
				step.lines.push(`${baseTrim}${theme.fg("dim", suffix)}`);
			} else {
				step.lines.push(truncateToWidth(base, width));
			}
			continue;
		}
		if (event.kind === "step-end") {
			const step = ensureStep(event.stepIndex, event.agent);
			step.ended = true;
			const middle: string[] = ["done"];
			if (event.status) middle.push(event.status);
			if (event.tokens !== undefined) middle.push(`${event.tokens}t`);
			if (event.durationMs !== undefined) middle.push(`${event.durationMs}ms`);
			const text = `─── ${middle.join(" · ")} ───`;
			step.lines.push(theme.fg("dim", truncateToWidth(text, width)));
			continue;
		}
		if (event.kind === "final-text") {
			const step = ensureStep(event.stepIndex, event.agent);
			step.final = event.text;
			continue;
		}
	}

	const ordered = [...steps.values()].sort((a, b) => {
		if (a.startTs !== undefined && b.startTs !== undefined) return a.startTs - b.startTs;
		return a.index - b.index;
	});
	const out: string[] = [];
	// Parallel children aren't 'steps' -- they race concurrently. Use 'Task N' so the
	// right pane reads correctly for tasks: [...] async runs.
	const stepWord = run.source === "async" && run.run.mode === "parallel" ? "Task" : "Step";
	for (const step of ordered) {
		out.push(theme.fg("accent", truncateToWidth(`─── ${stepWord} ${step.index + 1}: ${step.agent || "agent"} ───`, width)));
		if (step.label) {
			out.push(theme.fg("muted", truncateToWidth(`Label: ${step.label}`, width)));
		}
		if (step.task) {
			out.push(theme.fg("dim", truncateToWidth("→ prompt:", width)));
			for (const wrapped of wrapText(step.task, width)) out.push(theme.fg("muted", wrapped));
		}
		for (const line of step.lines) out.push(line);
		if (step.final) {
			const border = "─".repeat(Math.max(0, width));
			out.push(theme.fg("dim", border));
			for (const wrapped of wrapText(step.final, width)) out.push(wrapped);
			out.push(theme.fg("dim", border));
		}
	}
	return out;
}

interface ScrollState {
	top: number;
	sticky: boolean;
}

export class SubagentsStatusComponent implements Component {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly done: () => void;
	private readonly listRunsForOverlay: (recentLimit?: number) => AsyncRunOverlayData;
	private readonly listForegroundRuns: () => ForegroundRunSummary[];
	private readonly leftPaneCap: number;
	// Self-scheduling refresh handle (setTimeout, not setInterval) so the cadence
	// can back off when idle and restore when a live run appears. Reset on dispose.
	private refreshTimer: NodeJS.Timeout | undefined;
	private readonly refreshMs: number;
	// Structural signature of the last derived run set (excludes time-relative
	// labels). The timer requests a render only when this changes or a live label
	// must advance — see scheduleRefresh.
	private lastRunsSignature: string | undefined;
	private runs: LiveRun[] = [];
	private selectedId?: string;
	private leftScroll = 0;
	private rightScroll = new Map<string, ScrollState>();
	private lastRightHeight = MIN_VIEWPORT_HEIGHT;
	private lastRightWidth = 0;
	// Captured at the end of each render so keyboard handlers (j/k/g/G) can
	// scroll the left run list relative to its actual visible window rather than
	// guessing from the right pane's height.
	private lastLeftListHeight = 0;
	private errorMessage?: string;
	private sessionCwd: string | undefined;
	private sessionId: string | undefined;
	private readonly getBranchAnchorRunIds: (() => Set<string>) | undefined;
	private showAllSessions = false;
	// Charter-style focus: `tab` toggles which pane receives j/k/g/G/PgUp/PgDn.
	// Left = move selection; right = scroll transcript.
	private focus: "left" | "right" = "left";
	// Split fraction: portion of total width assigned to the left pane. `[` and
	// `]` shift it in SPLIT_STEP_COLS-sized steps; clamped to keep both panes
	// readable. Persists for the lifetime of the overlay instance.
	private splitFraction = DEFAULT_LEFT_FRACTION;

	constructor(
		tui: TUI,
		theme: Theme,
		done: () => void,
		deps: StatusOverlayDeps = {},
	) {
		this.tui = tui;
		this.theme = theme;
		this.done = done;
		this.listRunsForOverlay = deps.listRunsForOverlay ?? ((limit) => {
			const scope = this.showAllSessions ? {} : {
				...(this.sessionId ? { sessionId: this.sessionId } : { sessionCwd: this.sessionCwd }),
			};
			return expandOverlayByRootRunId(listRunsFromRegistryForOverlay(limit, scope), scope);
		});
		this.listForegroundRuns = deps.listForegroundRuns ?? (() => []);
		this.leftPaneCap = deps.leftPaneCap ?? LEFT_PANE_CAP;
		this.sessionCwd = deps.sessionCwd;
		this.sessionId = deps.sessionId;
		this.getBranchAnchorRunIds = deps.getBranchAnchorRunIds;
		this.refreshMs = deps.refreshMs ?? AUTO_REFRESH_MS;
		this.reload();
		// Seed the signature so the first timer tick doesn't spuriously diff against
		// undefined; the initial paint is driven by the overlay open, not the timer.
		this.lastRunsSignature = overlayRunsSignature(this.runs, this.selectedId, this.errorMessage);
		this.scheduleRefresh();
	}

	// Self-scheduling refresh tick. Reloads the derived run set, then requests a
	// render ONLY when the structural signature changed OR a live run still needs
	// its elapsed/spinner label advanced (render-on-diff with a coarse tick for
	// live labels). When nothing is live and nothing changed, the next tick backs
	// off to IDLE_REFRESH_MS; any live run or structural change restores the fast
	// cadence. Tests that inject an explicit refreshMs keep that exact period.
	private scheduleRefresh(): void {
		const hasInjectedPeriod = this.refreshMs !== AUTO_REFRESH_MS;
		this.refreshTimer = setTimeout(() => {
			this.reload();
			const signature = overlayRunsSignature(this.runs, this.selectedId, this.errorMessage);
			const changed = signature !== this.lastRunsSignature;
			const hasLive = this.runs.some(runHasLiveLabel);
			this.lastRunsSignature = signature;
			if (changed || hasLive) this.tui.requestRender();
			this.scheduleRefresh();
		}, hasInjectedPeriod || this.runs.some(runHasLiveLabel) ? this.refreshMs : IDLE_REFRESH_MS);
		this.refreshTimer.unref?.();
	}

	private reload(): void {
		try {
			const overlay = this.listRunsForOverlay();
			const sync = this.listForegroundRuns();
			const syncIds = new Set(sync.map((run) => run.id));
			// charter nested-subagent-display: prefer in-memory sync rows while disk mirrors exist.
			const combined = [...overlay.active, ...overlay.recent].filter((run) => !syncIds.has(run.id));
			this.runs = sortLiveRuns(sync, combined);
			if (!this.showAllSessions && (this.sessionId || this.sessionCwd)) {
				const anchorRunIds = this.getBranchAnchorRunIds?.();
				this.runs = filterRunsToSessionTree(this.runs, { sessionId: this.sessionId, sessionCwd: this.sessionCwd }, anchorRunIds);
			}
			this.errorMessage = undefined;
		} catch (error) {
			this.runs = [];
			this.errorMessage = error instanceof Error ? error.message : String(error);
		}
		this.reconcileSelection();
	}

	// Visible only to tests; mirrors the `a` keybinding for direct invocation.
	setShowAllSessions(value: boolean): void {
		this.showAllSessions = value;
		this.reload();
	}

	private reconcileSelection(): void {
		if (this.runs.length === 0) {
			this.selectedId = undefined;
			this.leftScroll = 0;
			return;
		}
		const stillHere = this.selectedId !== undefined
			&& this.runs.some((run) => runKey(run) === this.selectedId);
		if (!stillHere) {
			this.selectedId = runKey(this.runs[0]!);
		}
		this.ensureSelectionVisible();
	}

	private selectedIndex(): number {
		if (this.runs.length === 0) return -1;
		const id = this.selectedId;
		const index = id !== undefined ? this.runs.findIndex((run) => runKey(run) === id) : -1;
		return index === -1 ? 0 : index;
	}

	private selectedRun(): LiveRun | undefined {
		const index = this.selectedIndex();
		return index >= 0 ? this.runs[index] : undefined;
	}

	/** Count of actual agent runs for the header label. A parallel/workflow GROUP
	 * is a container, not an agent: when its leaf children are present as their own
	 * rows, the container row itself must not be tallied (otherwise a 2-agent
	 * parallel fan-out reads as "3 total"). A real agent that happens to have spawned
	 * sub-agents (mode "single" with children) is still a genuine agent and counts. */
	private countAgentRows(): number {
		return this.runs.reduce((sum, run) => sum + (this.isGroupContainerRow(run) ? 0 : 1), 0);
	}

	private isGroupContainerRow(run: LiveRun): boolean {
		if (run.source !== "async") return false;
		const hasChildRows = this.runs.some((other) => other.run.parentRunId === run.run.id);
		if (!hasChildRows) return false;
		return run.run.workflow === true || run.run.mode === "parallel";
	}

	private ensureSelectionVisible(): void {
		const index = this.selectedIndex();
		if (index < 0) return;
		if (index < this.leftScroll) this.leftScroll = index;
		// The left list shares the body with the legend block; use the actual list
		// height captured at last render so j/k/G/g keep the selection in view
		// instead of letting it scroll behind the legend or off the bottom.
		const listHeight = this.lastLeftListHeight || computeBodyHeight(this.tui);
		const limit = this.leftScroll + listHeight;
		if (index >= limit) this.leftScroll = index - listHeight + 1;
	}

	private moveSelection(delta: number): void {
		if (this.runs.length === 0) return;
		const current = this.selectedIndex();
		const next = Math.max(0, Math.min(this.runs.length - 1, current + delta));
		this.selectedId = runKey(this.runs[next]!);
		this.ensureSelectionVisible();
		this.tui.requestRender();
	}

	private jumpSelection(toEnd: boolean): void {
		if (this.runs.length === 0) return;
		const index = toEnd ? this.runs.length - 1 : 0;
		this.selectedId = runKey(this.runs[index]!);
		this.ensureSelectionVisible();
		this.tui.requestRender();
	}

	/** Move the left-pane selection by a viewport page (PageUp/PageDown, and u/d
	 * when the left pane is focused). Page size is the list height captured at the
	 * last render so it matches what the user actually sees. */
	private pageSelection(direction: 1 | -1, fraction = 1): void {
		if (this.runs.length === 0) return;
		const page = this.lastLeftListHeight || computeBodyHeight(this.tui);
		const step = Math.max(1, Math.floor(page * fraction));
		this.moveSelection(direction * step);
	}

	private getRightScrollState(): ScrollState {
		const run = this.selectedRun();
		if (!run) return { top: 0, sticky: true };
		const key = runKey(run);
		let state = this.rightScroll.get(key);
		if (!state) {
			state = { top: 0, sticky: true };
			this.rightScroll.set(key, state);
		}
		return state;
	}

	private scrollRight(delta: number): void {
		const run = this.selectedRun();
		if (!run) return;
		const state = this.getRightScrollState();
		const lines = buildRightLines(this.theme, run, this.lastRightWidth || 80, this.runs);
		const maxTop = Math.max(0, lines.length - this.lastRightHeight);
		state.top = Math.max(0, Math.min(maxTop, state.top + delta));
		state.sticky = state.top >= maxTop;
		this.tui.requestRender();
	}

	/**
	 * Scroll the right pane by a full page in the given direction (+1 down, -1 up).
	 * Exposed for tests so PgUp/PgDn behavior can be exercised without simulating keys.
	 */
	scrollRightPaneByPage(direction: 1 | -1): void {
		this.scrollRightByPage(direction);
	}

	/** Test-only accessor for the right-pane scroll offset of the currently selected run. */
	getRightPaneScrollTop(): number {
		const run = this.selectedRun();
		if (!run) return 0;
		return this.rightScroll.get(runKey(run))?.top ?? 0;
	}

	private scrollRightByPage(direction: 1 | -1): void {
		const page = Math.max(1, this.lastRightHeight);
		this.scrollRight(direction * page);
	}

	private openSessionFile(): void {
		// Opening an editor would require spawning a subprocess; keep the dashboard
		// read-only now that subagent execution is fully in-process.
	}

	handleInput(data: string): void {
		// matchesKey handles both legacy (raw char) and Kitty CSI-u sequences.
		// Plain `data === "j"` only worked when Kitty keyboard protocol was off.
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "q")) {
			this.done();
			return;
		}
		if (matchesKey(data, "tab")) {
			this.focus = this.focus === "left" ? "right" : "left";
			this.tui.requestRender();
			return;
		}
		// `[` shrinks the left pane (gives more space to the right transcript),
		// `]` grows it. Step is SPLIT_STEP_COLS / total-width so the fraction shifts
		// proportionally regardless of terminal width.
		if (data === "[" || matchesKey(data, "[")) {
			this.shiftSplit(-1);
			return;
		}
		if (data === "]" || matchesKey(data, "]")) {
			this.shiftSplit(1);
			return;
		}
		if (matchesKey(data, "j") || matchesKey(data, "down")) {
			if (this.focus === "right") this.scrollRight(1);
			else this.moveSelection(1);
			return;
		}
		if (matchesKey(data, "k") || matchesKey(data, "up")) {
			if (this.focus === "right") this.scrollRight(-1);
			else this.moveSelection(-1);
			return;
		}
		if (matchesKey(data, "g")) {
			if (this.focus === "right") {
				const state = this.getRightScrollState();
				state.top = 0;
				state.sticky = false;
				this.tui.requestRender();
			} else {
				this.jumpSelection(false);
			}
			return;
		}
		if (matchesKey(data, "shift+g")) {
			if (this.focus === "right") {
				const state = this.getRightScrollState();
				state.sticky = true;
				this.tui.requestRender();
			} else {
				this.jumpSelection(true);
			}
			return;
		}
		// Legacy explicit right-pane scroll bindings stay available regardless of focus.
		if (matchesKey(data, "shift+j") || matchesKey(data, "shift+down")) {
			this.scrollRight(1);
			return;
		}
		if (matchesKey(data, "shift+k") || matchesKey(data, "shift+up")) {
			this.scrollRight(-1);
			return;
		}
		if (matchesKey(data, "pageDown")) {
			if (this.focus === "right") this.scrollRightByPage(1);
			else this.pageSelection(1);
			return;
		}
		if (matchesKey(data, "pageUp")) {
			if (this.focus === "right") this.scrollRightByPage(-1);
			else this.pageSelection(-1);
			return;
		}
		if (matchesKey(data, "d") || matchesKey(data, "space")) {
			if (this.focus === "right") this.scrollRight(Math.max(1, Math.floor(this.lastRightHeight / 2)));
			else this.pageSelection(1, 0.5);
			return;
		}
		if (matchesKey(data, "u") || matchesKey(data, "shift+space")) {
			if (this.focus === "right") this.scrollRight(-Math.max(1, Math.floor(this.lastRightHeight / 2)));
			else this.pageSelection(-1, 0.5);
			return;
		}
		if (matchesKey(data, "a")) {
			this.showAllSessions = !this.showAllSessions;
			this.reload();
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "return") || matchesKey(data, "o")) {
			this.openSessionFile();
		}
	}

	private bodyRow(left: string, right: string, leftWidth: number, rightWidth: number): string {
		// All chrome glyphs use `dim` so the borders read as a single uniform tone
		// (matches pi-charter); previously the `│` was `border`-tinted while the
		// dash runs were `dim`, which produced the 2/3-color border the user saw.
		const border = this.theme.fg("dim", "│");
		const leftCell = padRight(truncateToWidth(left, leftWidth), leftWidth);
		const rightCell = padRight(truncateToWidth(right, rightWidth), rightWidth);
		return border + leftCell + border + rightCell + border;
	}

	private shiftSplit(direction: -1 | 1): void {
		const cols = this.tui.terminal?.columns ?? process.stdout.columns ?? 120;
		const step = SPLIT_STEP_COLS / Math.max(1, cols);
		const next = Math.min(0.7, Math.max(0.2, this.splitFraction + direction * step));
		// Don't let the fraction accumulate past the point where it changes the
		// rendered width — otherwise hitting LEFT_PANE_CAP (or MIN_RIGHT_PANE) on
		// `]` would inflate the fraction silently and require many `[` presses to
		// recover. Compare achievable widths instead of raw fractions.
		const currentLeft = this.computeLeftWidth(cols);
		const probeFraction = this.splitFraction;
		this.splitFraction = next;
		const nextLeft = this.computeLeftWidth(cols);
		if (nextLeft === currentLeft) {
			this.splitFraction = probeFraction;
			return;
		}
		this.tui.requestRender();
	}

	private computeLeftWidth(totalWidth: number): number {
		const raw = Math.round(totalWidth * this.splitFraction);
		const capped = Math.min(this.leftPaneCap, totalWidth - 3 - MIN_RIGHT_PANE);
		return Math.max(MIN_LEFT_PANE, Math.min(capped, raw));
	}

	private buildLegendLines(width: number): string[] {
		if (width <= 0) return [];
		const keyW = Math.min(LEGEND_KEY_W, Math.max(3, width - 6));
		return LEGEND_ENTRIES.map(([key, desc]) => {
			const keyCell = padRight(key, keyW);
			const line = `${keyCell}  ${desc}`;
			return this.theme.fg("dim", truncateToWidth(line, width));
		});
	}

	private topBorder(leftWidth: number, rightWidth: number): string {
		const scoped = Boolean(this.sessionId || this.sessionCwd);
		const scopeMarker = this.showAllSessions || !scoped ? " · [all sessions]" : "";
		const leftLabel = `Subagent runs · ${this.countAgentRows()} total${scopeMarker}`;
		const leftFocused = this.focus === "left";
		const leftSegment = titledTopSegment(this.theme, {
			width: leftWidth,
			label: leftLabel,
			labelColor: leftFocused ? "accent" : "text",
			labelBold: leftFocused,
		});
		const selected = this.selectedRun();
		const rightFocused = this.focus === "right";
		let rightSegment: string;
		if (selected) {
			const rightLabel = selectedRunTitle(selected);
			const tailPlain = selectedRunTailPlain(selected);
			const tailRendered = selectedRunTailRendered(this.theme, selected);
			rightSegment = titledTopSegment(this.theme, {
				width: rightWidth,
				label: rightLabel,
				tailRendered,
				tailPlain,
				labelColor: rightFocused ? "accent" : "text",
				labelBold: rightFocused,
			});
		} else {
			rightSegment = titledTopSegment(this.theme, {
				width: rightWidth,
				label: "(no selection)",
				labelColor: "dim",
				tailColor: "dim",
			});
		}
		const corner = (s: string) => this.theme.fg("dim", s);
		return `${corner("╭")}${leftSegment}${corner("┬")}${rightSegment}${corner("╮")}`;
	}

	private bottomBorder(leftWidth: number, rightWidth: number, rightTop: number, rightTotal: number): string {
		// Charter-style: bottom-border carries only counter + a focused-pane key
		// summary. The shared key reference lives in the legend section above this
		// border, so we avoid duplicating `j/k`, `tab`, etc. here.
		const leftHint = this.runs.length > 0
			? `${this.selectedIndex() + 1}/${this.runs.length}${this.showAllSessions ? "  [all sessions]" : ""}`
			: "(no runs)";
		const maxTop = Math.max(0, rightTotal - this.lastRightHeight);
		const rightHint = maxTop > 0 ? `${rightTop}/${maxTop}` : "";

		const leftSegment = titledBottomSegment(this.theme, leftWidth, leftHint, this.focus === "left");
		const rightSegment = titledBottomSegment(this.theme, rightWidth, rightHint, this.focus === "right");
		const corner = (s: string) => this.theme.fg("dim", s);
		return `${corner("╰")}${leftSegment}${corner("┴")}${rightSegment}${corner("╯")}`;
	}

	invalidate(): void {
		// No cached render output.
	}

	render(width: number): string[] {
		const w = Math.max(8, width);
		const leftWidth = this.computeLeftWidth(w);
		const rightWidth = Math.max(MIN_RIGHT_PANE, w - 3 - leftWidth);
		this.lastRightWidth = rightWidth;

		const now = Date.now();
		const showCwd = this.showAllSessions || !(this.sessionId || this.sessionCwd);
		const leftListLines: string[] = [];
		if (this.runs.length === 0) {
			leftListLines.push(this.theme.fg("dim", "No subagent runs"));
		} else {
			const depthMap = buildDepthMap(this.runs);
			for (let i = 0; i < this.runs.length; i++) {
				const run = this.runs[i]!;
				const isSelected = runKey(run) === this.selectedId;
				leftListLines.push(buildLeftLine(this.theme, run, isSelected, now, leftWidth, depthMap.get(run.run.id) ?? 0, showCwd));
			}
		}

		const selected = this.selectedRun();
		const rightLines = buildRightLines(this.theme, selected, rightWidth, this.runs);

		const bodyHeight = computeBodyHeight(this.tui);
		this.lastRightHeight = bodyHeight;

		// Left pane is split vertically: top = run list, bottom = legend section.
		// Legend takes its content height (+1 for the flatRule divider). The list
		// absorbs whatever space remains, so it shrinks first on a tiny terminal.
		const legendLines = this.buildLegendLines(leftWidth);
		const legendHeight = legendLines.length;
		const legendBlockHeight = legendHeight > 0 ? legendHeight + 1 : 0; // +1 divider
		const listHeight = Math.max(1, bodyHeight - legendBlockHeight);
		this.lastLeftListHeight = listHeight;
		// Re-clamp leftScroll so j/k/G that ran before the first render (or after a
		// terminal resize) produce a visible selection instead of an empty slice.
		const selectedIdx = this.selectedIndex();
		if (selectedIdx >= 0) {
			if (selectedIdx < this.leftScroll) this.leftScroll = selectedIdx;
			else if (selectedIdx >= this.leftScroll + listHeight) this.leftScroll = selectedIdx - listHeight + 1;
			const maxLeftScroll = Math.max(0, leftListLines.length - listHeight);
			if (this.leftScroll > maxLeftScroll) this.leftScroll = maxLeftScroll;
		}
		const divider = flatRule(this.theme, "keys", leftWidth);

		// Right pane scroll bookkeeping: sticky-to-bottom for the selected run.
		let rightTop = 0;
		if (selected) {
			const state = this.getRightScrollState();
			const maxTop = Math.max(0, rightLines.length - bodyHeight);
			if (state.sticky) state.top = maxTop;
			state.top = Math.max(0, Math.min(maxTop, state.top));
			rightTop = state.top;
		}

		const visibleList = leftListLines.slice(this.leftScroll, this.leftScroll + listHeight);
		const visibleRight = rightLines.slice(rightTop, rightTop + bodyHeight);

		const rows: string[] = [this.topBorder(leftWidth, rightWidth)];
		if (this.errorMessage) {
			rows.push(this.bodyRow(
				this.theme.fg("error", truncateToWidth(`status read failed: ${this.errorMessage}`, leftWidth)),
				"",
				leftWidth,
				rightWidth,
			));
		}
		for (let i = 0; i < bodyHeight; i++) {
			let left: string;
			if (i < listHeight) {
				left = visibleList[i] ?? "";
			} else if (i === listHeight && legendBlockHeight > 0) {
				left = divider;
			} else if (legendBlockHeight > 0) {
				const legendIdx = i - (listHeight + 1);
				left = legendLines[legendIdx] ?? "";
			} else {
				left = "";
			}
			const right = visibleRight[i] ?? "";
			rows.push(this.bodyRow(left, right, leftWidth, rightWidth));
		}
		rows.push(this.bottomBorder(leftWidth, rightWidth, rightTop, rightLines.length));
		void formatScrollInfo;
		return rows;
	}

	dispose(): void {
		if (this.refreshTimer) clearTimeout(this.refreshTimer);
		this.refreshTimer = undefined;
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Right-pane top-border label helpers — keep the chrome title in sync with the
// currently selected run so users always know what the transcript belongs to.
// ─────────────────────────────────────────────────────────────────────────────

function selectedRunTitle(run: LiveRun): string {
	if (run.run.label) return run.run.label;
	if (run.source === "sync") {
		return run.run.currentAgent ?? run.run.mode ?? "(run)";
	}
	if (run.run.workflow) return "workflow";
	const running = run.run.steps?.find((s) => s.status === "running");
	const step = running ?? run.run.steps?.[0];
	return step?.agent ?? run.run.mode ?? "(run)";
}

function selectedRunTailPlain(run: LiveRun): string {
	const state = run.run.state ?? "";
	const tool = run.run.currentTool ? ` · ${run.run.currentTool}` : "";
	return state || tool ? `[${state}]${tool}` : "";
}

function selectedRunTailRendered(theme: Theme, run: LiveRun): string {
	const state = run.run.state ?? "";
	const stateColor = state === "running" ? "accent" : state === "failed" || state === "lost" ? "error" : state === "complete" ? "success" : "dim";
	const parts = [theme.fg(stateColor, `[${state}]`)];
	if (run.run.currentTool) parts.push(theme.fg("muted", run.run.currentTool));
	return parts.join(theme.fg("dim", " · "));
}
