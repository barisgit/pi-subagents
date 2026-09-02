import * as path from "node:path";
import { colorForAgentName } from "../shared/agents.ts";
import {
	copyToClipboard,
	type AppKeybinding,
	type KeybindingsManager,
	type Theme,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	computeSplitPaneLayout,
	endCursor,
	ensureCursorVisible as ensurePaneCursorVisible,
	homeCursor,
	moveCursor,
	pageCursor,
	paneOverlay,
	resizeSplitPane,
	togglePaneFocus,
	type PaneOverlayComponent,
	type PaneOverlayContext,
} from "pi-extension-utils";
import {
	type AsyncRunOverlayData,
	type AsyncRunSummary,
	buildGroupSummary,
	isQueuedStubRecent,
	listRunsFromRegistryForOverlay,
	readLeafRunViewCached,
	sortRuns,
} from "../state/async-status.ts";
import { formatDuration, formatTokenCounter } from "./formatters.ts";
import { tintAgentName } from "./render-shared.ts";
import {
	buildRightLines,
	type LiveDashboardSession,
	LiveSessionRenderCache,
	type LiveToolComponentStore,
} from "./dashboard-detail-renderer.ts";
import { aggregateState, cellsFromRunView, renderRowLine, type RowCells, type RowState } from "./row-line.ts";
import type { LiveToolProgress } from "../shared/live-session-relay.ts";
import { readRunTranscript, RunMessageReader } from "../state/run-transcript.ts";
import { deriveRunDisplayState } from "../state/run-liveness.ts";
import { formatPhase } from "../state/run-phase.ts";
import { workflowDisplayName } from "../state/workflow-display.ts";
import { describeAgentLabel, formatShapeBadge } from "../state/run-shape.ts";
import type { SubagentState } from "../protocol/types.ts";
import type { LiveRun, RunView } from "../state/run-view.ts";
import {
	listRunsByRootRunIds,
	readAllEntries,
	readShardEntries,
	type RunsRegistryEntry,
} from "../state/runs-registry.ts";
import {
	containerRowInfo as deriveContainerRowInfo,
	countAgentRows as deriveCountAgentRows,
	deriveDisplayRows,
	detailTargetForRow,
	isGroupContainerRow as deriveIsGroupContainerRow,
	isPendingDelivery as deriveIsPendingDelivery,
	parentRunIdOf,
	rowKey as dashboardRowKey,
	type ContainerRowInfo,
	type DetailTarget,
	type DisplayRow,
} from "./dashboard-row-model.ts";
import { deriveLiveRuns } from "./dashboard-run-source.ts";
import { canonicalWorkflowPhaseTitle } from "../shared/workflow-phase-title.ts";

// Re-exported from the pure row-derivation model so existing import sites stay stable.
export type { ContainerRowInfo, DisplayRow } from "./dashboard-row-model.ts";

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
const SELECTED_STATUS_BOX_ROWS = 5;
// Transient key-action feedback (copy id / copy dir) shown under the selected-run
// status section; cleared automatically so the sidebar returns to its baseline.
const ACTION_NOTICE_MS = 4000;
// Shared legend lives in the left pane's bottom section, charter-picker style.
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

// charter VAL-RUNVIEW-TYPE: ForegroundRunSummary is now an alias of the canonical
// RunView display type (foreground producers populate steps:[] plus the
// foreground-only optionals). LiveRun's discriminator is provenance
// (ownership: 'live'|'foreign'), not source: 'sync'|'async'.
export type ForegroundRunSummary = RunView;
export type { LiveRun };

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
	// Registry memory mirror accessor: returns the RunViews this process owns
	// in-memory, keyed by run id. Owned async runs render live-from-memory; all
	// others (post-reload, external) hydrate foreign-from-disk. Absent in tests
	// that only exercise the disk path.
	getOwnedRunViews?: () => Map<string, AsyncRunSummary>;
	getLiveSessions?: (runId: string) => LiveDashboardSession[];
	getLiveToolProgress?: (session: LiveDashboardSession) => ReadonlyMap<string, LiveToolProgress>;
	liveToolComponents?: LiveToolComponentStore;
	rendererCatalog?: { getToolDefinition(name: string): ToolDefinition | undefined };
	runMessageReader?: RunMessageReader;
	selectionSettleMs?: number;
	keybindings?: Pick<KeybindingsManager, "getKeys">;
	getToolsExpanded?: () => boolean;
	setToolsExpanded?: (expanded: boolean) => void;
}

function effectiveKeys(
	keybindings: Pick<KeybindingsManager, "getKeys"> | undefined,
	binding: AppKeybinding,
	fallback: string,
): string[] {
	try {
		if (keybindings && typeof keybindings.getKeys === "function") return keybindings.getKeys(binding);
	} catch {
		// Older or headless hosts fall back to Pi's default binding.
	}
	return [fallback];
}

function entryMatchesOverlayScope(
	entry: RunsRegistryEntry,
	scope: { sessionCwd?: string; sessionId?: string },
): boolean {
	if (scope.sessionId) {
		const tag = entry.rootSessionId ?? entry.parentSessionId;
		return tag === scope.sessionId;
	}
	if (scope.sessionCwd) return !entry.cwd || entry.cwd === scope.sessionCwd;
	return true;
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

export function runViewFromRegistryEntry(
	entry: RunsRegistryEntry,
	registryEntries?: RunsRegistryEntry[],
	ownedViews?: Map<string, AsyncRunSummary>,
): AsyncRunSummary {
	// Owned in-process runs resolve their leaf from the registry memory mirror;
	// non-owned entries reuse the shared terminal-summary cache with
	// readRunViewForEntry: terminal leaves are reused by status.json mtime+size;
	// active leaves are always rebuilt so the lost-transition keeps firing.
	const summary = ownedViews?.get(entry.runId) ?? readLeafRunViewCached(entry.runRecordDir);
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
		const childSummaries = children.map((child) => ({
			...runViewFromRegistryEntry(child, entries, ownedViews),
			...registryWorkflowFields(child),
		}));
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

export function expandOverlayByRootRunId(
	seed: AsyncRunOverlayData,
	scope: { sessionCwd?: string; sessionId?: string },
	ownedViews?: Map<string, AsyncRunSummary>,
): AsyncRunOverlayData {
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
		const owned = ownedViews?.has(entry.runId) === true;
		const isLeaf = Boolean(entry.agentName || entry.agentNames);
		if (isLeaf && !owned && !readLeafRunViewCached(entry.runRecordDir) && !isQueuedStubRecent(entry)) continue;
		byId.set(entry.runId, runViewFromRegistryEntry(entry, entries, ownedViews));
	}

	const all = [...byId.values()];
	return {
		active: all.filter((run) => run.state === "queued" || run.state === "running" || run.state === "lost"),
		recent: all.filter(
			(run) =>
				run.state === "complete" ||
				run.state === "failed" ||
				run.state === "paused" ||
				run.state === "interrupted" ||
				run.state === "skipped",
		),
	};
}

export function foregroundRunsFromState(
	state: Pick<SubagentState, "foregroundControls"> & { baseCwd?: string },
): ForegroundRunSummary[] {
	return Array.from(state.foregroundControls.values())
		.map((control: ForegroundControl) => {
			// A foreground run is opened before it acquires a leaf permit; it is only
			// "running" once it has produced progress (control.started). Until then it
			// renders "queued" so a permit-blocked run is never shown as active.
			const runState = control.started ? ("running" as const) : ("queued" as const);
			const displayState = deriveRunDisplayState({
				state: runState,
				activityState: control.currentActivityState,
				currentTool: control.currentTool,
				phase: control.phase,
				phaseStartedAt: control.phaseStartedAt,
				lastActivityAt: control.lastActivityAt,
				lastUpdate: control.updatedAt,
			});
			return {
				id: control.runId,
				steps: [],
				...(control.asyncDir ? { asyncDir: control.asyncDir } : {}),
				...(control.parentRunId ? { parentRunId: control.parentRunId } : {}),
				state: runState,
				...(control.currentActivityState ? { activityState: control.currentActivityState } : {}),
				...(displayState ? { displayState } : {}),
				...(control.lastActivityAt !== undefined ? { lastActivityAt: control.lastActivityAt } : {}),
				...(control.currentTool ? { currentTool: control.currentTool } : {}),
				...(control.currentToolStartedAt !== undefined
					? { currentToolStartedAt: control.currentToolStartedAt }
					: {}),
				...(control.phase !== undefined ? { phase: control.phase } : {}),
				...(control.phaseStartedAt !== undefined ? { phaseStartedAt: control.phaseStartedAt } : {}),
				mode: control.mode,
				...(state.baseCwd ? { cwd: state.baseCwd } : {}),
				startedAt: control.startedAt,
				...(control.executionStartedAt !== undefined ? { executionStartedAt: control.executionStartedAt } : {}),
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

export function runKey(run: LiveRun): string {
	// Keyed by bare run id, NOT `${ownership}:${id}`: async ownership is now
	// time-varying (live while this process owns the run, then foreign once the
	// registry retention sweep drops it), so an ownership-prefixed key would change
	// under a stable run and reset the user's selection to the top row ~10s after an
	// owned-async run completes. Ids are unique per derived pass (sync ids are
	// deduped out of the async set in dashboard-run-source), matching the
	// bare-id keying already used for collapsedIds.
	return run.run.id;
}

// Returns the agent name(s) as a pre-styled string when colors apply, otherwise plain text.
// Parallel runs with heterogeneous agents get per-piece tinting so each name uses its own color.
function runAgentLabel(run: LiveRun, theme: Theme): string {
	// The live-agent label is selected by the presence of currentAgent (a
	// foreground-only field), NOT by provenance. Owned-async leaves carry no
	// currentAgent (only real steps) so they fall through to the step logic below,
	// and async group containers fall through to the workflow/parallel branches.
	if (run.run.currentAgent) {
		const name = run.run.currentAgent;
		return tintAgentName(name, run.run.currentAgentColor ?? colorForAgentName(name));
	}
	if (run.run.workflow) return theme.fg("toolTitle", workflowDisplayName(run.run.workflowMeta));
	const mode = run.run.mode ?? "single";
	const steps = (mode === "parallel" ? run.run.steps.filter((s) => s.agent) : run.run.steps).filter((s) => s.agent);
	const running = run.run.steps.find((step) => step.status === "running");
	const fallbackName = running?.agent ?? run.run.steps.find((step) => step.agent)?.agent ?? mode;
	// Per-step disk-persisted color falls back to the live name -> color map so completed
	// async rows (and any run whose status.json never recorded a step.live.color) still tint.
	const desc = describeAgentLabel(
		steps.map((s) => s.agent!),
		mode,
		colorForAgentName(fallbackName),
		steps.map((s) => s.color ?? colorForAgentName(s.agent!)),
	);
	if (desc.kind === "uniformParallel") return tintAgentName(`parallel(${desc.total})`, desc.color);
	if (desc.kind === "mixedParallel") {
		return desc.agents.map((a) => tintAgentName(a.name, a.color)).join(theme.fg("dim", "+"));
	}
	return tintAgentName(desc.name, desc.color);
}

// Multi-step shape badge for parallel progress, e.g. 'parallel 3/5'.
// Empty for single-step runs to keep the left-pane line compact.
function workflowPhaseChip(run: LiveRun): string {
	// phaseIndex is a disk-only (workflow) field; foreground views never set it,
	// so the field-presence check alone selects foreign workflow children.
	if (run.run.phaseIndex === undefined) return "";
	// ∥ marks a child that ran inside a parallel() fan-out, so parallel-vs-
	// sequential shape is readable in the left list, not just the right pane.
	const marker = run.run.parallelGroupId ? "∥ " : "";
	const label = `${marker}P${run.run.phaseIndex}`;
	const title = run.run.phaseTitle ? canonicalWorkflowPhaseTitle(run.run.phaseTitle) : undefined;
	return title ? `${label} ${title}` : label;
}

function runShapeBadge(run: LiveRun): string {
	// Foreground views carry steps:[] => total 0 => formatShapeBadge returns
	// undefined => ""; no provenance branch needed.
	const total = run.run.steps.length;
	// Parallel progress uses done-count.
	const current =
		run.run.mode === "parallel"
			? run.run.steps.filter((s) => s.status === "complete" || s.status === "failed" || s.status === "skipped")
					.length
			: (run.run.currentStep ?? 0) + 1;
	return formatShapeBadge({ mode: run.run.mode ?? "single", total, current }) ?? "";
}

// A run shows a live, ticking elapsed/spinner label iff it is NOT terminal and
// NOT lost — mirrors the freeze logic in runElapsed/runIdentityAge. Terminal
// and lost rows freeze their labels at data-landing time, so they need no
// per-tick repaint. Used to decide whether a coarse clock tick must still fire
// a render (live labels) and whether the refresh interval may back off (no live
// runs => idle).
function runHasLiveLabel(run: LiveRun): boolean {
	// Liveness is a data property of the run's state, not its provenance: a
	// terminal/lost run freezes its label regardless of whether this process owns
	// it. Foreground runs are state:'queued' or 'running' => not terminal => live.
	const s = run.run.state;
	if (s === "complete" || s === "failed" || s === "interrupted" || s === "skipped" || s === "lost" || s === "paused")
		return false;
	if (run.run.displayState === "lost") return false;
	return true;
}

// Cheap structural signature of the derived run set that EXCLUDES time-relative
// fields (elapsed/age labels), so an idle tick where only the wall clock moved
// produces an identical signature and is suppressed. Includes everything that
// changes the painted rows: identity, order, state, derived liveness, current
// tool, phase, and step progress. The render-on-diff gate fires a repaint when
// this changes; the coarse-tick path separately keeps live labels advancing.
export function overlayRunsSignature(
	runs: LiveRun[],
	selectedId: string | undefined,
	errorMessage: string | undefined,
): string {
	const parts: string[] = [`sel:${selectedId ?? ""}`, `err:${errorMessage ? 1 : 0}`];
	for (const run of runs) {
		// Provenance-free signature: include every present live-data field so the
		// dashboard repaints whenever an owned-async child advances (step/phase/
		// displayState/tool/activity), exactly as it does for a foreign disk run.
		const r = run.run;
		parts.push(
			`run:${r.id}:${r.state}:${r.displayState ?? ""}:${r.currentTool ?? ""}:${r.phase ?? ""}:${r.currentStep ?? ""}:${r.steps?.length ?? 0}:${r.currentIndex ?? ""}:${r.lastActivityAt ?? ""}`,
		);
	}
	return parts.join("|");
}

export function runElapsed(run: LiveRun, now: number): string {
	// A queued run (dispatched but blocked on a leaf permit) has not begun executing,
	// so showing a running timer would misleadingly count queue-wait. Render no timer.
	if (run.run.state === "queued") return "";
	// Measure execution time from the queued->running flip (executionStartedAt) when
	// available, falling back to startedAt for records written before that field.
	const legStartedAt = run.run.resumedAt ?? run.run.executionStartedAt ?? run.run.startedAt;
	// Terminal runs (lost/complete/failed) must not keep ticking. The freeze is a
	// data property — endedAt or a terminal/lost state — NOT provenance: an owned
	// in-process run that has completed (now ownership:'live') must freeze too, or
	// its elapsed timer ticks forever. lost runs have no endedAt because the child
	// crashed without writing one, so fall back to lastUpdate.
	if (run.run.endedAt) return formatDuration(Math.max(0, run.run.endedAt - legStartedAt));
	// A force-killed run keeps state==='running' on disk but goes displayState==='lost'
	// once its runner heartbeat is stale — freeze the timer on that too, not just on a
	// terminal state, otherwise a dead run keeps ticking.
	if (
		run.run.state === "lost" ||
		run.run.state === "complete" ||
		run.run.state === "failed" ||
		run.run.state === "interrupted" ||
		run.run.state === "skipped" ||
		run.run.state === "paused" ||
		run.run.displayState === "lost"
	) {
		const frozen = run.run.lastUpdate ?? run.run.startedAt;
		return formatDuration(Math.max(0, frozen - legStartedAt));
	}
	return formatDuration(Math.max(0, now - legStartedAt));
}

export function runIdentityAge(run: LiveRun, now: number): string | undefined {
	if ((run.run.resumeCount ?? 0) <= 0) return undefined;
	// Identity age = wall time since the run first started. For a terminal run it
	// must freeze at the end (endedAt, or lastUpdate for a lost run that crashed
	// without one) instead of ticking against `now` forever.
	const isLost = run.run.state === "lost" || run.run.displayState === "lost";
	// Freeze on terminal data, not provenance: a completed owned-async run
	// (ownership:'live') must stop aging at endedAt/lastUpdate like a foreign one.
	const frozenEnd =
		run.run.endedAt ??
		(run.run.state === "complete" ||
		run.run.state === "failed" ||
		run.run.state === "interrupted" ||
		run.run.state === "skipped" ||
		run.run.state === "paused" ||
		isLost
			? run.run.lastUpdate
			: undefined);
	const end = frozenEnd ?? now;
	return formatDuration(Math.max(0, end - run.run.startedAt));
}

function stateBucket(state: AsyncRunSummary["state"]): number {
	switch (state) {
		case "running":
			return 0;
		case "queued":
			return 1;
		case "paused":
			return 2;
		case "failed":
			return 3;
		case "complete":
			return 4;
		default:
			return 5;
	}
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
export function runEndedStamp(run: LiveRun): string {
	// Stamp is driven by endedAt presence (a data property), not provenance: a
	// completed owned-async run carries endedAt and should show its end stamp.
	// Running rows (foreground or active async) have no endedAt => "" below.
	// A lost run crashed without writing endedAt; its last heartbeat (lastUpdate) is
	// the best estimate of when it died, so stamp that like any other terminal row
	// instead of leaving the tail to fall back to a frozen elapsed duration.
	const isLost = run.run.state === "lost" || run.run.displayState === "lost";
	const ended = run.run.endedAt ?? (isLost ? run.run.lastUpdate : undefined);
	if (typeof ended !== "number" || !Number.isFinite(ended)) return "";
	const d = new Date(ended);
	const now = new Date();
	const sameDay =
		d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
	const hh = String(d.getHours()).padStart(2, "0");
	const mm = String(d.getMinutes()).padStart(2, "0");
	if (sameDay) return `${hh}:${mm}`;
	const mo = String(d.getMonth() + 1).padStart(2, "0");
	const dd = String(d.getDate()).padStart(2, "0");
	return `${mo}-${dd} ${hh}:${mm}`;
}

type OverlayDisplayRow = DisplayRow | { kind: "empty"; id: "empty" };

function buildPhaseLine(
	theme: Theme,
	row: Extract<DisplayRow, { kind: "phase" }>,
	selected: boolean,
	width: number,
	children: readonly RowState[],
): string {
	const label = row.title ? `Phase ${row.phaseIndex}: ${row.title}` : `Phase ${row.phaseIndex}`;
	const cells: RowCells = {
		state: aggregateState(children),
		name: label,
		depth: row.depth,
		selected,
		...(row.expandable ? { marker: row.collapsed ? "collapsed" : "expanded" } : { stageStrip: [] }),
		badge: !row.expandable && row.planState ? row.planState : `${row.done}/${row.total}`,
	};
	return renderRowLine(theme, cells, width, "dashboard");
}

function childRowStates(
	runs: readonly LiveRun[],
	row: Extract<DisplayRow, { kind: "phase" | "pipelineItem" }>,
): RowState[] {
	return runs
		.filter((child) => {
			if (child.run.parentRunId !== row.workflowId) return false;
			if (row.kind === "pipelineItem") {
				return child.run.pipeline?.id === row.pipelineId && child.run.pipeline.itemIndex === row.itemIndex;
			}
			if (row.title !== undefined) {
				return (
					child.run.phaseTitle !== undefined &&
					canonicalWorkflowPhaseTitle(child.run.phaseTitle) === row.title
				);
			}
			return child.run.phaseIndex === row.phaseIndex;
		})
		.map((child) => cellsFromRunView(child.run, Date.now()).state);
}

function buildPipelineItemLine(
	theme: Theme,
	row: Extract<DisplayRow, { kind: "pipelineItem" }>,
	selected: boolean,
	width: number,
	children: readonly RowState[],
): string {
	const cells: RowCells = {
		state: aggregateState(children),
		name: row.label || `Item ${row.itemIndex + 1}`,
		depth: row.depth,
		selected,
		marker: row.collapsed ? "collapsed" : "expanded",
		badge: `${row.done}/${row.total}`,
	};
	return renderRowLine(theme, cells, width, "dashboard");
}

export function buildLeftLine(
	theme: Theme,
	run: LiveRun,
	selected: boolean,
	now: number,
	width: number,
	depth = 0,
	showCwd = false,
	containerInfo?: ContainerRowInfo,
	pendingDelivery = false,
	suppressPhaseChip = false,
	parallelMarker = false,
): string {
	// Container rows (workflow/parallel groups with visible children) carry a
	// collapse marker instead of a state glyph; the marker's color carries state.
	// A child that finished while its group is still open
	// renders an accent ✓ (done, result not yet delivered to the parent turn)
	// instead of terminal green. Agentless group rows without child rows keep the
	// hollow group marker.
	const cells = cellsFromRunView(run.run, now, {
		depth,
		selected,
		pendingDelivery,
	});
	cells.name = runAgentLabel(run, theme);
	delete cells.nameColor;
	if (containerInfo) cells.marker = containerInfo.collapsed ? "collapsed" : "expanded";
	if (run.run.state === "complete" && run.run.steps.length === 0 && !containerInfo) cells.empty = true;
	cells.parallel = parallelMarker;
	// Terminal runs must not advertise a live phase chip (`streaming Xs`,
	// `tool: bash Xs`). Older status.json files written before the
	// status-writer finalize phase-clear may still carry stale phase fields;
	// suppress here so the seconds counter doesn't keep ticking after
	// `complete`/`failed`/`lost`.
	const isTerminal =
		cells.state === "complete" ||
		cells.state === "failed" ||
		cells.state === "interrupted" ||
		cells.state === "skipped" ||
		cells.state === "lost";
	const phase =
		containerInfo?.phaseChip ||
		(suppressPhaseChip ? "" : workflowPhaseChip(run)) ||
		(isTerminal ? "" : formatPhase(run.run.phase, run.run.phaseStartedAt, now, run.run.currentTool));
	// A lost display state is authoritative over stale on-disk `running`, and its
	// glyph is the only state signal. For live rows without a richer phase chip,
	// keep the coarse activity label; queued and attention rows need no state word.
	const activity =
		!phase && cells.state === "running" && run.run.displayState && run.run.displayState !== "needs_attention"
			? run.run.displayState
			: "";
	cells.phaseChip = phase || activity || undefined;
	// Containers have empty steps[] (state synthesized from children), so the
	// shape badge is computed from the children instead: `2/3` done/total.
	const badge = containerInfo ? `${containerInfo.done}/${containerInfo.total}` : runShapeBadge(run);
	cells.badge = badge || undefined;
	// Don't pre-truncate the label here — the final `truncateToWidth(text, width)`
	// below clips the whole row once at the right edge. Pre-truncating produced
	// `tally-v4-showcase ... ...` style double-ellipsis noise.
	// Collapsed containers summarize their hidden children inline.
	const cwdBadge = runCwdBadge(run, showCwd);
	const labels = [
		run.run.label,
		containerInfo?.collapsed && containerInfo.agentsSummary ? `(${containerInfo.agentsSummary})` : undefined,
		cwdBadge || undefined,
	].filter((part): part is string => part !== undefined);
	cells.label = labels.length > 0 ? labels.join(" · ") : undefined;
	return renderRowLine(theme, cells, width, "dashboard");
}

export class SubagentsStatusComponent implements Component {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly done: () => void;
	private readonly overlay: PaneOverlayComponent;
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
	// Container rows (workflow/parallel groups) the user collapsed; descendants
	// of these are hidden from the visible list. Keyed by run id (not runKey:
	// only async containers are collapsible).
	private collapsedIds = new Set<string>();
	private selectedId?: string;
	private leftScroll = 0;
	private lastRightHeight = MIN_VIEWPORT_HEIGHT;
	private lastRightWidth = 0;
	private lastLeftWidth = 0;
	// Captured at the end of each render so keyboard handlers (j/k/g/G) can
	// scroll the left run list relative to its actual visible window rather than
	// guessing from the right pane's height.
	private lastLeftListHeight = 0;
	private errorMessage?: string;
	private actionNotice?: string;
	private actionNoticeTimer?: ReturnType<typeof setTimeout>;
	private sessionCwd: string | undefined;
	private sessionId: string | undefined;
	private readonly getBranchAnchorRunIds: (() => Set<string>) | undefined;
	private readonly getOwnedRunViews: (() => Map<string, AsyncRunSummary>) | undefined;
	private readonly getLiveSessions: ((runId: string) => LiveDashboardSession[]) | undefined;
	private readonly getLiveToolProgress:
		| ((session: LiveDashboardSession) => ReadonlyMap<string, LiveToolProgress>)
		| undefined;
	private readonly rendererCatalog: { getToolDefinition(name: string): ToolDefinition | undefined } | undefined;
	private readonly runMessageReader: RunMessageReader;
	private readonly selectionSettleMs: number;
	private transcriptLoadTimer: ReturnType<typeof setTimeout> | undefined;
	private transcriptLoadGeneration = 0;
	private readonly settledLiveSelections = new Set<string>();
	private readonly settledPersistedSelections = new Set<string>();
	private readonly livePreviewSessions = new WeakMap<LiveDashboardSession, LiveDashboardSession>();
	private readonly setToolsExpanded: ((expanded: boolean) => void) | undefined;
	private readonly toolsExpandKeys: string[];
	private readonly thinkingToggleKeys: string[];
	private readonly liveSubscriptions = new Map<LiveDashboardSession, () => void>();
	private readonly liveSessionsByRun = new Map<string, LiveDashboardSession[]>();
	private readonly liveRenderCache: LiveSessionRenderCache;
	// The owned-run mirror snapshot for the CURRENT reload pass. Captured once at
	// the top of reload() so the overlay producer and the ownership assignment in
	// deriveLiveRuns agree on the exact same owned set within a pass.
	private ownedViews: Map<string, AsyncRunSummary> = new Map();
	private showAllSessions = false;
	private toolsExpanded = false;
	private hideThinking = false;
	private displayRevision = 0;
	// Charter-style focus: `tab` toggles which pane receives navigation.
	// Left = move selection; right = scroll transcript.
	private focus: "left" | "right" = "left";
	private sidebarCollapsed = false;
	// Split fraction: portion of total width assigned to the left pane. `[` and
	// `]` shift it in SPLIT_STEP_COLS-sized steps; clamped to keep both panes
	// readable. Persists for the lifetime of the overlay instance.
	private splitFraction = DEFAULT_LEFT_FRACTION;

	constructor(tui: TUI, theme: Theme, done: () => void, deps: StatusOverlayDeps = {}) {
		this.tui = tui;
		this.theme = theme;
		this.done = done;
		this.listRunsForOverlay =
			deps.listRunsForOverlay ??
			((limit) => {
				const scope = this.showAllSessions
					? {}
					: {
							...(this.sessionId ? { sessionId: this.sessionId } : { sessionCwd: this.sessionCwd }),
						};
				const owned = this.ownedViews.size > 0 ? this.ownedViews : undefined;
				return expandOverlayByRootRunId(listRunsFromRegistryForOverlay(limit, scope, owned), scope, owned);
			});
		this.listForegroundRuns = deps.listForegroundRuns ?? (() => []);
		this.leftPaneCap = deps.leftPaneCap ?? LEFT_PANE_CAP;
		this.sessionCwd = deps.sessionCwd;
		this.sessionId = deps.sessionId;
		this.getBranchAnchorRunIds = deps.getBranchAnchorRunIds;
		this.getOwnedRunViews = deps.getOwnedRunViews;
		this.getLiveSessions = deps.getLiveSessions;
		this.getLiveToolProgress = deps.getLiveToolProgress;
		this.liveRenderCache = new LiveSessionRenderCache(deps.liveToolComponents);
		this.rendererCatalog = deps.rendererCatalog;
		this.runMessageReader = deps.runMessageReader ?? new RunMessageReader();
		this.selectionSettleMs = deps.selectionSettleMs ?? 50;
		this.setToolsExpanded = deps.setToolsExpanded;
		this.toolsExpandKeys = effectiveKeys(deps.keybindings, "app.tools.expand", "ctrl+o");
		this.thinkingToggleKeys = effectiveKeys(deps.keybindings, "app.thinking.toggle", "ctrl+t");
		try {
			this.toolsExpanded = deps.getToolsExpanded?.() ?? false;
		} catch {
			this.toolsExpanded = false;
		}
		this.refreshMs = deps.refreshMs ?? AUTO_REFRESH_MS;
		this.overlay = this.createPaneOverlay();
		this.reload();
		// Seed the signature so the first timer tick doesn't spuriously diff against
		// undefined; the initial paint is driven by the overlay open, not the timer.
		this.lastRunsSignature = overlayRunsSignature(this.runs, this.selectedId, this.errorMessage);
		this.scheduleRefresh();
	}

	private createPaneOverlay(): PaneOverlayComponent {
		const factory = paneOverlay<void, OverlayDisplayRow>({
			height: (tui) => computeBodyHeight(tui as TUI),
			primary: {
				mode: "cursor",
				rows: () => this.overlayRows(),
				selectionKey: (row) => this.overlayRowKey(row),
				onSelectionChange: (row) => {
					this.selectedId = row && row.kind !== "empty" ? dashboardRowKey(row) : undefined;
					this.scheduleTranscriptLoad();
				},
				renderRow: (row, ctx) => this.renderOverlayPrimaryRow(row, ctx),
				title: () => this.overlayPrimaryTitle(),
				info: (ctx) => {
					const run = this.runForDetailTarget(this.detailTargetForOverlayRow(ctx.selectedRow));
					const width = Math.max(1, ctx.primary.width || this.lastLeftWidth || MIN_LEFT_PANE);
					const lines = run ? buildSelectedRunStatusBox(this.theme, run, width, Date.now()) : [];
					if (this.actionNotice) {
						lines.push(
							this.theme.fg(
								"accent",
								`  ${truncateToWidth(this.actionNotice, Math.max(0, width - 2), "…")}`,
							),
						);
					}
					return lines;
				},
				infoTitle: "",
				footer: (ctx) => {
					const visibleCount = this.displayRows().length;
					const base =
						visibleCount > 0
							? `${ctx.selectedIndex + 1}/${visibleCount}${this.showAllSessions ? "  [all sessions]" : ""}`
							: "(no runs)";
					return base;
				},
			},
			detail: {
				rows: (ctx) => {
					const target = this.detailTargetForOverlayRow(ctx.selectedRow);
					const run = this.runForDetailTarget(target);
					// ctx.detail.width is the overlay's live, drag-adjusted pane width
					// (pi-extension-utils >= 0.5). Using it keeps the detail lines
					// reactive to [ / ] resizes; this.lastRightWidth was computed from
					// the constant DEFAULT_LEFT_FRACTION and went stale after a resize.
					const detailWidth = Math.max(20, ctx.detail.width || this.lastRightWidth || 80);
					const sessions = run ? this.liveSessions(run) : [];
					const selectionKey =
						target?.kind === "run"
							? dashboardRowKey({ kind: "run", run: target.run, depth: 0 })
							: undefined;
					const liveSessions =
						run && selectionKey && !this.settledLiveSelections.has(selectionKey)
							? this.previewLiveSessions(sessions)
							: sessions;
					const cachedHistorical =
						run && sessions.length === 0 && this.rendererCatalog && run.run.asyncDir
							? this.runMessageReader.peek(run.run.asyncDir)
							: undefined;
					const historicalSessions =
						run && sessions.length === 0 && this.rendererCatalog && run.run.asyncDir
							? (cachedHistorical ?? this.runMessageReader.readPreview(run.run.asyncDir))
							: [];
					return run
						? buildRightLines(
								this.theme,
								run,
								detailWidth,
								this.runs,
								{
									sessions: liveSessions,
									tui: this.tui,
									cache: this.liveRenderCache,
									toolProgress: new Map(
										liveSessions.map((session, index) => [
											session,
											this.getLiveToolProgress?.(sessions[index] ?? session) ?? new Map(),
										]),
									),
									display: this.displayMode(),
								},
								this.rendererCatalog
									? {
											sessions: historicalSessions,
											tui: this.tui,
											cache: this.liveRenderCache,
											getToolDefinition: (name) => this.rendererCatalog?.getToolDefinition(name),
											display: this.displayMode(),
											loading:
												cachedHistorical === undefined &&
												(selectionKey === undefined ||
													!this.settledPersistedSelections.has(selectionKey)),
										}
									: undefined,
							)
						: [];
				},
				title: (ctx) => {
					const run = this.runForDetailTarget(this.detailTargetForOverlayRow(ctx.selectedRow));
					if (!run) return "No run selected";
					return this.sidebarCollapsed
						? collapsedRunTitle(run, this.runs, ctx.detail.width)
						: selectedRunTitle(run);
				},
			},
			closeKeys: ["escape", "ctrl+c", "q"],
			bannedKeys: ["b", "r", "p", "c"],
			legendPlacement: "primary",
			perSelectionScroll: true,
			stickyBottom: true,
			// Press 's' to collapse the run list entirely and give the detail pane the
			// full width (and back). Same key + "sidebar" label as the charter picker.
			collapse: {
				key: "s",
				label: "sidebar",
				collapsedWidth: 0,
				horizontalPrimaryNavigation: true,
				horizontalPrimaryNavigationLabel: "agents",
			},
			split: {
				initialFraction: DEFAULT_LEFT_FRACTION,
				minPrimaryWidth: MIN_LEFT_PANE,
				minDetailWidth: MIN_RIGHT_PANE,
				maxPrimaryWidth: this.leftPaneCap,
				stepCols: SPLIT_STEP_COLS,
			},
			customActions: [
				{
					keys: this.toolsExpandKeys,
					label: "tools",
					run: () => this.toggleToolsExpanded(),
				},
				{
					keys: this.thinkingToggleKeys,
					label: "thinking",
					run: () => this.toggleThinking(),
				},
				{
					keys: "y",
					label: "copy id",
					run: (ctx) => this.copySelectedRunId(ctx.selectedRow),
				},
				{
					keys: "f",
					label: "copy dir",
					run: (ctx) => this.copySelectedRunDir(ctx.selectedRow),
				},
				{
					keys: ["return", "o"],
					label: "collapse group",
					run: (ctx) =>
						this.toggleCollapseRow(
							ctx.selectedRow && ctx.selectedRow.kind !== "empty" ? ctx.selectedRow : undefined,
						),
				},
				{
					keys: "a",
					label: "all sessions",
					run: () => {
						this.showAllSessions = !this.showAllSessions;
						this.reload();
					},
				},
			],
		});
		return factory(this.tui, this.theme, undefined, () => this.done()) as PaneOverlayComponent;
	}

	private displayMode() {
		return {
			revision: this.displayRevision,
			toolsExpanded: this.toolsExpanded,
			hideThinking: this.hideThinking,
		};
	}

	private toggleToolsExpanded(): void {
		this.toolsExpanded = !this.toolsExpanded;
		this.displayRevision++;
		this.setToolsExpanded?.(this.toolsExpanded);
		this.tui.requestRender();
	}

	private toggleThinking(): void {
		this.hideThinking = !this.hideThinking;
		this.displayRevision++;
		this.tui.requestRender();
	}

	private overlayRows(): OverlayDisplayRow[] {
		const rows = this.displayRows();
		return rows.length > 0 ? rows : [{ kind: "empty", id: "empty" }];
	}

	private overlayRowKey(row: OverlayDisplayRow): string {
		return row.kind === "empty" ? row.id : dashboardRowKey(row);
	}

	private renderOverlayPrimaryRow(row: OverlayDisplayRow, ctx: PaneOverlayContext<void, OverlayDisplayRow>): string {
		if (row.kind === "empty") return this.theme.fg("dim", "No subagent runs");
		const isSelected = this.overlayRowKey(row) === ctx.selectedKey;
		const showCwd = this.showAllSessions || !(this.sessionId || this.sessionCwd);
		// ctx.primary.width is the overlay's live, drag-adjusted left-pane width
		// (pi-extension-utils >= 0.5). Using it keeps the list rows reactive to
		// [ / ] resizes; this.lastLeftWidth came from the constant DEFAULT_LEFT_FRACTION
		// and went stale after a resize (the same defect fixed for the detail pane).
		const lineWidth = Math.max(20, ctx.primary.width || this.lastLeftWidth || 80);
		if (row.kind === "phase") {
			return buildPhaseLine(this.theme, row, isSelected, lineWidth, childRowStates(this.runs, row));
		}
		if (row.kind === "pipelineItem") {
			return buildPipelineItemLine(this.theme, row, isSelected, lineWidth, childRowStates(this.runs, row));
		}
		if (row.kind === "pipeline") return "";
		const containerInfo = this.containerRowInfo(row.run);
		return buildLeftLine(
			this.theme,
			row.run,
			isSelected,
			Date.now(),
			lineWidth,
			row.depth,
			showCwd,
			containerInfo,
			this.isPendingDelivery(row.run),
			row.suppressPhaseChip,
			row.parallelMarker,
		);
	}

	private overlayPrimaryTitle(): string {
		const scoped = Boolean(this.sessionId || this.sessionCwd);
		const scopeMarker = this.showAllSessions || !scoped ? " · [all sessions]" : "";
		return `Subagent runs · ${this.countAgentRows()} total${scopeMarker}`;
	}

	private detailTargetForOverlayRow(row: OverlayDisplayRow | undefined): DetailTarget | undefined {
		if (!row || row.kind === "empty") return undefined;
		return detailTargetForRow(row, this.runs);
	}

	private runForDetailTarget(target: DetailTarget | undefined): LiveRun | undefined {
		if (!target) return undefined;
		return target.kind === "run" ? target.run : target.workflow;
	}

	private setActionNotice(message: string): void {
		this.actionNotice = message;
		if (this.actionNoticeTimer) clearTimeout(this.actionNoticeTimer);
		this.actionNoticeTimer = setTimeout(() => {
			this.actionNotice = undefined;
			this.actionNoticeTimer = undefined;
			this.tui.requestRender();
		}, ACTION_NOTICE_MS);
		this.tui.requestRender();
	}

	private copySelectedRunId(row: OverlayDisplayRow | undefined): void {
		const run = this.runForDetailTarget(this.detailTargetForOverlayRow(row));
		if (!run) return;
		const id = run.run.id;
		void copyToClipboard(id).then(
			() => this.setActionNotice(`copied id ${id}`),
			(error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				this.setActionNotice(`copy failed: ${message}`);
			},
		);
	}

	private copySelectedRunDir(row: OverlayDisplayRow | undefined): void {
		const run = this.runForDetailTarget(this.detailTargetForOverlayRow(row));
		if (!run) return;
		const dir = run.run.asyncDir ?? run.run.sessionDir;
		if (!dir) {
			this.setActionNotice("no run record dir");
			return;
		}
		const resolved = path.resolve(dir);
		void copyToClipboard(resolved).then(
			() => this.setActionNotice(`copied dir ${resolved}`),
			(error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				this.setActionNotice(`copy failed: ${message}`);
			},
		);
	}

	// render ONLY when the structural signature changed OR a live run still needs
	// its elapsed/spinner label advanced (render-on-diff with a coarse tick for
	// live labels). When nothing is live and nothing changed, the next tick backs
	// off to IDLE_REFRESH_MS; any live run or structural change restores the fast
	// cadence. Tests that inject an explicit refreshMs keep that exact period.
	private scheduleRefresh(): void {
		const hasInjectedPeriod = this.refreshMs !== AUTO_REFRESH_MS;
		this.refreshTimer = setTimeout(
			() => {
				this.reload();
				const signature = overlayRunsSignature(this.runs, this.selectedId, this.errorMessage);
				const changed = signature !== this.lastRunsSignature;
				const hasLive = this.runs.some(runHasLiveLabel);
				this.lastRunsSignature = signature;
				if (changed || hasLive) this.tui.requestRender();
				this.scheduleRefresh();
			},
			hasInjectedPeriod || this.runs.some(runHasLiveLabel) ? this.refreshMs : IDLE_REFRESH_MS,
		);
		this.refreshTimer.unref?.();
	}

	private reload(): void {
		const previousSelection = this.selectedId;
		try {
			// Snapshot the registry memory mirror ONCE per pass: the overlay producer
			// memory-resolves owned leaves and deriveLiveRuns stamps ownership:'live'
			// for the same ids. After a reload the registry is empty => map empty =>
			// every run hydrates foreign-from-disk (today's behavior).
			this.ownedViews = this.getOwnedRunViews?.() ?? new Map();
			const overlay = this.listRunsForOverlay();
			const sync = this.listForegroundRuns();
			this.runs = deriveLiveRuns(overlay, sync, {
				showAllSessions: this.showAllSessions,
				sessionId: this.sessionId,
				sessionCwd: this.sessionCwd,
				branchAnchorIds: this.getBranchAnchorRunIds?.(),
				ownedIds: new Set(this.ownedViews.keys()),
			});
			this.errorMessage = undefined;
		} catch (error) {
			this.runs = [];
			this.errorMessage = error instanceof Error ? error.message : String(error);
		}
		this.reconcileSelection();
		const selectedLiveSessionsChanged = this.reconcileLiveSubscriptions();
		if (this.selectedId !== previousSelection || selectedLiveSessionsChanged) this.scheduleTranscriptLoad();
	}

	// Visible only to tests; mirrors the `a` keybinding for direct invocation.
	setShowAllSessions(value: boolean): void {
		this.showAllSessions = value;
		this.reload();
	}

	private reconcileSelection(): void {
		const visible = this.displayRows();
		if (visible.length === 0) {
			this.selectedId = undefined;
			this.leftScroll = 0;
			return;
		}
		const stillHere =
			this.selectedId !== undefined && visible.some((row) => dashboardRowKey(row) === this.selectedId);
		if (!stillHere) {
			this.selectedId = dashboardRowKey(visible[0]!);
		}
		this.ensureSelectionVisible();
	}

	private displayRows(): DisplayRow[] {
		return deriveDisplayRows(this.runs, this.collapsedIds);
	}

	/** Toggle collapse on the selected container row (enter). No-op on leaf rows. */
	private toggleCollapse(): void {
		this.toggleCollapseRow(this.selectedRow());
	}

	private toggleCollapseRow(row: DisplayRow | undefined): void {
		if (!row) return;
		let id: string | undefined;
		if (row.kind === "phase") {
			if (!row.expandable) return;
			id = dashboardRowKey(row);
		} else if (row.kind === "pipeline" || row.kind === "pipelineItem") id = dashboardRowKey(row);
		else if (row.run.run.workflow === true && deriveIsGroupContainerRow(this.runs, row.run)) {
			id = dashboardRowKey(row);
		}
		if (!id) return;
		if (this.collapsedIds.has(id)) this.collapsedIds.delete(id);
		else this.collapsedIds.add(id);
		this.ensureSelectionVisible();
		this.tui.requestRender();
	}

	private selectedIndex(): number {
		const visible = this.displayRows();
		if (visible.length === 0) return -1;
		const id = this.selectedId;
		const index = id !== undefined ? visible.findIndex((row) => dashboardRowKey(row) === id) : -1;
		return index === -1 ? 0 : index;
	}

	private selectedRow(): DisplayRow | undefined {
		const index = this.selectedIndex();
		return index >= 0 ? this.displayRows()[index] : undefined;
	}

	private selectedRun(): LiveRun | undefined {
		const row = this.selectedRow();
		if (!row) return undefined;
		const target = detailTargetForRow(row, this.runs);
		return target?.kind === "run" ? target.run : undefined;
	}

	/** Count of actual agent runs for the header label. A parallel/workflow GROUP
	 * is a container, not an agent: when its leaf children are present as their own
	 * rows, the container row itself must not be tallied (otherwise a 2-agent
	 * parallel fan-out reads as "3 total"). A real agent that happens to have spawned
	 * sub-agents (mode "single" with children) is still a genuine agent and counts. */
	private countAgentRows(): number {
		return deriveCountAgentRows(this.runs);
	}

	private isGroupContainerRow(run: LiveRun): boolean {
		return deriveIsGroupContainerRow(this.runs, run);
	}

	private containerRowInfo(run: LiveRun): ContainerRowInfo | undefined {
		return deriveContainerRowInfo(this.runs, this.collapsedIds, run);
	}

	private isPendingDelivery(run: LiveRun): boolean {
		return deriveIsPendingDelivery(this.runs, run);
	}

	private ensureSelectionVisible(): void {
		const index = this.selectedIndex();
		if (index < 0) return;
		// The left list shares the body with the legend block; use the actual list
		// height captured at last render so j/k/G/g keep the selection in view
		// instead of letting it scroll behind the legend or off the bottom.
		const listHeight = this.lastLeftListHeight || computeBodyHeight(this.tui);
		const state = ensurePaneCursorVisible({
			cursor: index,
			scroll: this.leftScroll,
			itemCount: this.displayRows().length,
			viewportHeight: listHeight,
		});
		this.leftScroll = state.scroll;
	}

	private applySelectionState(state: { cursor: number; scroll: number }): void {
		const visible = this.displayRows();
		if (visible.length === 0) return;
		this.selectedId = dashboardRowKey(visible[state.cursor]!);
		this.leftScroll = state.scroll;
	}

	private moveSelection(delta: number): void {
		const visible = this.displayRows();
		if (visible.length === 0) return;
		const listHeight = this.lastLeftListHeight || computeBodyHeight(this.tui);
		this.applySelectionState(
			moveCursor(
				{
					cursor: this.selectedIndex(),
					scroll: this.leftScroll,
					itemCount: visible.length,
					viewportHeight: listHeight,
				},
				delta,
			),
		);
		this.tui.requestRender();
	}

	private jumpSelection(toEnd: boolean): void {
		const visible = this.displayRows();
		if (visible.length === 0) return;
		const listHeight = this.lastLeftListHeight || computeBodyHeight(this.tui);
		const state = {
			cursor: this.selectedIndex(),
			scroll: this.leftScroll,
			itemCount: visible.length,
			viewportHeight: listHeight,
		};
		this.applySelectionState(toEnd ? endCursor(state) : homeCursor(state));
		this.tui.requestRender();
	}

	/** Move the left-pane selection by a viewport page (PageUp/PageDown, and u/d
	 * when the left pane is focused). Page size is the list height captured at the
	 * last render so it matches what the user actually sees. */
	private pageSelection(direction: 1 | -1, fraction = 1): void {
		const visible = this.displayRows();
		if (visible.length === 0) return;
		const page = this.lastLeftListHeight || computeBodyHeight(this.tui);
		const step = Math.max(1, Math.floor(page * fraction));
		this.applySelectionState(
			pageCursor(
				{
					cursor: this.selectedIndex(),
					scroll: this.leftScroll,
					itemCount: visible.length,
					viewportHeight: page,
				},
				direction,
				step,
			),
		);
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (data === "q" || data === "\u001b" || data === "\u0003") {
			this.done();
			return;
		}
		if (data === "s") {
			this.overlay.handleInput(data);
			this.sidebarCollapsed = !this.sidebarCollapsed;
			if (!this.sidebarCollapsed) {
				// paneOverlay keeps detail focus when expanding; this dashboard treats
				// reopening the sidebar as an explicit return to the run list.
				this.focus = "left";
				this.overlay.handleInput("\t");
			}
			return;
		}
		if (data === "\t" || (!this.sidebarCollapsed && (data === "\u001b[D" || data === "\u001b[C"))) {
			this.focus = togglePaneFocus(this.focus);
		}
		this.overlay.handleInput(data);
	}

	private shiftSplit(direction: -1 | 1): void {
		const cols = this.tui.terminal?.columns ?? process.stdout.columns ?? 120;
		const currentLeft = this.computeLeftWidth(cols);
		const next = resizeSplitPane({
			totalWidth: cols,
			leftFraction: this.splitFraction,
			minLeftWidth: MIN_LEFT_PANE,
			minRightWidth: MIN_RIGHT_PANE,
			leftMaxWidth: this.leftPaneCap,
			direction,
			stepCols: SPLIT_STEP_COLS,
		});
		if (next.leftWidth === currentLeft) {
			return;
		}
		this.splitFraction = next.leftFraction;
		this.tui.requestRender();
	}

	private computeLeftWidth(totalWidth: number): number {
		return computeSplitPaneLayout({
			totalWidth,
			leftFraction: this.splitFraction,
			minLeftWidth: MIN_LEFT_PANE,
			minRightWidth: MIN_RIGHT_PANE,
			leftMaxWidth: this.leftPaneCap,
		}).leftWidth;
	}

	invalidate(): void {
		// paneOverlay resolves rows lazily during render; the dashboard's existing
		// refresh timer calls requestRender when data changes.
	}

	render(width: number): string[] {
		const w = Math.max(8, width);
		const layout = computeSplitPaneLayout({
			totalWidth: w,
			leftFraction: DEFAULT_LEFT_FRACTION,
			minLeftWidth: MIN_LEFT_PANE,
			minRightWidth: MIN_RIGHT_PANE,
			leftMaxWidth: this.leftPaneCap,
		});
		this.lastLeftWidth = layout.leftWidth;
		this.lastRightWidth = Math.max(MIN_RIGHT_PANE, layout.rightWidth);
		this.lastRightHeight = computeBodyHeight(this.tui);
		const statusBoxRows = (this.selectedRun() ? SELECTED_STATUS_BOX_ROWS : 0) + (this.actionNotice ? 1 : 0);
		this.lastLeftListHeight = Math.max(1, this.lastRightHeight - 9 - statusBoxRows);
		return this.overlay.render(width);
	}

	private liveSessions(run: LiveRun): LiveDashboardSession[] {
		return this.liveSessionsByRun.get(run.run.id) ?? [];
	}

	private previewLiveSessions(sessions: LiveDashboardSession[]): LiveDashboardSession[] {
		return sessions.map((session, index) => {
			let preview = this.livePreviewSessions.get(session);
			if (!preview) {
				preview = {
					stepIndex: session.stepIndex ?? index,
					messages: this.tailLiveMessages(session.messages),
					cacheKey: session,
					getToolDefinition: session.getToolDefinition,
					subscribe: (listener) => session.subscribe(listener),
				};
				this.livePreviewSessions.set(session, preview);
			}
			return preview;
		});
	}

	private tailLiveMessages(messages: LiveDashboardSession["messages"]): LiveDashboardSession["messages"] {
		const groups: Array<LiveDashboardSession["messages"]> = [];
		for (let index = 0; index < messages.length; index++) {
			const message = messages[index]!;
			const group = [message];
			if (message.role === "assistant") {
				const toolCallIds = new Set(
					message.content.filter((content) => content.type === "toolCall").map((content) => content.id),
				);
				while (toolCallIds.size > 0 && index + 1 < messages.length) {
					const result = messages[index + 1]!;
					if (result.role !== "toolResult" || !toolCallIds.has(result.toolCallId)) break;
					group.push(result);
					toolCallIds.delete(result.toolCallId);
					index++;
				}
			}
			groups.push(group);
		}
		return groups.slice(-12).flat();
	}

	private scheduleTranscriptLoad(): void {
		if (this.transcriptLoadTimer) clearTimeout(this.transcriptLoadTimer);
		this.transcriptLoadTimer = undefined;
		const selection = this.selectedId;
		const generation = ++this.transcriptLoadGeneration;
		if (!selection) return;
		this.settledPersistedSelections.delete(selection);
		this.transcriptLoadTimer = setTimeout(() => {
			this.transcriptLoadTimer = undefined;
			if (generation !== this.transcriptLoadGeneration || this.selectedId !== selection) return;
			const row = this.selectedRow();
			if (!row || dashboardRowKey(row) !== selection) return;
			const target = detailTargetForRow(row, this.runs);
			if (target?.kind !== "run") return;
			const run = target.run;
			const sessions = this.liveSessions(run);
			if (sessions.length > 0) this.settledLiveSelections.add(selection);
			else if (run.run.asyncDir) {
				this.runMessageReader.read(run.run.asyncDir);
				this.settledPersistedSelections.add(selection);
			}
			if (generation === this.transcriptLoadGeneration && this.selectedId === selection) this.tui.requestRender();
		}, this.selectionSettleMs);
		this.transcriptLoadTimer.unref?.();
	}

	private unsubscribeFromLiveSessions(): void {
		for (const [session, unsubscribe] of this.liveSubscriptions) {
			unsubscribe();
			this.liveRenderCache.clear(session);
		}
		this.liveSubscriptions.clear();
		this.liveSessionsByRun.clear();
	}

	private subscribeToLiveSession(session: LiveDashboardSession): void {
		let active = true;
		const unsubscribe = session.subscribe((event) => {
			if (!active) return;
			const preview = this.livePreviewSessions.get(session);
			if (preview)
				this.livePreviewSessions.set(session, {
					...preview,
					messages: this.tailLiveMessages(session.messages),
				});
			this.liveRenderCache.invalidate(session, event);
			if (preview) this.liveRenderCache.invalidate(preview, event);
			const selectedRun = this.selectedRun();
			if (selectedRun && this.liveSessions(selectedRun).includes(session)) this.tui.requestRender();
		});
		this.liveSubscriptions.set(session, () => {
			active = false;
			unsubscribe();
		});
	}

	private reconcileLiveSubscriptions(): boolean {
		const listedRunIds = new Set(this.runs.map((run) => run.run.id));
		const nextSessions = new Set<LiveDashboardSession>();
		const selectedRunId = this.selectedRun()?.run.id;
		let selectedSessionsChanged = false;
		for (const runId of listedRunIds) {
			let sessions: LiveDashboardSession[];
			try {
				sessions = this.getLiveSessions?.(runId) ?? [];
			} catch {
				sessions = this.liveSessionsByRun.get(runId) ?? [];
			}
			const previous = this.liveSessionsByRun.get(runId) ?? [];
			this.liveSessionsByRun.set(runId, sessions);
			if (
				runId === selectedRunId &&
				(previous.length !== sessions.length || previous.some((session, index) => session !== sessions[index]))
			)
				selectedSessionsChanged = true;
			for (const session of sessions) {
				nextSessions.add(session);
				if (!this.liveSubscriptions.has(session)) this.subscribeToLiveSession(session);
			}
		}
		for (const runId of this.liveSessionsByRun.keys()) {
			if (!listedRunIds.has(runId)) this.liveSessionsByRun.delete(runId);
		}
		for (const [session, unsubscribe] of this.liveSubscriptions) {
			if (nextSessions.has(session)) continue;
			unsubscribe();
			this.liveSubscriptions.delete(session);
			this.liveRenderCache.clear(session);
		}
		return selectedSessionsChanged;
	}

	dispose(): void {
		this.transcriptLoadGeneration++;
		if (this.transcriptLoadTimer) clearTimeout(this.transcriptLoadTimer);
		this.transcriptLoadTimer = undefined;
		this.unsubscribeFromLiveSessions();
		this.liveRenderCache.dispose();
		if (this.refreshTimer) clearTimeout(this.refreshTimer);
		this.refreshTimer = undefined;
		if (this.actionNoticeTimer) clearTimeout(this.actionNoticeTimer);
		this.actionNoticeTimer = undefined;
		this.overlay.dispose();
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Right-pane top-border label helpers — keep the chrome title in sync with the
// currently selected run so users always know what the transcript belongs to.
// ─────────────────────────────────────────────────────────────────────────────

function selectedRunTitle(run: LiveRun): string {
	if (run.run.label) return run.run.label;
	// Title from the live currentAgent when present (foreground-only field), NOT by
	// provenance. Owned-async runs carry no currentAgent and title from their steps
	// (workflow/step logic below) like any disk run.
	if (run.run.currentAgent) {
		return run.run.currentAgent;
	}
	if (run.run.workflow) return workflowDisplayName(run.run.workflowMeta);
	const running = run.run.steps?.find((s) => s.status === "running");
	const step = running ?? run.run.steps?.[0];
	return step?.agent ?? run.run.mode ?? "(run)";
}

function runAgentColor(run: LiveRun): string | undefined {
	if (run.run.currentAgent) {
		return run.run.currentAgentColor ?? colorForAgentName(run.run.currentAgent);
	}
	const step = run.run.steps.find((candidate) => candidate.status === "running") ?? run.run.steps[0];
	return step?.color ?? (step?.agent ? colorForAgentName(step.agent) : undefined);
}

function collapsedRunTitle(run: LiveRun, runs: LiveRun[], width: number) {
	const labelBudget = Math.max(0, width - 3);
	const currentPlain = truncateToWidth(selectedRunTitle(run), labelBudget, "");
	const currentRendered = tintAgentName(currentPlain, runAgentColor(run));
	const parentId = parentRunIdOf(run);
	const parent = parentId ? runs.find((candidate) => candidate.run.id === parentId) : undefined;
	const separator = " › ";
	const parentBudget = labelBudget - visibleWidth(currentPlain) - visibleWidth(separator);
	if (!parent || parentBudget <= 0) {
		return { label: currentPlain, labelPlain: currentPlain, labelRendered: currentRendered };
	}

	const parentPlain = truncateToWidth(selectedRunTitle(parent), parentBudget, "");
	const parentRendered = tintAgentName(parentPlain, runAgentColor(parent));
	const labelPlain = `${parentPlain}${separator}${currentPlain}`;
	return {
		label: labelPlain,
		labelPlain,
		labelRendered: `${parentRendered}${separator}${currentRendered}`,
	};
}

type ThemeFg = Parameters<Theme["fg"]>[0];

function selectedRunStatusColor(run: LiveRun): ThemeFg {
	if (run.run.displayState === "lost") return "error";
	if (run.run.displayState === "needs_attention" || run.run.activityState === "needs_attention") return "warning";
	switch (run.run.state) {
		case "running":
			return "accent";
		case "complete":
			return "success";
		case "failed":
		case "lost":
			return "error";
		case "paused":
		case "interrupted":
			return "warning";
		case "queued":
		case "skipped":
			return "dim";
	}
}

function runTokenTotal(run: LiveRun): number {
	if (run.run.totalTokens) return run.run.totalTokens.total;
	return run.run.steps.reduce((sum, step) => sum + (step.tokens?.total ?? 0), 0);
}

function runDurationMs(run: LiveRun, now: number): number {
	const end = run.run.endedAt ?? now;
	return Math.max(0, end - (run.run.executionStartedAt ?? run.run.startedAt));
}

function runIsLost(run: LiveRun): boolean {
	return run.run.state === "lost" || run.run.displayState === "lost";
}

function runToolCount(run: LiveRun): number {
	if (run.run.asyncDir) return readRunTranscript(run.run.asyncDir).filter((event) => event.kind === "tool").length;
	return run.run.recentTools?.length ?? 0;
}

const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatStartedTime(ms: number, now: number): string {
	const date = new Date(ms);
	const today = new Date(now);
	const hours = date.getHours().toString().padStart(2, "0");
	const minutes = date.getMinutes().toString().padStart(2, "0");
	const time = `${hours}:${minutes}`;
	if (
		date.getFullYear() === today.getFullYear() &&
		date.getMonth() === today.getMonth() &&
		date.getDate() === today.getDate()
	) {
		return time;
	}
	return `${MONTH_LABELS[date.getMonth()] ?? ""} ${date.getDate()} ${time}`;
}

function clipPlain(text: string, width: number): string {
	return truncateToWidth(text, Math.max(0, width), "…").replace(/\x1b\[[0-9;]*m/g, "");
}

function renderStatusBoxHeader(theme: Theme, width: number, name: string, tail: string, color: ThemeFg): string {
	const availableText = Math.max(0, width - 3);
	let tailText = tail;
	let nameText = name;
	if (visibleWidth(nameText) + visibleWidth(tailText) > availableText) {
		const tailBudget = Math.min(visibleWidth(tailText), Math.max(0, Math.floor(availableText / 2)));
		tailText = clipPlain(tailText, tailBudget);
		nameText = clipPlain(nameText, Math.max(0, availableText - visibleWidth(tailText)));
	}
	const gap = Math.max(1, width - visibleWidth(nameText) - visibleWidth(tailText));
	const line = `${theme.fg(color, nameText)}${" ".repeat(gap)}${theme.fg(color, tailText)}`;
	return truncateToWidth(line, width, "");
}

function renderStatusBoxLine(theme: Theme, width: number, text: string): string {
	return theme.fg("dim", `  ${clipPlain(text, Math.max(0, width - 2))}`);
}

function selectedRunCurrentLine(run: LiveRun, now: number): string | undefined {
	if (runIsLost(run)) return undefined;
	const phase = formatPhase(run.run.phase, run.run.phaseStartedAt, now, run.run.currentTool);
	if (phase) return `now ${phase}`;
	if (!run.run.currentTool) return undefined;
	const duration =
		run.run.currentToolStartedAt !== undefined
			? ` ${formatDuration(Math.max(0, now - run.run.currentToolStartedAt))}`
			: "";
	return `now tool: ${run.run.currentTool}${duration}`;
}

function metaFits(width: number, text: string): boolean {
	return visibleWidth(`  ${text}`) <= width;
}

function wrapPlainStatusText(text: string, width: number, maxLines: number): string[] {
	if (maxLines <= 0) return [];
	const textWidth = Math.max(1, width - 2);
	const lines: string[] = [];
	for (let offset = 0; offset < text.length && lines.length < maxLines; offset += textWidth) {
		lines.push(text.slice(offset, offset + textWidth));
	}
	return lines;
}

function selectedRunMetaLines(run: LiveRun, width: number, now: number, maxLines: number): string[] {
	if (maxLines <= 0) return [];
	const started = formatStartedTime(run.run.startedAt, now);
	const combined = `${run.run.mode} · id ${run.run.id} · started ${started}`;
	if (metaFits(width, combined)) return [combined];
	const lines = [`${run.run.mode} · started ${started}`];
	lines.push(...wrapPlainStatusText(`id ${run.run.id}`, width, maxLines - 1));
	return lines;
}

export function buildSelectedRunStatusBox(
	theme: Theme,
	run: LiveRun,
	width: number,
	now: number = Date.now(),
): string[] {
	const boxWidth = Math.max(8, width);
	const durationMs = runDurationMs(run, now);
	const color = selectedRunStatusColor(run);
	const lostStamp = runIsLost(run) ? runEndedStamp(run) : "";
	const durationLabel = lostStamp ? lostStamp : formatDuration(durationMs);
	const tail = `${run.run.displayState ?? run.run.state} · ${durationLabel}`;
	const stats: string[] = [];
	const tools = runToolCount(run);
	if (tools > 0) stats.push(`${tools} tool${tools === 1 ? "" : "s"}`);
	const tokens = runTokenTotal(run);
	if (tokens > 0) stats.push(formatTokenCounter(tokens));
	if (!lostStamp) stats.push(formatDuration(durationMs));
	const lines = [renderStatusBoxHeader(theme, boxWidth, selectedRunTitle(run), tail, color)];
	if (stats.length > 0) lines.push(renderStatusBoxLine(theme, boxWidth, stats.join(" · ")));
	const current = selectedRunCurrentLine(run, now);
	if (current) lines.push(renderStatusBoxLine(theme, boxWidth, current));
	for (const meta of selectedRunMetaLines(run, boxWidth, now, SELECTED_STATUS_BOX_ROWS - lines.length)) {
		lines.push(renderStatusBoxLine(theme, boxWidth, meta));
	}
	return lines.slice(0, SELECTED_STATUS_BOX_ROWS);
}

function selectedRunTailPlain(run: LiveRun): string {
	const state = run.run.state ?? "";
	const tool = run.run.currentTool ? ` · ${run.run.currentTool}` : "";
	return state || tool ? `[${state}]${tool}` : "";
}

function selectedRunTailRendered(theme: Theme, run: LiveRun): string {
	const state = run.run.state ?? "";
	const stateColor =
		state === "running"
			? "accent"
			: state === "failed" || state === "lost"
				? "error"
				: state === "complete"
					? "success"
					: "dim";
	const parts = [theme.fg(stateColor, `[${state}]`)];
	if (run.run.currentTool) parts.push(theme.fg("muted", run.run.currentTool));
	return parts.join(theme.fg("dim", " · "));
}
