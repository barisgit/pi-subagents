import { spawn } from "node:child_process";
import type { Theme } from "@mariozechner/pi-coding-agent";
import type { Component, TUI } from "@mariozechner/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { type AsyncRunOverlayData, type AsyncRunSummary, listAsyncRunsForOverlay, sortRuns } from "./async-status.ts";
import { readEventLog } from "./events-log.ts";
import { formatDuration } from "./formatters.ts";
import { multiSpinnerFrame, tintAgentName } from "./render.ts";
import { formatScrollInfo, pad, renderFooter, renderHeader } from "./render-helpers.ts";
import { ASYNC_DIR, type ActivityState, type SubagentState } from "./types.ts";

const AUTO_REFRESH_MS = 1000;
const RECENT_LIMIT = 20;
const LEFT_PANE_CAP = 40;
const MIN_LEFT_PANE = 20;
const MIN_RIGHT_PANE = 20;
const VIEWPORT_HEIGHT = 24;

type ForegroundControl = SubagentState["foregroundControls"] extends Map<string, infer T> ? T : never;

export interface ForegroundRunSummary {
	id: string;
	state: "running";
	activityState?: ActivityState;
	lastActivityAt?: number;
	currentTool?: string;
	currentToolStartedAt?: number;
	mode: "single" | "parallel" | "chain";
	startedAt: number;
	lastUpdate?: number;
	currentAgent?: string;
	currentIndex?: number;
	recentTools?: Array<{ tool: string; args?: string; endMs?: number }>;
	recentOutput?: string[];
	finalOutput?: string;
}

type LiveRun =
	| { source: "sync"; run: ForegroundRunSummary }
	| { source: "async"; run: AsyncRunSummary };

interface StatusOverlayDeps {
	listRunsForOverlay?: (asyncDirRoot: string, recentLimit?: number) => AsyncRunOverlayData;
	listForegroundRuns?: () => ForegroundRunSummary[];
	refreshMs?: number;
	leftPaneCap?: number;
}

export function foregroundRunsFromState(state: Pick<SubagentState, "foregroundControls">): ForegroundRunSummary[] {
	return Array.from(state.foregroundControls.values())
		.map((control: ForegroundControl) => ({
			id: control.runId,
			state: "running" as const,
			...(control.currentActivityState ? { activityState: control.currentActivityState } : {}),
			...(control.lastActivityAt !== undefined ? { lastActivityAt: control.lastActivityAt } : {}),
			...(control.currentTool ? { currentTool: control.currentTool } : {}),
			...(control.currentToolStartedAt !== undefined ? { currentToolStartedAt: control.currentToolStartedAt } : {}),
			mode: control.mode,
			startedAt: control.startedAt,
			lastUpdate: control.updatedAt,
			...(control.currentAgent ? { currentAgent: control.currentAgent } : {}),
			...(control.currentIndex !== undefined ? { currentIndex: control.currentIndex } : {}),
			...(control.recentTools ? { recentTools: control.recentTools } : {}),
			...(control.recentOutput ? { recentOutput: control.recentOutput } : {}),
			...(control.finalOutput ? { finalOutput: control.finalOutput } : {}),
		}))
		.sort((a, b) => (b.lastUpdate ?? b.startedAt) - (a.lastUpdate ?? a.startedAt));
}

function runKey(run: LiveRun): string {
	return `${run.source}:${run.run.id}`;
}

function runAgentName(run: LiveRun): string {
	if (run.source === "sync") return run.run.currentAgent ?? run.run.mode;
	const running = run.run.steps.find((step) => step.status === "running");
	return running?.agent ?? run.run.steps[0]?.agent ?? run.run.mode;
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
	const syncSorted = [...sync].sort((a, b) => (b.lastUpdate ?? b.startedAt) - (a.lastUpdate ?? a.startedAt));
	const asyncSorted = sortRuns(async);
	const all: LiveRun[] = [];
	for (const run of syncSorted) all.push({ source: "sync", run });
	for (const run of asyncSorted) all.push({ source: "async", run });
	return all.sort((a, b) => {
		const bA = stateBucket(a.run.state);
		const bB = stateBucket(b.run.state);
		if (bA !== bB) return bA - bB;
		if (bA === 0) {
			const attnA = a.run.activityState === "needs_attention" ? 0 : 1;
			const attnB = b.run.activityState === "needs_attention" ? 0 : 1;
			if (attnA !== attnB) return attnA - attnB;
		}
		const syncA = a.source === "sync" ? 0 : 1;
		const syncB = b.source === "sync" ? 0 : 1;
		if (syncA !== syncB) return syncA - syncB;
		const tA = a.source === "sync"
			? (a.run.lastUpdate ?? a.run.startedAt)
			: (a.run.lastUpdate ?? a.run.endedAt ?? a.run.startedAt);
		const tB = b.source === "sync"
			? (b.run.lastUpdate ?? b.run.startedAt)
			: (b.run.lastUpdate ?? b.run.endedAt ?? b.run.startedAt);
		return tB - tA;
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

function buildLeftLine(theme: Theme, run: LiveRun, selected: boolean, now: number, width: number): string {
	const cursor = selected ? theme.fg("accent", "> ") : "  ";
	const glyph = statusGlyph(theme, run.run.state, run.run.activityState);
	const agent = tintAgentName(runAgentName(run), undefined);
	const status = run.run.state;
	const elapsed = runElapsed(run, now);
	const text = `${cursor}${glyph} ${agent} · ${status} · ${elapsed}`;
	return truncateToWidth(text, width);
}

function buildRightLines(theme: Theme, run: LiveRun | undefined, width: number): string[] {
	if (!run) return [theme.fg("dim", "(no events yet)")];
	if (run.source === "sync") return [theme.fg("dim", "(sync run — no event log)")];
	const events = readEventLog(run.run.asyncDir);
	if (events.length === 0) return [theme.fg("dim", "(no events yet)")];
	const out: string[] = [];
	for (const event of events) {
		if (event.kind === "step-start") {
			out.push(theme.fg("accent", truncateToWidth(`─── Step ${event.stepIndex + 1}: ${event.agent} ───`, width)));
			continue;
		}
		if (event.kind === "tool") {
			const argsPart = event.argsPreview ? ` ${event.argsPreview}` : "";
			const base = `→ ${event.toolName}${argsPart}`;
			if (event.durationMs !== undefined) {
				const suffix = ` · ${event.durationMs}ms`;
				const baseTrim = truncateToWidth(base, Math.max(0, width - visibleWidth(suffix)));
				out.push(`${baseTrim}${theme.fg("dim", suffix)}`);
			} else {
				out.push(truncateToWidth(base, width));
			}
			continue;
		}
		if (event.kind === "step-end") {
			const middle: string[] = ["done"];
			if (event.status) middle.push(event.status);
			if (event.tokens !== undefined) middle.push(`${event.tokens}t`);
			if (event.durationMs !== undefined) middle.push(`${event.durationMs}ms`);
			const text = `─── ${middle.join(" · ")} ───`;
			out.push(theme.fg("dim", truncateToWidth(text, width)));
			continue;
		}
		if (event.kind === "final-text") {
			const border = "─".repeat(Math.max(0, width));
			out.push(theme.fg("dim", border));
			for (const wrapped of wrapText(event.text, width)) out.push(wrapped);
			out.push(theme.fg("dim", border));
			continue;
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
	private lastRightHeight = VIEWPORT_HEIGHT;
	private lastRightWidth = 0;
	private errorMessage?: string;

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
			this.errorMessage = undefined;
		} catch (error) {
			this.runs = [];
			this.errorMessage = error instanceof Error ? error.message : String(error);
		}
		this.reconcileSelection();
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
		const limit = this.leftScroll + VIEWPORT_HEIGHT;
		if (index >= limit) this.leftScroll = index - VIEWPORT_HEIGHT + 1;
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
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data === "q") {
			this.done();
			return;
		}
		if (data === "j" || matchesKey(data, "down")) {
			this.moveSelection(1);
			return;
		}
		if (data === "k" || matchesKey(data, "up")) {
			this.moveSelection(-1);
			return;
		}
		if (data === "g") {
			this.jumpSelection(false);
			return;
		}
		if (data === "G") {
			this.jumpSelection(true);
			return;
		}
		if (data === "J" || matchesKey(data, "shift+down")) {
			this.scrollRight(1);
			return;
		}
		if (data === "K" || matchesKey(data, "shift+up")) {
			this.scrollRight(-1);
			return;
		}
		if (data === "d" || matchesKey(data, "pageDown")) {
			this.scrollRight(Math.max(1, Math.floor(this.lastRightHeight / 2)));
			return;
		}
		if (data === "u" || matchesKey(data, "pageUp")) {
			this.scrollRight(-Math.max(1, Math.floor(this.lastRightHeight / 2)));
			return;
		}
		if (matchesKey(data, "return") || data === "o") {
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

		const headerText = `Subagent runs · ${this.runs.length} total · use j/k to navigate`;
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

		const bodyHeight = VIEWPORT_HEIGHT;
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
		const hints = "j/k move · J/K scroll · q close";
		const footerText = scrollInfo ? `${scrollInfo}  ${hints}` : hints;
		rows.push(renderFooter(truncateToWidth(footerText, Math.max(0, w - 2)), w, this.theme));
		return rows;
	}

	dispose(): void {
		clearInterval(this.refreshTimer);
	}
}
