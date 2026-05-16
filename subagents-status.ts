import { spawn } from "node:child_process";
import * as path from "node:path";
import type { Theme } from "@mariozechner/pi-coding-agent";
import type { Component, TUI } from "@mariozechner/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { type AsyncRunOverlayData, type AsyncRunSummary, listAsyncRunsForOverlay, sortRuns } from "./async-status.ts";
import { readEventLog } from "./events-log.ts";
import { formatDuration } from "./formatters.ts";
import { multiSpinnerFrame, tintAgentName } from "./render.ts";
import { formatScrollInfo, pad, renderFooter, renderHeader } from "./render-helpers.ts";
import { describeAgentLabel, formatShapeBadge } from "./run-shape.ts";
import { ASYNC_DIR, type ActivityState, type SubagentState } from "./types.ts";

const AUTO_REFRESH_MS = 1000;
const RECENT_LIMIT = 20;
const LEFT_PANE_CAP = 55;
const MIN_LEFT_PANE = 20;
const MIN_RIGHT_PANE = 20;
const MIN_VIEWPORT_HEIGHT = 12;
const VIEWPORT_RESERVED_ROWS = 8; // header + footer + overlay chrome + safety.
// Body height adapts to current terminal rows so the dashboard uses the whole
// pane instead of a hardcoded 24 lines.
function computeBodyHeight(): number {
	const rows = process.stdout.rows ?? 32;
	return Math.max(MIN_VIEWPORT_HEIGHT, rows - VIEWPORT_RESERVED_ROWS);
}

type ForegroundControl = SubagentState["foregroundControls"] extends Map<string, infer T> ? T : never;

export interface ForegroundRunSummary {
	id: string;
	state: "running";
	activityState?: ActivityState;
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
		.map((control: ForegroundControl) => ({
			id: control.runId,
			state: "running" as const,
			...(control.currentActivityState ? { activityState: control.currentActivityState } : {}),
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
			...(control.currentIndex !== undefined ? { currentIndex: control.currentIndex } : {}),
			...(control.recentTools ? { recentTools: control.recentTools } : {}),
			...(control.recentOutput ? { recentOutput: control.recentOutput } : {}),
			...(control.finalOutput ? { finalOutput: control.finalOutput } : {}),
		}))
		.sort((a, b) => b.startedAt - a.startedAt);
}

function runKey(run: LiveRun): string {
	return `${run.source}:${run.run.id}`;
}

// Returns the agent name(s) as a pre-styled string when colors apply, otherwise plain text.
// Parallel runs with heterogeneous agents get per-piece tinting so each name uses its own color.
function runAgentLabel(run: LiveRun, theme: Theme): string {
	if (run.source === "sync") return tintAgentName(run.run.currentAgent ?? run.run.mode, undefined);
	const steps = run.run.mode === "parallel"
		? run.run.steps.filter((s) => s.agent)
		: run.run.steps;
	const running = run.run.steps.find((step) => step.status === "running");
	const fallbackStep = running ?? run.run.steps[0];
	const desc = describeAgentLabel({
		mode: run.run.mode,
		agents: steps.map((s) => s.agent),
		agentColors: steps.map((s) => s.color),
		fallbackName: fallbackStep?.agent ?? run.run.mode,
		fallbackColor: fallbackStep?.color,
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
		? run.run.steps.filter((s) => s.status === "complete" || s.status === "failed").length
		: (run.run.currentStep ?? 0) + 1;
	return formatShapeBadge({ mode: run.run.mode, total, current });
}

function runElapsed(run: LiveRun, now: number): string {
	const end = run.source === "async" && run.run.endedAt ? run.run.endedAt : now;
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

function sortLiveRuns(sync: ForegroundRunSummary[], async: AsyncRunSummary[]): LiveRun[] {
	// Single ordering rule for the dashboard: needs_attention pinned to the very top,
	// then everything strictly by spawn time (newest first). State buckets are NOT
	// used here -- otherwise old failed runs would float above recently completed
	// runs just because 'failed' bucket ranks above 'complete'. The status glyph on
	// each row already communicates state, so bucketing only hurt the mental model.
	const all: LiveRun[] = [];
	for (const run of sync) all.push({ source: "sync", run });
	for (const run of async) all.push({ source: "async", run });
	return all.sort((a, b) => {
		const attnA = a.run.activityState === "needs_attention" ? 0 : 1;
		const attnB = b.run.activityState === "needs_attention" ? 0 : 1;
		if (attnA !== attnB) return attnA - attnB;
		return b.run.startedAt - a.run.startedAt;
	});
}

function statusGlyph(theme: Theme, state: AsyncRunSummary["state"], activity: ActivityState | undefined): string {
	if (activity === "needs_attention") return theme.fg("warning", "!");
	switch (state) {
		case "running": return theme.fg("accent", multiSpinnerFrame());
		case "queued": return theme.fg("dim", "○");
		case "paused": return theme.fg("warning", "⏸");
		case "complete": return theme.fg("success", "✓");
		case "failed": return theme.fg("error", "✗");
	}
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

// Compact cwd badge (rightmost path segment, capped) for async rows. Sync runs
// always share the current session cwd, so a per-row badge would just be noise.
function runCwdBadge(run: LiveRun): string {
	if (run.source !== "async") return "";
	const cwd = run.run.cwd;
	if (!cwd) return "";
	const base = path.basename(cwd) || cwd;
	return base.length > 15 ? base.slice(0, 14) + "…" : base;
}

function buildLeftLine(theme: Theme, run: LiveRun, selected: boolean, now: number, width: number): string {
	const cursor = selected ? theme.fg("accent", "> ") : "  ";
	const glyph = statusGlyph(theme, run.run.state, run.run.activityState);
	const agent = runAgentLabel(run, theme);
	const status = run.run.state;
	const elapsed = runElapsed(run, now);
	const badge = runShapeBadge(run);
	const badgePart = badge ? ` · ${theme.fg("dim", badge)}` : "";
	const labelPart = run.run.label
		? ` · ${theme.fg("muted", truncateToWidth(run.run.label, 30))}`
		: "";
	const cwdBadge = runCwdBadge(run);
	const cwdPart = cwdBadge ? ` · ${theme.fg("dim", cwdBadge)}` : "";
	const text = `${cursor}${glyph} ${agent} · ${status}${badgePart}${labelPart}${cwdPart} · ${elapsed}`;
	return truncateToWidth(text, width);
}

function buildRightLines(theme: Theme, run: LiveRun | undefined, width: number): string[] {
	if (!run) return [theme.fg("dim", "(no events yet)")];
	if (run.source === "sync") return [theme.fg("dim", "(sync run — no event log)")];
	const events = readEventLog(run.run.asyncDir);
	if (events.length === 0) return [theme.fg("dim", "(no events yet)")];

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
			const combined = [...overlay.active, ...overlay.recent];
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
		const bodyHeight = this.lastRightHeight || computeBodyHeight();
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
		if (matchesKey(data, "j") || matchesKey(data, "down")) {
			this.moveSelection(1);
			return;
		}
		if (matchesKey(data, "k") || matchesKey(data, "up")) {
			this.moveSelection(-1);
			return;
		}
		if (matchesKey(data, "g")) {
			this.jumpSelection(false);
			return;
		}
		if (matchesKey(data, "shift+g")) {
			this.jumpSelection(true);
			return;
		}
		if (matchesKey(data, "shift+j") || matchesKey(data, "shift+down")) {
			this.scrollRight(1);
			return;
		}
		if (matchesKey(data, "shift+k") || matchesKey(data, "shift+up")) {
			this.scrollRight(-1);
			return;
		}
		if (matchesKey(data, "d") || matchesKey(data, "pageDown")) {
			this.scrollRight(Math.max(1, Math.floor(this.lastRightHeight / 2)));
			return;
		}
		if (matchesKey(data, "u") || matchesKey(data, "pageUp")) {
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
		const border = this.theme.fg("border", "│");
		const leftCell = pad(truncateToWidth(left, leftWidth), leftWidth);
		const rightCell = pad(truncateToWidth(right, rightWidth), rightWidth);
		return border + leftCell + border + rightCell + border;
	}

	render(width: number): string[] {
		const w = Math.max(8, width);
		const leftWidth = Math.max(MIN_LEFT_PANE, Math.min(this.leftPaneCap, w - 3 - MIN_RIGHT_PANE));
		const rightWidth = Math.max(MIN_RIGHT_PANE, w - 3 - leftWidth);
		this.lastRightWidth = rightWidth;

		const scopeMarker = this.showAllSessions || !this.sessionCwd ? " · [all sessions]" : "";
		const headerText = `Subagent runs · ${this.runs.length} total${scopeMarker} · use j/k to navigate · a all`;
		const header = renderHeader(headerText, w, this.theme);

		const now = Date.now();
		const leftLines: string[] = [];
		if (this.runs.length === 0) {
			leftLines.push(this.theme.fg("dim", "No subagent runs"));
		} else {
			for (let i = 0; i < this.runs.length; i++) {
				const run = this.runs[i]!;
				const isSelected = runKey(run) === this.selectedId;
				leftLines.push(buildLeftLine(this.theme, run, isSelected, now, leftWidth));
			}
		}

		const selected = this.selectedRun();
		const rightLines = buildRightLines(this.theme, selected, rightWidth);

		const bodyHeight = computeBodyHeight();
		this.lastRightHeight = bodyHeight;

		// Right pane scroll bookkeeping: sticky-to-bottom for the selected run.
		let rightTop = 0;
		if (selected) {
			const state = this.getRightScrollState();
			const maxTop = Math.max(0, rightLines.length - bodyHeight);
			if (state.sticky) state.top = maxTop;
			state.top = Math.max(0, Math.min(maxTop, state.top));
			rightTop = state.top;
		}

		const visibleLeft = leftLines.slice(this.leftScroll, this.leftScroll + bodyHeight);
		const visibleRight = rightLines.slice(rightTop, rightTop + bodyHeight);

		const rows: string[] = [header];
		if (this.errorMessage) {
			rows.push(this.bodyRow(
				this.theme.fg("error", truncateToWidth(`status read failed: ${this.errorMessage}`, leftWidth)),
				"",
				leftWidth,
				rightWidth,
			));
		}
		for (let i = 0; i < bodyHeight; i++) {
			const left = visibleLeft[i] ?? "";
			const right = visibleRight[i] ?? "";
			rows.push(this.bodyRow(left, right, leftWidth, rightWidth));
		}

		const above = rightTop;
		const below = Math.max(0, rightLines.length - (rightTop + visibleRight.length));
		const scrollInfo = formatScrollInfo(above, below);
		const hints = "j/k move · J/K scroll · a all · q close";
		const footerText = scrollInfo ? `${scrollInfo}  ${hints}` : hints;
		rows.push(renderFooter(truncateToWidth(footerText, Math.max(0, w - 2)), w, this.theme));
		return rows;
	}

	dispose(): void {
		clearInterval(this.refreshTimer);
	}
}
