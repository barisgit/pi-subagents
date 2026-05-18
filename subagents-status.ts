import { spawn } from "node:child_process";
import * as path from "node:path";
import { colorForAgentName } from "./agents.ts";
import type { Theme } from "@mariozechner/pi-coding-agent";
import type { Component, TUI } from "@mariozechner/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { type AsyncRunOverlayData, type AsyncRunSummary, listAsyncRunsForOverlay, sortRuns } from "./async-status.ts";
import { readEventLog } from "./events-log.ts";
import { formatDuration } from "./formatters.ts";
import { findInlineChildRun, multiSpinnerFrame, renderNestedChild, tintAgentName } from "./render.ts";
import { deriveRunDisplayState, displayStatePriority } from "./run-liveness.ts";
import { flatRule, formatScrollInfo, padRight, titledBottomSegment, titledTopSegment } from "./render-helpers.ts";
import { describeAgentLabel, formatShapeBadge } from "./run-shape.ts";
import { ASYNC_DIR, type ActivityState, type RunDisplayState, type SubagentState } from "./types.ts";

const AUTO_REFRESH_MS = 1000;
const RECENT_LIMIT = 20;
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
	["PgUp/PgDn", "page right"],
	["u / d",     "half page up / down"],
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
	// charter nested-subagent-display: live sync hierarchy parent link.
	parentRunId?: string;
	state: "running";
	activityState?: ActivityState;
	displayState?: RunDisplayState;
	lastActivityAt?: number;
	currentTool?: string;
	currentToolStartedAt?: number;
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
	listRunsForOverlay?: (asyncDirRoot: string, recentLimit?: number) => AsyncRunOverlayData;
	listForegroundRuns?: () => ForegroundRunSummary[];
	refreshMs?: number;
	leftPaneCap?: number;
	sessionCwd?: string;
}

// Decides whether a run belongs to the current session. Sync runs always belong
// to the current session (they share the in-process cwd). Async runs are
// included only when their recorded cwd matches sessionCwd; unknown cwd is
// conservatively hidden in scoped mode.
export function runMatchesSession(run: LiveRun, sessionCwd: string | undefined): boolean {
	if (!sessionCwd) return true;
	if (run.source === "sync") return true;
	const runCwd = run.run.cwd;
	if (!runCwd) return false;
	return runCwd === sessionCwd;
}

export function foregroundRunsFromState(state: Pick<SubagentState, "foregroundControls"> & { baseCwd?: string }): ForegroundRunSummary[] {
	return Array.from(state.foregroundControls.values())
		.map((control: ForegroundControl) => {
			const displayState = deriveRunDisplayState({
				state: "running",
				activityState: control.currentActivityState,
				currentTool: control.currentTool,
				lastActivityAt: control.lastActivityAt,
				lastUpdate: control.updatedAt,
			});
			return {
				id: control.runId,
				...(control.parentRunId ? { parentRunId: control.parentRunId } : {}),
				state: "running" as const,
				...(control.currentActivityState ? { activityState: control.currentActivityState } : {}),
				...(displayState ? { displayState } : {}),
			...(control.lastActivityAt !== undefined ? { lastActivityAt: control.lastActivityAt } : {}),
			...(control.currentTool ? { currentTool: control.currentTool } : {}),
			...(control.currentToolStartedAt !== undefined ? { currentToolStartedAt: control.currentToolStartedAt } : {}),
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
function runShapeBadge(run: LiveRun): string {
	if (run.source === "sync") return "";
	const total = run.run.steps.length;
	// Parallel progress uses done-count; chain progress uses 1-based current step.
	const current = run.run.mode === "parallel"
		? run.run.steps.filter((s) => s.status === "complete" || s.status === "failed" || s.status === "skipped").length
		: (run.run.currentStep ?? 0) + 1;
	return formatShapeBadge({ mode: run.run.mode, total, current });
}

function runElapsed(run: LiveRun, now: number): string {
	// Terminal runs (lost/complete/failed) must not keep ticking. lost runs have no
	// endedAt because the child crashed without writing one, so fall back to lastUpdate.
	if (run.source === "async") {
		if (run.run.endedAt) return formatDuration(Math.max(0, run.run.endedAt - run.run.startedAt));
		if (run.run.state === "lost" || run.run.state === "complete" || run.run.state === "failed") {
			const frozen = run.run.lastUpdate ?? run.run.startedAt;
			return formatDuration(Math.max(0, frozen - run.run.startedAt));
		}
	}
	return formatDuration(Math.max(0, now - run.run.startedAt));
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
	return [...runs].sort((a, b) => {
		const displayA = displayStatePriority(a.run.displayState ?? (a.run.activityState === "needs_attention" ? "needs_attention" : undefined));
		const displayB = displayStatePriority(b.run.displayState ?? (b.run.activityState === "needs_attention" ? "needs_attention" : undefined));
		if (displayA !== displayB) return displayA - displayB;
		return b.run.startedAt - a.run.startedAt;
	});
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
	const out: LiveRun[] = [];
	const visit = (run: LiveRun) => {
		out.push(run);
		for (const child of byParent.get(run.run.id) ?? []) visit(child);
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
	const ended = run.run.endedAt;
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

function buildLeftLine(theme: Theme, run: LiveRun, selected: boolean, now: number, width: number, depth = 0, showCwd = false): string {
	const cursor = selected ? theme.fg("accent", "> ") : "  ";
	// charter nested-subagent-display: indent between cursor and glyph keeps cursor aligned.
	const indent = depth > 0 ? theme.fg("dim", `${"  ".repeat(Math.max(0, depth - 1))}└─`) : "";
	const glyph = statusGlyph(theme, run.run.state, run.run.activityState, run.run.displayState);
	const agent = runAgentLabel(run, theme);
	const status = run.run.displayState ? `${run.run.state}/${run.run.displayState}` : run.run.state;
	const elapsed = runElapsed(run, now);
	const dateStamp = runEndedStamp(run);
	const badge = runShapeBadge(run);
	const badgePart = badge ? ` · ${theme.fg("dim", badge)}` : "";
	// Don't pre-truncate the label here — the final `truncateToWidth(text, width)`
	// below clips the whole row once at the right edge. Pre-truncating produced
	// `tally-v4-showcase ... ...` style double-ellipsis noise.
	const labelPart = run.run.label
		? ` · ${theme.fg("muted", run.run.label)}`
		: "";
	const cwdBadge = runCwdBadge(run, showCwd);
	const cwdPart = cwdBadge ? ` · ${theme.fg("dim", cwdBadge)}` : "";
	// Elapsed for active runs (`5.2s`), date stamp for terminated runs (`HH:MM`
	// or `MM-DD HH:MM`). Both never apply to the same row.
	const tail = dateStamp ? ` · ${theme.fg("dim", dateStamp)}` : ` · ${elapsed}`;
	const text = `${cursor}${indent}${glyph} ${agent} · ${status}${badgePart}${labelPart}${cwdPart}${tail}`;
	// Hard-clip with no ellipsis — the row already ends at the pane border, so an
	// ellipsis adds zero information and steals 1–3 columns of label space.
	return truncateToWidth(text, width, "");
}

export function buildRightLines(theme: Theme, run: LiveRun | undefined, width: number): string[] {
	if (!run) return [theme.fg("dim", "(no events yet)")];
	// charter nested-subagent-display: sync runs persist events under ASYNC_DIR/<runId>.
	const asyncDir = run.source === "sync" ? path.join(ASYNC_DIR, run.run.id) : run.run.asyncDir;
	const events = readEventLog(asyncDir);
	if (events.length === 0) return [theme.fg("dim", "(no events yet)")];
	// Shared set so each nested child run is rendered at most once across all steps.
	const rightPaneUsed = new Set<string>();

	// Parallel runs share one events.jsonl with N children writing concurrently,
	// each tagged with its own stepIndex. Render order chronological-within-step
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
			const argsPart = event.argsPreview ? ` ${event.argsPreview}` : "";
			const base = `→ ${event.toolName}${argsPart}`;
			if (event.durationMs !== undefined) {
				const suffix = ` · ${event.durationMs}ms`;
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
	private readonly listRunsForOverlay: (asyncDirRoot: string, recentLimit?: number) => AsyncRunOverlayData;
	private readonly listForegroundRuns: () => ForegroundRunSummary[];
	private readonly leftPaneCap: number;
	private readonly refreshTimer: NodeJS.Timeout;
	private runs: LiveRun[] = [];
	private selectedId?: string;
	private leftScroll = 0;
	private rightScroll = new Map<string, ScrollState>();
	private lastRightHeight = MIN_VIEWPORT_HEIGHT;
	private lastRightWidth = 0;
	private errorMessage?: string;
	private sessionCwd: string | undefined;
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
		this.listRunsForOverlay = deps.listRunsForOverlay ?? listAsyncRunsForOverlay;
		this.listForegroundRuns = deps.listForegroundRuns ?? (() => []);
		this.leftPaneCap = deps.leftPaneCap ?? LEFT_PANE_CAP;
		this.sessionCwd = deps.sessionCwd;
		const refreshMs = deps.refreshMs ?? AUTO_REFRESH_MS;
		this.reload();
		this.refreshTimer = setInterval(() => {
			this.reload();
			this.tui.requestRender();
		}, refreshMs);
		this.refreshTimer.unref?.();
	}

	private reload(): void {
		try {
			const overlay = this.listRunsForOverlay(ASYNC_DIR, RECENT_LIMIT);
			const sync = this.listForegroundRuns();
			const syncIds = new Set(sync.map((run) => run.id));
			// charter nested-subagent-display: prefer in-memory sync rows while disk mirrors exist.
			const combined = [...overlay.active, ...overlay.recent].filter((run) => !syncIds.has(run.id));
			this.runs = sortLiveRuns(sync, combined);
			if (!this.showAllSessions && this.sessionCwd) {
				this.runs = this.runs.filter((r) => runMatchesSession(r, this.sessionCwd));
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

	private ensureSelectionVisible(): void {
		const index = this.selectedIndex();
		if (index < 0) return;
		if (index < this.leftScroll) this.leftScroll = index;
		const bodyHeight = this.lastRightHeight || computeBodyHeight(this.tui);
		const limit = this.leftScroll + bodyHeight;
		if (index >= limit) this.leftScroll = index - bodyHeight + 1;
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
		const lines = buildRightLines(this.theme, run, this.lastRightWidth || 80);
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
		const run = this.selectedRun();
		if (!run || run.source !== "async") return;
		const file = run.run.sessionFile;
		if (!file) return;
		const editor = process.env.EDITOR || "vi";
		try {
			spawn(editor, [file], { stdio: "inherit", detached: true }).unref();
		} catch {
			// Best-effort open; ignore failures so the overlay keeps responding.
		}
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
			this.scrollRightByPage(1);
			return;
		}
		if (matchesKey(data, "pageUp")) {
			this.scrollRightByPage(-1);
			return;
		}
		if (matchesKey(data, "d") || matchesKey(data, "space")) {
			this.scrollRight(Math.max(1, Math.floor(this.lastRightHeight / 2)));
			return;
		}
		if (matchesKey(data, "u") || matchesKey(data, "shift+space")) {
			this.scrollRight(-Math.max(1, Math.floor(this.lastRightHeight / 2)));
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
		const scopeMarker = this.showAllSessions || !this.sessionCwd ? " · [all sessions]" : "";
		const leftLabel = `Subagent runs · ${this.runs.length} total${scopeMarker}`;
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

	render(width: number): string[] {
		const w = Math.max(8, width);
		const leftWidth = this.computeLeftWidth(w);
		const rightWidth = Math.max(MIN_RIGHT_PANE, w - 3 - leftWidth);
		this.lastRightWidth = rightWidth;

		const now = Date.now();
		const showCwd = this.showAllSessions || !this.sessionCwd;
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
		const rightLines = buildRightLines(this.theme, selected, rightWidth);

		const bodyHeight = computeBodyHeight(this.tui);
		this.lastRightHeight = bodyHeight;

		// Left pane is split vertically: top = run list, bottom = legend section.
		// Legend takes its content height (+1 for the flatRule divider). The list
		// absorbs whatever space remains, so it shrinks first on a tiny terminal.
		const legendLines = this.buildLegendLines(leftWidth);
		const legendHeight = legendLines.length;
		const legendBlockHeight = legendHeight > 0 ? legendHeight + 1 : 0; // +1 divider
		const listHeight = Math.max(1, bodyHeight - legendBlockHeight);
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
		clearInterval(this.refreshTimer);
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Right-pane top-border label helpers — keep the chrome title in sync with the
// currently selected run so users always know what the transcript belongs to.
// ─────────────────────────────────────────────────────────────────────────────

function selectedRunTitle(run: LiveRun): string {
	if (run.run.label) return run.run.label;
	if (run.source === "sync") {
		return run.run.currentAgent ?? run.run.mode;
	}
	const running = run.run.steps.find((s) => s.status === "running");
	const step = running ?? run.run.steps[0];
	return step?.agent ?? run.run.mode;
}

function selectedRunTailPlain(run: LiveRun): string {
	const state = run.run.state ?? "";
	const tool = run.run.currentTool ? ` · ${run.run.currentTool}` : "";
	return `[${state}]${tool}`;
}

function selectedRunTailRendered(theme: Theme, run: LiveRun): string {
	const state = run.run.state ?? "";
	const stateColor = state === "running" ? "accent" : state === "failed" || state === "lost" ? "error" : state === "complete" ? "success" : "dim";
	const parts = [theme.fg(stateColor, `[${state}]`)];
	if (run.run.currentTool) parts.push(theme.fg("muted", run.run.currentTool));
	return parts.join(theme.fg("dim", " · "));
}
