import * as fs from "node:fs";
import * as path from "node:path";
import type { Theme } from "@mariozechner/pi-coding-agent";
import type { Component, TUI } from "@mariozechner/pi-tui";
import { matchesKey, truncateToWidth } from "@mariozechner/pi-tui";
import { type AsyncRunOverlayData, type AsyncRunSummary, listAsyncRunsForOverlay } from "./async-status.ts";
import { ASYNC_DIR, type ActivityState, type SubagentState } from "./types.ts";
import { formatDuration, formatTokens, shortenPath } from "./formatters.ts";
import { formatScrollInfo, renderFooter, renderHeader, row } from "./render-helpers.ts";

const AUTO_REFRESH_MS = 2000;
const RECENT_LIMIT = 5;
const COMPACT_TOOL_LIMIT = 8;
const COMPACT_OUTPUT_LINES = 6;
const DETAIL_FILE_TAIL_BYTES = 64 * 1024;
const DETAIL_VIEWPORT_HEIGHT = 26;

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

interface StatusRow {
	kind: "section" | "run";
	label: string;
	run?: LiveRun;
}

interface StatusOverlayDeps {
	listRunsForOverlay?: (asyncDirRoot: string, recentLimit?: number) => AsyncRunOverlayData;
	listForegroundRuns?: () => ForegroundRunSummary[];
	refreshMs?: number;
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

function statusColor(theme: Theme, status: AsyncRunSummary["state"] | ForegroundRunSummary["state"]): string {
	switch (status) {
		case "running": return theme.fg("warning", status);
		case "queued": return theme.fg("accent", status);
		case "complete": return theme.fg("success", status);
		case "failed": return theme.fg("error", status);
		case "paused": return theme.fg("warning", status);
	}
}

function stepStatusColor(theme: Theme, status: string): string {
	if (status === "running") return theme.fg("warning", status);
	if (status === "pending") return theme.fg("dim", status);
	if (status === "complete" || status === "completed") return theme.fg("success", status);
	if (status === "failed") return theme.fg("error", status);
	if (status === "paused") return theme.fg("warning", status);
	return status;
}

function formatActivity(input: { activityState?: ActivityState; lastActivityAt?: number; currentTool?: string; currentToolStartedAt?: number }, now = Date.now()): string | undefined {
	if (input.currentTool && input.currentToolStartedAt !== undefined) {
		return `tool ${input.currentTool} for ${formatDuration(Math.max(0, now - input.currentToolStartedAt))}`;
	}
	if (input.lastActivityAt === undefined) return input.activityState === "needs_attention" ? "needs attention" : undefined;
	const elapsed = formatDuration(Math.max(0, now - input.lastActivityAt));
	return input.activityState === "needs_attention" ? `no activity for ${elapsed}` : `active ${elapsed} ago`;
}

function runDuration(run: LiveRun): string {
	const end = run.source === "async" && run.run.endedAt ? run.run.endedAt : Date.now();
	return formatDuration(Math.max(0, end - run.run.startedAt));
}

function tokenText(run: LiveRun): string | undefined {
	if (run.source !== "async" || !run.run.totalTokens?.total) return undefined;
	return `${formatTokens(run.run.totalTokens.total)} tok`;
}

function stepLabel(run: LiveRun): string {
	if (run.source === "sync") {
		return run.run.currentIndex !== undefined ? `step ${run.run.currentIndex + 1}` : "live";
	}
	const stepCount = run.run.steps.length || 1;
	return run.run.currentStep !== undefined ? `step ${run.run.currentStep + 1}/${stepCount}` : `steps ${stepCount}`;
}

function runTitle(run: LiveRun): string {
	if (run.source === "sync") return run.run.currentAgent ?? run.run.mode;
	const runningStep = run.run.steps.find((step) => step.status === "running");
	return runningStep?.agent ?? run.run.steps[0]?.agent ?? run.run.mode;
}

function runLabel(theme: Theme, run: LiveRun, selected: boolean): string {
	const prefix = selected ? theme.fg("accent", ">") : " ";
	const activity = formatActivity(run.run);
	const parts = [
		`${prefix} ${run.run.id.slice(0, 8)}`,
		run.source,
		statusColor(theme, run.run.state),
		run.run.mode,
		stepLabel(run),
		runDuration(run),
		tokenText(run),
		activity,
	].filter((part): part is string => Boolean(part));
	return parts.join(" | ");
}

function selectedIndex(rows: StatusRow[], cursor: number): number {
	const runRows = rows.filter((row) => row.kind === "run");
	if (runRows.length === 0) return -1;
	return Math.max(0, Math.min(cursor, runRows.length - 1));
}

function selectedRun(rows: StatusRow[], cursor: number): LiveRun | undefined {
	const runRows = rows.filter((row) => row.kind === "run");
	const index = selectedIndex(rows, cursor);
	return index >= 0 ? runRows[index]?.run : undefined;
}

function buildRows(syncActive: ForegroundRunSummary[], asyncActive: AsyncRunSummary[], recent: AsyncRunSummary[]): StatusRow[] {
	const rows: StatusRow[] = [];
	if (syncActive.length > 0 || asyncActive.length > 0) {
		rows.push({ kind: "section", label: `Live now (${syncActive.length} sync / ${asyncActive.length} async)` });
		for (const run of syncActive) rows.push({ kind: "run", label: run.id, run: { source: "sync", run } });
		for (const run of asyncActive) rows.push({ kind: "run", label: run.id, run: { source: "async", run } });
	}
	if (recent.length > 0) {
		rows.push({ kind: "section", label: `Recent async (${recent.length})` });
		for (const run of recent) rows.push({ kind: "run", label: run.id, run: { source: "async", run } });
	}
	return rows;
}

function compactPathLine(label: string, value: string, width: number, innerW: number, theme: Theme): string {
	return row(`${label}: ${truncateToWidth(shortenPath(value), innerW - label.length - 2)}`, width, theme);
}

function resolveRunPath(asyncDir: string, filePath: string): string {
	return path.isAbsolute(filePath) ? filePath : path.join(asyncDir, filePath);
}

function readTailText(filePath: string): { text?: string; warning?: string } {
	let fd: number | undefined;
	try {
		const stat = fs.statSync(filePath);
		if (!stat.isFile()) return { warning: `not a file: ${filePath}` };
		const start = Math.max(0, stat.size - DETAIL_FILE_TAIL_BYTES);
		const length = stat.size - start;
		const buffer = Buffer.alloc(length);
		fd = fs.openSync(filePath, "r");
		const bytesRead = fs.readSync(fd, buffer, 0, length, start);
		return { text: buffer.subarray(0, bytesRead).toString("utf-8") };
	} catch (error) {
		const code = typeof error === "object" && error !== null && "code" in error
			? (error as NodeJS.ErrnoException).code
			: undefined;
		return { warning: code === "ENOENT" ? `missing ${path.basename(filePath)}: ${filePath}` : `failed to read ${filePath}: ${error instanceof Error ? error.message : String(error)}` };
	} finally {
		if (fd !== undefined) {
			try {
				fs.closeSync(fd);
			} catch {
				// Best effort cleanup after a bounded detail-view read.
			}
		}
	}
}

function readTailLines(filePath: string, maxLines: number): { lines: string[]; warning?: string } {
	const tail = readTailText(filePath);
	if (tail.warning) return { lines: [], warning: tail.warning };
	const lines = (tail.text ?? "").split("\n").map((line) => line.trimEnd()).filter((line) => line.trim());
	return { lines: lines.slice(Math.max(0, lines.length - maxLines)) };
}

function formatToolEventLine(value: Record<string, unknown>): string | undefined {
	const type = typeof value.type === "string" ? value.type : "event";
	const event = value.event && typeof value.event === "object" && !Array.isArray(value.event)
		? value.event as Record<string, unknown>
		: undefined;
	const toolName = typeof value.toolName === "string"
		? value.toolName
		: typeof value.tool === "string"
			? value.tool
			: typeof event?.toolName === "string"
				? event.toolName
				: undefined;
	if (!type.toLowerCase().includes("tool") && toolName === undefined) return undefined;
	const agent = typeof value.agent === "string"
		? value.agent
		: typeof value.subagentAgent === "string"
			? value.subagentAgent
			: undefined;
	const step = typeof value.stepIndex === "number" ? `#${value.stepIndex + 1}` : undefined;
	const message = typeof value.message === "string"
		? value.message
		: typeof event?.message === "string"
			? event.message
			: undefined;
	return [agent, step, toolName ?? type, message].filter(Boolean).join(" | ");
}

function readRecentToolEvents(eventsPath: string, limit: number): { tools: string[]; warning?: string } {
	const tail = readTailText(eventsPath);
	if (tail.warning) return tail.warning.startsWith("missing ") ? { tools: [] } : { tools: [], warning: tail.warning };

	const tools: string[] = [];
	const lines = (tail.text ?? "").split("\n").filter((line) => line.trim());
	for (let i = lines.length - 1; i >= 0 && tools.length < limit; i--) {
		try {
			const parsed = JSON.parse(lines[i]!);
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
			const tool = formatToolEventLine(parsed as Record<string, unknown>);
			if (tool) tools.push(tool);
		} catch {
			// Skip malformed event records; async writers can be interrupted mid-line.
		}
	}
	return { tools: tools.reverse() };
}

function compactOutputLines(lines: string[], maxLines = COMPACT_OUTPUT_LINES): string[] {
	const compact = lines.map((line) => line.trimEnd()).filter((line) => line.trim());
	return compact.slice(Math.max(0, compact.length - maxLines));
}

export class SubagentsStatusComponent implements Component {
	private readonly width = 140;
	private readonly viewportHeight = 18;
	private readonly listRunsForOverlay: (asyncDirRoot: string, recentLimit?: number) => AsyncRunOverlayData;
	private readonly listForegroundRuns: () => ForegroundRunSummary[];
	private readonly refreshTimer: NodeJS.Timeout;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly done: () => void;
	private screen: "list" | "detail" = "list";
	private cursor = 0;
	private scrollOffset = 0;
	private detailScrollOffset = 0;
	private detailRunKey: string | undefined;
	private syncActive: ForegroundRunSummary[] = [];
	private asyncActive: AsyncRunSummary[] = [];
	private recent: AsyncRunSummary[] = [];
	private rows: StatusRow[] = [];
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
		const refreshMs = deps.refreshMs ?? AUTO_REFRESH_MS;
		this.reload();
		this.refreshTimer = setInterval(() => {
			this.reload();
			this.tui.requestRender();
		}, refreshMs);
		this.refreshTimer.unref?.();
	}

	private reload(): void {
		const selected = selectedRun(this.rows, this.cursor);
		const previousSelectedKey = selected ? runKey(selected) : undefined;
		try {
			const overlayData = this.listRunsForOverlay(ASYNC_DIR, RECENT_LIMIT);
			this.syncActive = this.listForegroundRuns();
			this.asyncActive = overlayData.active;
			this.recent = overlayData.recent;
			this.rows = buildRows(this.syncActive, this.asyncActive, this.recent);
			this.errorMessage = undefined;
			this.restoreSelection(previousSelectedKey);
			this.ensureScrollVisible();
		} catch (error) {
			this.syncActive = [];
			this.asyncActive = [];
			this.recent = [];
			this.rows = [];
			this.cursor = 0;
			this.scrollOffset = 0;
			this.errorMessage = error instanceof Error ? error.message : String(error);
		}
	}

	private restoreSelection(previousSelectedKey?: string): void {
		const runRows = this.rows.filter((row) => row.kind === "run");
		if (runRows.length === 0) {
			this.cursor = 0;
			return;
		}
		if (!previousSelectedKey) {
			this.cursor = Math.min(this.cursor, runRows.length - 1);
			return;
		}
		const nextIndex = runRows.findIndex((row) => row.run && runKey(row.run) === previousSelectedKey);
		if (nextIndex !== -1) {
			this.cursor = nextIndex;
			return;
		}
		this.cursor = Math.min(this.cursor, runRows.length - 1);
	}

	private ensureScrollVisible(): void {
		if (this.rows.length <= this.viewportHeight) {
			this.scrollOffset = 0;
			return;
		}
		const selected = selectedRun(this.rows, this.cursor);
		if (!selected) {
			this.scrollOffset = 0;
			return;
		}
		const selectedKey = runKey(selected);
		const rowIndex = this.rows.findIndex((statusRow) => statusRow.kind === "run" && statusRow.run && runKey(statusRow.run) === selectedKey);
		if (rowIndex === -1) return;
		if (rowIndex < this.scrollOffset) this.scrollOffset = rowIndex;
		if (rowIndex >= this.scrollOffset + this.viewportHeight) {
			this.scrollOffset = rowIndex - this.viewportHeight + 1;
		}
	}

	private renderSyncDetails(run: ForegroundRunSummary, width: number, innerW: number): string[] {
		const agent = run.currentAgent ?? "starting";
		const activity = formatActivity(run) ?? "thinking or starting child session";
		const lines = [
			row(this.theme.fg("accent", `Selected sync: ${run.id}`), width, this.theme),
			row(truncateToWidth(`Now: ${agent} | ${run.mode} | ${stepLabel({ source: "sync", run })} | ${activity}`, innerW), width, this.theme),
			row(truncateToWidth(`Runtime: ${formatDuration(Math.max(0, Date.now() - run.startedAt))} | updated ${formatDuration(Math.max(0, Date.now() - (run.lastUpdate ?? run.startedAt)))} ago`, innerW), width, this.theme),
		];
		if (run.currentTool) lines.push(row(truncateToWidth(`Tool: ${run.currentTool}${run.currentToolStartedAt !== undefined ? ` for ${formatDuration(Math.max(0, Date.now() - run.currentToolStartedAt))}` : ""}`, innerW), width, this.theme));
		return lines;
	}

	private renderAsyncDetails(run: AsyncRunSummary, width: number, innerW: number): string[] {
		const runActivity = formatActivity(run) ?? (run.state === "queued" ? "waiting to start" : "no recent activity recorded");
		const tokens = run.totalTokens ? ` | ${formatTokens(run.totalTokens.total)} tok` : "";
		const lines = [
			row(this.theme.fg("accent", `Selected async: ${run.id}`), width, this.theme),
			row(truncateToWidth(`Now: ${runTitle({ source: "async", run })} | ${statusColor(this.theme, run.state)} | ${run.mode} | ${stepLabel({ source: "async", run })} | ${runActivity}`, innerW), width, this.theme),
			row(truncateToWidth(`Runtime: ${runDuration({ source: "async", run })}${tokens} | updated ${formatDuration(Math.max(0, Date.now() - (run.lastUpdate ?? run.endedAt ?? run.startedAt)))} ago`, innerW), width, this.theme),
			compactPathLine("cwd", run.cwd ?? run.asyncDir, width, innerW, this.theme),
		];
		if (run.outputFile) lines.push(compactPathLine("output", resolveRunPath(run.asyncDir, run.outputFile), width, innerW, this.theme));
		return lines;
	}

	private renderRunDetails(run: LiveRun, width: number, innerW: number): string[] {
		return run.source === "sync" ? this.renderSyncDetails(run.run, width, innerW) : this.renderAsyncDetails(run.run, width, innerW);
	}

	private renderSyncDetail(run: ForegroundRunSummary, width: number, innerW: number): string[] {
		const body = this.renderSyncDetails(run, width, innerW);
		body.push(row("", width, this.theme));
		body.push(row(this.theme.fg("accent", "Recent tools"), width, this.theme));
		const tools = run.recentTools?.slice(-COMPACT_TOOL_LIMIT) ?? [];
		if (run.currentTool) body.push(row(truncateToWidth(`  now: ${run.currentTool}`, innerW), width, this.theme));
		for (const tool of tools) {
			const args = tool.args ? ` ${tool.args}` : "";
			body.push(row(truncateToWidth(`  ${tool.tool}${args}`, innerW), width, this.theme));
		}
		if (!run.currentTool && tools.length === 0) body.push(row(this.theme.fg("dim", "  No tool activity yet."), width, this.theme));

		body.push(row("", width, this.theme));
		body.push(row(this.theme.fg("accent", run.finalOutput ? "Final output" : "Compact output tail"), width, this.theme));
		const outputLines = run.finalOutput
			? compactOutputLines(run.finalOutput.split("\n"))
			: compactOutputLines(run.recentOutput ?? []);
		if (outputLines.length === 0) body.push(row(this.theme.fg("dim", "  Sync transcript remains in the main conversation; no compact tail yet."), width, this.theme));
		for (const line of outputLines) body.push(row(truncateToWidth(`  ${line}`, innerW), width, this.theme));

		return [
			renderHeader(`Subagent Live ${run.id.slice(0, 8)}`, width, this.theme),
			...body,
			renderFooter(" esc summary  q close  compact sync digest ", width, this.theme),
		];
	}

	private renderAsyncDetail(run: AsyncRunSummary, width: number, innerW: number): string[] {
		const body: string[] = [];
		body.push(...this.renderAsyncDetails(run, width, innerW));

		body.push(row("", width, this.theme));
		body.push(row(this.theme.fg("accent", "Steps"), width, this.theme));
		for (const step of run.steps) {
			const parts = [
				`${step.index + 1}. ${step.agent}`,
				step.status,
				step.currentTool ? `now ${step.currentTool}` : undefined,
				step.tokens ? `${formatTokens(step.tokens.total)} tok` : undefined,
			].filter(Boolean).join(" | ");
			body.push(row(truncateToWidth(`  ${parts}`, innerW), width, this.theme));
		}
		if (run.steps.length === 0) body.push(row(this.theme.fg("dim", "  No step details available yet."), width, this.theme));

		const toolResult = readRecentToolEvents(path.join(run.asyncDir, "events.jsonl"), COMPACT_TOOL_LIMIT);
		body.push(row("", width, this.theme));
		body.push(row(this.theme.fg("accent", "Recent tools"), width, this.theme));
		if (toolResult.warning) body.push(row(this.theme.fg("warning", truncateToWidth(toolResult.warning, innerW)), width, this.theme));
		if (toolResult.tools.length === 0 && !toolResult.warning) body.push(row(this.theme.fg("dim", "  No tool events recorded yet."), width, this.theme));
		for (const tool of toolResult.tools) body.push(row(truncateToWidth(`  ${tool}`, innerW), width, this.theme));

		body.push(row("", width, this.theme));
		body.push(row(this.theme.fg("accent", run.state === "complete" ? "Final output tail" : "Compact output tail"), width, this.theme));
		if (run.outputFile) {
			const tail = readTailLines(resolveRunPath(run.asyncDir, run.outputFile), COMPACT_OUTPUT_LINES);
			if (tail.warning) body.push(row(this.theme.fg("warning", truncateToWidth(tail.warning, innerW)), width, this.theme));
			else if (tail.lines.length === 0) body.push(row(this.theme.fg("dim", "  No output yet."), width, this.theme));
			for (const line of tail.lines) body.push(row(truncateToWidth(`  ${line}`, innerW), width, this.theme));
		} else {
			body.push(row(this.theme.fg("dim", "  No output file recorded."), width, this.theme));
		}

		body.push(row("", width, this.theme));
		body.push(row(this.theme.fg("accent", "Paths"), width, this.theme));
		body.push(row(truncateToWidth(`  cwd: ${shortenPath(run.cwd ?? run.asyncDir)}`, innerW), width, this.theme));
		if (run.sessionFile) body.push(row(truncateToWidth(`  session: ${shortenPath(run.sessionFile)}`, innerW), width, this.theme));
		const logPath = path.join(run.asyncDir, `subagent-log-${run.id}.md`);
		if (fs.existsSync(logPath)) body.push(row(truncateToWidth(`  runLog: ${shortenPath(logPath)}`, innerW), width, this.theme));

		const maxOffset = Math.max(0, body.length - DETAIL_VIEWPORT_HEIGHT);
		this.detailScrollOffset = Math.min(this.detailScrollOffset, maxOffset);
		const visibleBody = body.slice(this.detailScrollOffset, this.detailScrollOffset + DETAIL_VIEWPORT_HEIGHT);
		const above = this.detailScrollOffset;
		const below = Math.max(0, body.length - (this.detailScrollOffset + visibleBody.length));
		const scrollInfo = formatScrollInfo(above, below);
		return [
			renderHeader(`Subagent Run ${run.id.slice(0, 8)}`, width, this.theme),
			...visibleBody,
			scrollInfo ? row(this.theme.fg("dim", scrollInfo), width, this.theme) : row("", width, this.theme),
			renderFooter(" ↑↓ scroll  esc summary  q close  compact digest ", width, this.theme),
		];
	}

	private renderDetail(run: LiveRun, width: number, innerW: number): string[] {
		return run.source === "sync" ? this.renderSyncDetail(run.run, width, innerW) : this.renderAsyncDetail(run.run, width, innerW);
	}

	handleInput(data: string): void {
		if (this.screen === "detail" && matchesKey(data, "escape")) {
			this.screen = "list";
			this.detailRunKey = undefined;
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "escape") || matchesKey(data, "q") || matchesKey(data, "ctrl+c")) {
			this.done();
			return;
		}
		if (this.screen === "detail") {
			if (matchesKey(data, "up")) {
				this.detailScrollOffset = Math.max(0, this.detailScrollOffset - 1);
				this.tui.requestRender();
				return;
			}
			if (matchesKey(data, "down")) {
				this.detailScrollOffset++;
				this.tui.requestRender();
				return;
			}
			if (matchesKey(data, "pageup")) {
				this.detailScrollOffset = Math.max(0, this.detailScrollOffset - DETAIL_VIEWPORT_HEIGHT);
				this.tui.requestRender();
				return;
			}
			if (matchesKey(data, "pagedown")) {
				this.detailScrollOffset += DETAIL_VIEWPORT_HEIGHT;
				this.tui.requestRender();
			}
			return;
		}
		if (matchesKey(data, "return")) {
			const selected = selectedRun(this.rows, this.cursor);
			if (selected) {
				this.screen = "detail";
				this.detailRunKey = runKey(selected);
				this.detailScrollOffset = 0;
				this.tui.requestRender();
			}
			return;
		}
		if (matchesKey(data, "up")) {
			this.cursor = Math.max(0, this.cursor - 1);
			this.ensureScrollVisible();
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "down")) {
			const maxCursor = Math.max(0, this.rows.filter((statusRow) => statusRow.kind === "run").length - 1);
			this.cursor = Math.min(maxCursor, this.cursor + 1);
			this.ensureScrollVisible();
			this.tui.requestRender();
		}
	}

	render(width: number): string[] {
		const w = Math.min(width, this.width);
		const innerW = w - 2;
		if (this.screen === "detail") {
			const detailRun = this.rows.find((statusRow) => statusRow.kind === "run" && statusRow.run && runKey(statusRow.run) === this.detailRunKey)?.run;
			if (detailRun) return this.renderDetail(detailRun, w, innerW);
			return [
				renderHeader("Subagent Run", w, this.theme),
				row(this.theme.fg("warning", "Selected run is no longer available."), w, this.theme),
				renderFooter(" esc summary  q close ", w, this.theme),
			];
		}

		const activeCount = this.syncActive.length + this.asyncActive.length;
		const lines: string[] = [
			renderHeader("Subagents Live", w, this.theme),
			row(truncateToWidth(`Dashboard: ${activeCount} live (${this.syncActive.length} sync, ${this.asyncActive.length} async) | ${this.recent.length} recent async | refresh ${formatDuration(AUTO_REFRESH_MS)}`, innerW), w, this.theme),
		];
		const rows = this.rows.length > 0 ? this.rows : [{ kind: "section" as const, label: "No subagent sessions found" }];
		const selected = selectedRun(this.rows, this.cursor);
		const visibleRows = rows.slice(this.scrollOffset, this.scrollOffset + this.viewportHeight);
		for (const statusRow of visibleRows) {
			if (statusRow.kind === "section") {
				lines.push(row(this.theme.fg("accent", statusRow.label), w, this.theme));
				continue;
			}
			const isSelected = selected && statusRow.run ? runKey(selected) === runKey(statusRow.run) : false;
			lines.push(row(truncateToWidth(runLabel(this.theme, statusRow.run!, isSelected), innerW), w, this.theme));
		}

		const above = this.scrollOffset;
		const below = Math.max(0, rows.length - (this.scrollOffset + visibleRows.length));
		const scrollInfo = formatScrollInfo(above, below);
		lines.push(row(scrollInfo ? this.theme.fg("dim", scrollInfo) : "", w, this.theme));

		if (this.errorMessage) {
			lines.push(row(this.theme.fg("error", truncateToWidth(`Status read failed: ${this.errorMessage}`, innerW)), w, this.theme));
			lines.push(row(this.theme.fg("dim", "Async status files may be rotating; the panel will retry on the next refresh."), w, this.theme));
		} else if (selected) {
			lines.push(...this.renderRunDetails(selected, w, innerW));
		} else {
			lines.push(row(this.theme.fg("dim", "No live or recent subagent runs yet."), w, this.theme));
			lines.push(row(this.theme.fg("dim", "Start one with /run, /chain, /parallel, or use --bg for background runs."), w, this.theme));
		}

		const footer = `↑↓ select  enter detail  esc close  ${this.syncActive.length} sync / ${this.asyncActive.length} async / ${this.recent.length} recent`;
		lines.push(renderFooter(truncateToWidth(footer, innerW), w, this.theme));
		return lines;
	}

	dispose(): void {
		clearInterval(this.refreshTimer);
	}
}
