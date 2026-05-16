/**
 * Rendering functions for subagent results
 */

import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { getMarkdownTheme, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text, visibleWidth, type Component } from "@mariozechner/pi-tui";
import {
	type AgentProgress,
	type AsyncJobState,
	type Details,
	MAX_WIDGET_JOBS,
	WIDGET_KEY,
} from "./types.ts";
import { formatTokens, formatUsage, formatDuration, formatToolCall, shortenPath } from "./formatters.ts";
import { getDisplayItems, getLastActivity, getSingleResultOutput } from "./utils.ts";

type Theme = ExtensionContext["ui"]["theme"];

function getTermWidth(): number {
	return process.stdout.columns || 120;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Truncate a line to maxWidth, preserving ANSI styling through the ellipsis.
 * 
 * pi-tui's truncateToWidth adds \x1b[0m before ellipsis which resets all styling,
 * causing background color bleed in the TUI. This implementation tracks active
 * ANSI styles and re-applies them before the ellipsis.
 * 
 * Uses Intl.Segmenter for proper Unicode/emoji handling (not char-by-char).
 */
function truncLine(text: string, maxWidth: number): string {
	if (visibleWidth(text) <= maxWidth) return text;

	const targetWidth = maxWidth - 1;
	let result = "";
	let currentWidth = 0;
	let activeStyles: string[] = [];
	let i = 0;

	while (i < text.length) {
		const ansiMatch = text.slice(i).match(/^\x1b\[[0-9;]*m/);
		if (ansiMatch) {
			const code = ansiMatch[0];
			result += code;

			if (code === "\x1b[0m" || code === "\x1b[m") {
				activeStyles = [];
			} else {
				activeStyles.push(code);
			}
			i += code.length;
			continue;
		}

		let end = i;
		while (end < text.length && !text.slice(end).match(/^\x1b\[[0-9;]*m/)) {
			end++;
		}

		const textPortion = text.slice(i, end);
		for (const seg of segmenter.segment(textPortion)) {
			const grapheme = seg.segment;
			const graphemeWidth = visibleWidth(grapheme);

			if (currentWidth + graphemeWidth > targetWidth) {
				return result + activeStyles.join("") + "…";
			}

			result += grapheme;
			currentWidth += graphemeWidth;
		}
		i = end;
	}

	return result + activeStyles.join("") + "…";
}

const SPINNER = ["-", "\\", "|", "/"];
const WIDGET_ANIMATION_MS = 80;

/**
 * Right-align `suffix` to terminal width on the same line as `base`.
 * If base+suffix already fits, pad between them; if they overflow, drop the suffix
 * (truncLine will handle base). Both inputs may contain ANSI styling; widths are
 * computed visually via visibleWidth.
 */
function rightAlignSuffix(base: string, suffix: string, maxWidth: number): string {
	if (!suffix) return base;
	const baseW = visibleWidth(base);
	const sufW = visibleWidth(suffix);
	if (baseW + sufW + 2 > maxWidth) return base; // not enough room, drop spark
	const pad = Math.max(2, maxWidth - baseW - sufW);
	return `${base}${" ".repeat(pad)}${suffix}`;
}

let widgetTimer: ReturnType<typeof setInterval> | undefined;
let latestWidgetCtx: ExtensionContext | undefined;
let latestWidgetJobs: AsyncJobState[] = [];

const resultAnimationTimers = new Map<ReturnType<typeof setInterval>, ResultAnimationContext["state"]>();
const outputActivityCache = new Map<string, { checkedAt: number; text: string }>();

export interface ResultAnimationContext {
	state: { subagentResultAnimationTimer?: ReturnType<typeof setInterval> };
	invalidate: () => void;
}

function spinnerFrame(): string {
	return SPINNER[Math.floor(Date.now() / WIDGET_ANIMATION_MS) % SPINNER.length]!;
}

// Named ANSI 256 colors for agent name tinting. Picked from the xterm 256 palette
// so each color is visually distinct under both dark and light terminal themes.
// User writes `color: cyan` in agent frontmatter; missing/unknown -> no tinting.
const AGENT_COLOR_MAP: Record<string, number> = {
	red: 196,
	green: 76,
	yellow: 220,
	blue: 39,
	magenta: 201,
	cyan: 51,
	orange: 208,
	pink: 213,
	purple: 141,
	teal: 80,
	lime: 154,
	gray: 245,
	white: 231,
	brown: 130,
	gold: 178,
	sky: 117,
	mint: 121,
	coral: 209,
	lavender: 183,
	crimson: 161,
};

function tintAgentName(name: string, color: string | undefined): string {
	if (!color) return name;
	const trimmed = color.trim().toLowerCase();
	let ansi = AGENT_COLOR_MAP[trimmed];
	if (ansi === undefined) {
		// Accept raw numeric codes too (e.g. `color: 199`).
		const n = Number(trimmed);
		if (Number.isInteger(n) && n >= 0 && n <= 255) ansi = n;
	}
	if (ansi === undefined) return name;
	return `\u001b[38;5;${ansi}m${name}\u001b[39m`;
}

// Distinctive multi-headline spinner: sparkle/star cycle (vs the ASCII '- \ | /').
// Used only on the top-level parallel/chain/single header so the headline reads as
// "the container is alive" without making every per-agent row spin too.
const MULTI_SPINNER = ["\u2733", "\u2734", "\u2735", "\u2736", "\u2737", "\u2738", "\u2739", "\u273A", "\u273B", "\u273C", "\u273D"];
function multiSpinnerFrame(): string {
	return MULTI_SPINNER[Math.floor(Date.now() / WIDGET_ANIMATION_MS) % MULTI_SPINNER.length]!;
}

function resultIsRunning(result: AgentToolResult<Details>): boolean {
	return result.details?.progress?.some((entry) => entry.status === "running")
		|| result.details?.results.some((entry) => entry.progress?.status === "running")
		|| false;
}

function stopResultAnimation(context: ResultAnimationContext): void {
	const timer = context.state.subagentResultAnimationTimer;
	if (!timer) return;
	clearInterval(timer);
	resultAnimationTimers.delete(timer);
	context.state.subagentResultAnimationTimer = undefined;
}

export function syncResultAnimation(result: AgentToolResult<Details>, context: ResultAnimationContext): void {
	if (!resultIsRunning(result)) {
		stopResultAnimation(context);
		return;
	}
	if (context.state.subagentResultAnimationTimer) return;
	const timer = setInterval(() => context.invalidate(), WIDGET_ANIMATION_MS);
	timer.unref?.();
	context.state.subagentResultAnimationTimer = timer;
	resultAnimationTimers.set(timer, context.state);
}

function extractOutputTarget(task: string): string | undefined {
	const writeToMatch = task.match(/\[Write to:\s*([^\]\n]+)\]/i);
	if (writeToMatch?.[1]?.trim()) return writeToMatch[1].trim();
	const findingsMatch = task.match(/Write your findings to:\s*(\S+)/i);
	if (findingsMatch?.[1]?.trim()) return findingsMatch[1].trim();
	const outputMatch = task.match(/[Oo]utput(?:\s+to)?\s*:\s*(\S+)/i);
	if (outputMatch?.[1]?.trim()) return outputMatch[1].trim();
	return undefined;
}

function hasEmptyTextOutputWithoutOutputTarget(task: string, output: string): boolean {
	if (output.trim()) return false;
	return !extractOutputTarget(task);
}

function getToolCallLines(
	result: Pick<Details["results"][number], "messages" | "toolCalls">,
	expanded: boolean,
): string[] {
	if (result.messages) {
		return getDisplayItems(result.messages)
			.filter((item): item is { type: "tool"; name: string; args: Record<string, unknown> } => item.type === "tool")
			.map((item) => formatToolCall(item.name, item.args, expanded));
	}
	return result.toolCalls?.map((toolCall) => expanded ? toolCall.expandedText : toolCall.text) ?? [];
}

function formatActivityAge(ms: number): string {
	if (ms < 1000) return "now";
	if (ms < 60000) return `${Math.floor(ms / 1000)}s`;
	return `${Math.floor(ms / 60000)}m`;
}

function formatActivityLabel(lastActivityAt: number | undefined, needsAttention?: boolean, now = Date.now()): string | undefined {
	if (lastActivityAt === undefined) return needsAttention ? "needs attention" : undefined;
	const age = formatActivityAge(Math.max(0, now - lastActivityAt));
	return needsAttention ? `no activity for ${age}` : age === "now" ? "active now" : `active ${age} ago`;
}

function formatCurrentToolLine(progress: Pick<AgentProgress, "currentTool" | "currentToolArgs" | "currentToolStartedAt">, availableWidth: number, expanded: boolean): string | undefined {
	if (!progress.currentTool) return undefined;
	const maxToolArgsLen = Math.max(50, availableWidth - 20);
	const toolArgsPreview = progress.currentToolArgs
		? (expanded || progress.currentToolArgs.length <= maxToolArgsLen
			? progress.currentToolArgs
			: `${progress.currentToolArgs.slice(0, maxToolArgsLen)}...`)
		: "";
	const durationSuffix = progress.currentToolStartedAt !== undefined
		? ` | ${formatDuration(Math.max(0, Date.now() - progress.currentToolStartedAt))}`
		: "";
	return toolArgsPreview
		? `${progress.currentTool}: ${toolArgsPreview}${durationSuffix}`
		: `${progress.currentTool}${durationSuffix}`;
}

function buildLiveStatusLine(progress: Pick<AgentProgress, "activityState" | "lastActivityAt">): string | undefined {
	return formatActivityLabel(progress.lastActivityAt, progress.activityState === "needs_attention");
}

function themeBold(theme: Theme, text: string): string {
	return ((theme as { bold?: (value: string) => string }).bold?.(text)) ?? text;
}

function statJoin(theme: Theme, parts: string[]): string {
	return parts.filter(Boolean).map((part) => theme.fg("dim", part)).join(` ${theme.fg("dim", "·")} `);
}

function formatTokenStat(tokens: number): string {
	return `${formatTokens(tokens)} token`;
}

function formatToolUseStat(count: number): string {
	return `${count} tool use${count === 1 ? "" : "s"}`;
}

function formatTurnStat(turns: number | undefined): string {
	return turns ? `⟳ ${turns}` : "";
}

function formatProgressStats(theme: Theme, progress: Pick<AgentProgress, "toolCount" | "tokens" | "durationMs"> | undefined, includeDuration = true): string {
	if (!progress) return "";
	const parts: string[] = [];
	if (progress.toolCount > 0) parts.push(formatToolUseStat(progress.toolCount));
	if (progress.tokens > 0) parts.push(formatTokenStat(progress.tokens));
	if (includeDuration && progress.durationMs > 0) parts.push(formatDuration(progress.durationMs));
	return statJoin(theme, parts);
}

function firstOutputLine(text: string): string {
	return text.split("\n").find((line) => line.trim())?.trim() ?? "";
}

function resultStatusLine(result: Details["results"][number], output: string): string {
	if (result.detached) return result.detachedReason ? `Detached: ${result.detachedReason}` : "Detached";
	if (result.interrupted) return "Paused";
	if (result.exitCode !== 0) return `Error: ${result.error ?? (firstOutputLine(output) || `exit ${result.exitCode}`)}`;
	if (hasEmptyTextOutputWithoutOutputTarget(result.task, output)) return "Done (no text output)";
	return "Done";
}

function resultGlyph(result: Details["results"][number], output: string, theme: Theme, running = result.progress?.status === "running"): string {
	// Per-agent running glyph is static (was spinnerFrame()). Spinning every row
	// alongside the multi headline + tool elapsed timer was too much animation.
	// The multi headline keeps its sparkle spinner as the single liveness indicator.
	if (running) return theme.fg("accent", "◇");
	if (result.detached) return theme.fg("warning", "■");
	if (result.interrupted) return theme.fg("warning", "■");
	if (result.exitCode !== 0) return theme.fg("error", "✗");
	if (hasEmptyTextOutputWithoutOutputTarget(result.task, output)) return theme.fg("warning", "✓");
	return theme.fg("success", "✓");
}

function compactCurrentActivity(progress: AgentProgress): string {
	return formatCurrentToolLine(progress, getTermWidth() - 4, false) ?? buildLiveStatusLine(progress) ?? "thinking…";
}

/**
 * Build the live "what's happening right now" line for a running agent.
 * Priority: needs_attention warning → currently-executing tool → thinking timer → starting.
 * Returns { text, tone } so callers can apply the right color.
 */
function buildLiveCurrentLine(
	progress: AgentProgress,
	availableWidth: number,
): { text: string; tone: "warning" | "accent" | "dim" } {
	const needsAttention = progress.activityState === "needs_attention";
	if (needsAttention) {
		const age = progress.lastActivityAt !== undefined
			? formatActivityAge(Math.max(0, Date.now() - progress.lastActivityAt))
			: "a while";
		return { text: `! no activity for ${age}`, tone: "warning" };
	}
	const toolLine = formatCurrentToolLine(progress, availableWidth, false);
	if (toolLine) return { text: toolLine, tone: "accent" };
	if (progress.lastToolEndAt !== undefined) {
		// Thinking pressure bar removed: visual fill added little over the elapsed
		// number, and being the widest bar it dominated attention. The thinking
		// level's tone-flip (warning past saturation) is preserved via thinkingBarMaxMs.
		const thinkingMs = Math.max(0, Date.now() - progress.lastToolEndAt);
		const tone: "dim" | "warning" = thinkingMs > thinkingBarMaxMs(progress.thinking) ? "warning" : "dim";
		return { text: `thinking ${formatDuration(thinkingMs)}`, tone };
	}
	if (progress.toolCount === 0) return { text: "starting…", tone: "dim" };
	return { text: "thinking…", tone: "dim" };
}

/**
 * Build N history breadcrumb lines from progress.recentTools (most-recent first).
 * Returns plain strings (no theming) suitable for dim styling at the call site.
 */
function buildLiveHistoryLines(
	progress: AgentProgress,
	count: number,
	availableWidth: number,
): string[] {
	if (count <= 0 || !progress.recentTools?.length) return [];
	// Chronological order: oldest first, newest last. The renderer places this above
	// the current-activity line so the freshest event sits adjacent to "now".
	const slice = progress.recentTools.slice(-count);
	const maxArgsLen = Math.max(20, availableWidth - 24);
	return slice.map((entry) => {
		const args = entry.args
			? (entry.args.length <= maxArgsLen ? entry.args : `${entry.args.slice(0, maxArgsLen)}...`)
			: "";
		const durationSuffix = entry.durationMs !== undefined ? `  ${formatDuration(entry.durationMs)}` : "";
		return args
			? `← ${entry.tool}: ${args}${durationSuffix}`
			: `← ${entry.tool}${durationSuffix}`;
	});
}

/**
 * Choose how many history lines to render per agent given how many are running concurrently.
 * 1 running: 2 lines. 2-4 running: 2 lines. 5-8 running: 1 line. 9+: 0 lines (header-only).
 */
function historyLinesForRunningCount(runningCount: number): number {
	if (runningCount <= 1) return 2;
	if (runningCount <= 4) return 1;
	return 0;
}

const SPARK_CHARS = ["\u2581", "\u2582", "\u2583", "\u2584", "\u2585", "\u2586", "\u2587", "\u2588"];

/**
 * Build a sparkline from token samples. Buckets the time window into `width` slots and
 * renders the per-bucket token *delta* (rate) as block characters normalized to the peak
 * in this window. Returns '' for <2 samples (not enough signal yet).
 */
/**
 * Global ceiling for sparkline normalization (tokens/sec). All sparklines render against
 * the same fixed scale so quiet and loud agents are visually comparable across rows.
 * Cube-root scaled (rate/CEILING)^(1/3): 10 tok/s -> 11%, 100 -> 23%, 1000 -> 50%, 8000 -> 100%;
 * clipped above. Loud agents still visibly dominate but a slow grep isn't invisible.
 */
const SPARKLINE_RATE_CEILING = 8000;

function buildSparkline(
	samples: ReadonlyArray<{ ts: number; tokens: number }> | undefined,
	width = 8,
	theme?: Theme,
	now = Date.now(),
): string {
	if (!samples || samples.length < 2 || width <= 0) return "";
	const windowMs = 240_000;

	// Wall-clock anchored, BUT quantized to cell boundaries to avoid sub-cell
	// drift (the "worm"). Each cell represents windowMs/width of real time.
	// We round `now` down to the nearest cell-duration so re-bucketing happens
	// only when wall-clock crosses a cell boundary -- clean 1-cell step shifts,
	// not 80ms-per-frame smear. Samples still decay leftward as they age.
	const cellMs = windowMs / width;
	const anchor = Math.floor(now / cellMs) * cellMs;
	const cutoff = anchor - windowMs;

	// Compute per-pair rates anchored to the later sample's timestamp.
	const deltas: Array<{ ts: number; rate: number }> = [];
	for (let i = 1; i < samples.length; i++) {
		const cur = samples[i]!;
		const prev = samples[i - 1]!;
		if (cur.ts < cutoff) continue;
		const dtSec = Math.max(0.05, (cur.ts - prev.ts) / 1000);
		const dTok = Math.max(0, cur.tokens - prev.tokens);
		deltas.push({ ts: cur.ts, rate: dTok / dtSec });
	}

	const buckets = new Array<number>(width).fill(0);
	const counts = new Array<number>(width).fill(0);
	for (const d of deltas) {
		// Samples newer than the floored anchor (i.e. since the last cell boundary)
		// belong in the rightmost cell, not skipped.
		const ageMs = Math.max(0, anchor - d.ts);
		if (ageMs >= windowMs) continue;
		// idx 0 = oldest, idx width-1 = freshest. Bias slightly so the very
		// freshest sample (ageMs ~= 0) always lands in the rightmost cell.
		const frac = Math.min(0.9999, 1 - ageMs / windowMs);
		const idx = Math.min(width - 1, Math.max(0, Math.floor(frac * width)));
		buckets[idx]! += d.rate;
		counts[idx]! += 1;
	}
	for (let i = 0; i < width; i++) {
		if (counts[i]! > 0) buckets[i] = buckets[i]! / counts[i]!;
	}

	// All-empty: render a width-preserving invisible track of spaces so right-align stays stable.
	if (buckets.every((b) => b <= 0)) return " ".repeat(width);

	let out = "";
	for (let i = 0; i < width; i++) {
		if (counts[i] === 0 || buckets[i]! <= 0) {
			// Empty cell = no baseline glyph. Use a space so bars appear to float
			// on an unbounded canvas while still occupying the cell for alignment.
			out += " ";
			continue;
		}
		// Cube-root normalized against the global ceiling. Gentler than log so the visual
		// gap between e.g. 100 and 1000 tok/s stays clear, while a slow agent still shows.
		const rel = Math.min(1, Math.cbrt(buckets[i]! / SPARKLINE_RATE_CEILING));
		const gi = Math.min(SPARK_CHARS.length - 1, Math.max(0, Math.floor(rel * SPARK_CHARS.length)));
		const ch = SPARK_CHARS[gi]!;
		out += theme ? theme.fg("accent", ch) : ch;
	}
	return out;
}

/**
 * Build a "thinking pressure" bar. 8 cells fill on a soft log scale up to ~8s.
 * Returns { bar, tone } where tone is 'dim' for normal and 'warning' past 5s.
 */
function buildThinkingBar(
	thinkingMs: number,
	width = 8,
	thinkingLevel?: string,
): { bar: string; tone: "dim" | "warning" } {
	const clamped = Math.max(0, thinkingMs);
	const maxMs = thinkingBarMaxMs(thinkingLevel);
	const maxSec = maxMs / 1000;
	// Soft log scale: 0 -> 0, maxSec -> full, asymptotic past.
	const frac = Math.min(1, Math.log10(1 + clamped / 1000) / Math.log10(1 + maxSec));
	const filled = Math.round(frac * width);
	// Use full block / light shade (both fill the cell on the same baseline).
	// U+2586 (lower three quarters block) sits low and visually mis-aligns with U+2591.
	const bar = "\u2588".repeat(filled) + "\u2591".repeat(Math.max(0, width - filled));
	return { bar, tone: clamped > maxMs ? "warning" : "dim" };
}

/**
 * Build a chain progress bar. `done` slots filled (success), `running` slots filled (accent),
 * remainder empty (dim). Returns the themed string ready to embed.
 */
function buildChainBar(theme: Theme, done: number, running: number, total: number, width = 8): string {
	if (total <= 0) return "";
	const d = Math.max(0, Math.min(total, done));
	const r = Math.max(0, Math.min(total - d, running));
	const doneCells = Math.round((d / total) * width);
	const runCells = Math.round(((d + r) / total) * width) - doneCells;
	const emptyCells = Math.max(0, width - doneCells - runCells);
	return theme.fg("success", "\u25b0".repeat(doneCells))
		+ theme.fg("accent", "\u25b0".repeat(Math.max(0, runCells)))
		+ theme.fg("dim", "\u25b1".repeat(emptyCells));
}

/**
 * Map a thinking effort level to the soft-log saturation point in milliseconds.
 * Past this point the thinking bar reads as "full" and the tone flips to warning.
 */
function thinkingBarMaxMs(level?: string): number {
	switch (level) {
		case "xhigh": return 60_000;
		case "high": return 30_000;
		case "medium": return 15_000;
		case "low": return 8_000;
		case "minimal":
		case "off":
		case undefined:
			return 5_000;
		default: return 15_000;
	}
}

/**
 * Width for progress bars scales with terminal width.
 * 120-wide -> 15, 180-wide -> 22, 240-wide -> 30, hard cap 40.
 */
function adaptiveBarWidth(): number {
	const termWidth = getTermWidth();
	return Math.max(8, Math.min(40, Math.floor(termWidth / 8)));
}

/**
 * Width for the inline sparkline. Same family as adaptiveBarWidth but capped a touch lower
 * so the right-aligned sparkline doesn't crowd the stats column.
 */
function adaptiveSparkWidth(): number {
	const termWidth = getTermWidth();
	// Aggressive on wide terminals: 120w → 20, 180w → 30, 240w → 40, 320w → 53, cap 80.
	return Math.max(8, Math.min(80, Math.floor(termWidth / 6)));
}

/**
 * History line count for a single-agent compact block scales with terminal height.
 * 24-row term -> 3, 40-row -> 7, 60-row -> 10.
 */
function adaptiveSingleHistoryCount(): number {
	const rows = process.stdout.rows || 24;
	return Math.max(2, Math.min(10, Math.floor((rows - 10) / 4)));
}

function hasAnimatedWidgetJobs(jobs: AsyncJobState[]): boolean {
	return jobs.some((job) => job.status === "running");
}

function widgetJobName(job: AsyncJobState): string {
	if (job.agents?.length) return job.agents.join(" → ");
	return job.mode ?? "subagent";
}

function getCachedLastActivity(outputFile: string | undefined): string {
	if (!outputFile) return "";
	const now = Date.now();
	const cached = outputActivityCache.get(outputFile);
	if (cached && now - cached.checkedAt < 1000) return cached.text;
	const text = getLastActivity(outputFile);
	outputActivityCache.set(outputFile, { checkedAt: now, text });
	return text;
}

function widgetActivity(job: AsyncJobState): string {
	if (job.currentTool && job.currentToolStartedAt !== undefined) {
		return `${job.currentTool} ${formatDuration(Math.max(0, Date.now() - job.currentToolStartedAt))}`;
	}
	const activity = formatActivityLabel(job.lastActivityAt, job.activityState === "needs_attention")
		?? (job.status === "running" ? getCachedLastActivity(job.outputFile) : "");
	if (activity) return activity;
	if (job.status === "queued") return "queued…";
	if (job.status === "paused") return "Paused";
	if (job.status === "failed") return "Failed";
	return "Done";
}

function widgetStatusGlyph(job: AsyncJobState, theme: Theme): string {
	// Running rows get the distinctive sparkle spinner (same family as the multi-headline
	// spinner inline). The old ASCII `- \ | /` read as a dash, not a spinner.
	if (job.status === "running") return theme.fg("accent", multiSpinnerFrame());
	if (job.status === "queued") return theme.fg("muted", "◦");
	if (job.status === "complete") return theme.fg("success", "✓");
	if (job.status === "paused") return theme.fg("warning", "■");
	return theme.fg("error", "✗");
}

function widgetStats(job: AsyncJobState, theme: Theme): string {
	const parts: string[] = [];
	const stepsTotal = job.stepsTotal ?? (job.agents?.length ?? 1);
	if (job.currentStep !== undefined) parts.push(`step ${job.currentStep + 1}/${stepsTotal}`);
	else if (stepsTotal > 1) parts.push(`steps ${stepsTotal}`);
	if (job.totalTokens?.total) parts.push(formatTokenStat(job.totalTokens.total));
	const endTime = job.status === "complete" || job.status === "failed" || job.status === "paused" ? (job.updatedAt ?? Date.now()) : Date.now();
	if (job.startedAt) parts.push(formatDuration(Math.max(0, endTime - job.startedAt)));
	return statJoin(theme, parts);
}

/**
 * Synthesize an AgentProgress-shaped object from AsyncJobState so the widget can reuse
 * buildLiveCurrentLine / buildLiveHistoryLines / buildSparkline verbatim. Only the fields
 * those helpers read are populated; the rest are stubs.
 */
function widgetProgressFromJob(job: AsyncJobState): AgentProgress {
	return {
		index: job.currentStep ?? 0,
		agent: job.currentAgent ?? job.agents?.[job.currentStep ?? 0] ?? "subagent",
		status: job.status === "running" ? "running" : job.status === "complete" ? "completed" : job.status === "failed" ? "failed" : "pending",
		activityState: job.activityState,
		task: "",
		lastActivityAt: job.lastActivityAt,
		currentTool: job.currentTool,
		currentToolArgs: job.currentToolArgs,
		currentToolStartedAt: job.currentToolStartedAt,
		lastToolEndAt: job.lastToolEndAt,
		recentTools: (job.recentTools ?? []).map((t) => ({ tool: t.tool, args: t.args ?? "", endMs: t.endMs ?? 0, durationMs: t.durationMs })),
		recentOutput: [],
		tokenSamples: job.tokenSamples,
		thinking: job.thinking,
		color: job.agentColor,
		toolCount: job.recentTools?.length ?? 0,
		tokens: job.totalTokens?.total ?? 0,
		durationMs: job.startedAt ? Date.now() - job.startedAt : 0,
	};
}

/**
 * Widget-specific history density: stricter than inline (`historyLinesForRunningCount`)
 * because the sidebar is narrow and per-job height is precious.
 * 1 running -> 2 lines, 2 -> 1, 3+ -> 0.
 */
function widgetHistoryLines(runningCount: number): number {
	if (runningCount <= 1) return 2;
	if (runningCount === 2) return 1;
	return 0;
}

const WIDGET_SPARK_WIDTH = 8;

function widgetSparkline(samples: ReadonlyArray<{ ts: number; tokens: number }> | undefined, theme: Theme, now: number): string {
	if (!samples || samples.length < 2) return "";
	return buildSparkline(samples, WIDGET_SPARK_WIDTH, theme, now);
}

export function buildWidgetLines(jobs: AsyncJobState[], theme: Theme, width = getTermWidth()): string[] {
	if (jobs.length === 0) return [];
	const running = jobs.filter((job) => job.status === "running");
	const queued = jobs.filter((job) => job.status === "queued");
	const finished = jobs.filter((job) => job.status !== "running" && job.status !== "queued");

	const lines: string[] = [];
	const hasActive = running.length > 0 || queued.length > 0;
	lines.push(truncLine(`${theme.fg(hasActive ? "accent" : "dim", hasActive ? "●" : "○")} ${theme.fg(hasActive ? "accent" : "dim", "Agents")} ${theme.fg("dim", "· /subagents-status")}`, width));

	const items: string[][] = [];
	let hiddenRunning = 0;
	let hiddenFinished = 0;
	let queuedSummaryShown = false;
	let slots = MAX_WIDGET_JOBS;
	const historyN = widgetHistoryLines(running.length);

	for (const job of running) {
		if (slots <= 0) { hiddenRunning++; continue; }
		const stats = widgetStats(job, theme);
		const progress = widgetProgressFromJob(job);
		const boldName = themeBold(theme, widgetJobName(job));
		const tintedName = job.agentColor ? tintAgentName(boldName, job.agentColor) : boldName;
		// Inline sparkline immediately after stats (no right-align). The widget panel is
		// narrower than the terminal, so right-padding to full width pushed the spark off
		// the right edge where truncLine then chopped it (visible as a trailing ellipsis).
		const spark = widgetSparkline(job.tokenSamples, theme, Date.now());
		const sparkTail = spark ? ` ${spark}` : "";
		const headLine = `${widgetStatusGlyph(job, theme)} ${tintedName}${stats ? ` ${theme.fg("dim", "·")} ${stats}` : ""}${sparkTail}`;
		const rows: string[] = [headLine];
		const innerWidth = Math.max(20, width - 6);
		const history = buildLiveHistoryLines(progress, historyN, innerWidth);
		for (const h of history) {
			rows.push(`  ${theme.fg("dim", `├─ ${h}`)}`);
		}
		const current = buildLiveCurrentLine(progress, innerWidth);
		rows.push(`  ${theme.fg("dim", "└─")} ${theme.fg(current.tone, current.text)}`);
		items.push(rows);
		slots--;
	}

	if (queued.length > 0 && slots > 0) {
		items.push([`${theme.fg("muted", "◦")} ${theme.fg("dim", `${queued.length} queued`)}`]);
		queuedSummaryShown = true;
		slots--;
	}

	for (const job of finished) {
		if (slots <= 0) { hiddenFinished++; continue; }
		const stats = widgetStats(job, theme);
		const boldName = themeBold(theme, widgetJobName(job));
		// Keep tint for finished jobs (terminal step persists agentColor).
		const tintedName = job.agentColor ? tintAgentName(boldName, job.agentColor) : boldName;
		// Frozen sparkline: anchor `now` at the last sample so finished bars don't crawl.
		const lastTs = job.tokenSamples?.[job.tokenSamples.length - 1]?.ts;
		const spark = lastTs !== undefined ? widgetSparkline(job.tokenSamples, theme, lastTs) : "";
		const sparkTail = spark ? ` ${spark}` : "";
		const headLine = `${widgetStatusGlyph(job, theme)} ${tintedName}${stats ? ` ${theme.fg("dim", "·")} ${stats}` : ""}${sparkTail}`;
		items.push([
			headLine,
			`  ${theme.fg("dim", `└─ ${widgetActivity(job)}`)}`,
		]);
		slots--;
	}

	const hiddenQueued = queued.length > 0 && !queuedSummaryShown ? queued.length : 0;
	const hiddenTotal = hiddenRunning + hiddenFinished + hiddenQueued;
	if (hiddenTotal > 0) {
		const parts: string[] = [];
		if (hiddenRunning > 0) parts.push(`${hiddenRunning} running`);
		if (hiddenQueued > 0) parts.push(`${hiddenQueued} queued`);
		if (hiddenFinished > 0) parts.push(`${hiddenFinished} finished`);
		items.push([theme.fg("dim", `+${hiddenTotal} more (${parts.join(", ")})`)]);
	}

	for (let i = 0; i < items.length; i++) {
		const item = items[i]!;
		const last = i === items.length - 1;
		const branch = last ? "└─" : "├─";
		const continuation = last ? "   " : "│  ";
		lines.push(truncLine(`${theme.fg("dim", branch)} ${item[0]}`, width));
		for (const detail of item.slice(1)) {
			lines.push(truncLine(`${theme.fg("dim", continuation)} ${detail}`, width));
		}
	}

	return lines;
}

function refreshAnimatedWidget(): void {
	if (!latestWidgetCtx?.hasUI || latestWidgetJobs.length === 0) return;
	latestWidgetCtx.ui.setWidget(WIDGET_KEY, buildWidgetLines(latestWidgetJobs, latestWidgetCtx.ui.theme));
	latestWidgetCtx.ui.requestRender?.();
}

function ensureWidgetAnimation(): void {
	if (widgetTimer) return;
	widgetTimer = setInterval(() => {
		if (!hasAnimatedWidgetJobs(latestWidgetJobs)) {
			stopWidgetAnimation();
			return;
		}
		refreshAnimatedWidget();
	}, WIDGET_ANIMATION_MS);
	widgetTimer.unref?.();
}

export function stopWidgetAnimation(): void {
	if (widgetTimer) {
		clearInterval(widgetTimer);
		widgetTimer = undefined;
	}
	latestWidgetCtx = undefined;
	latestWidgetJobs = [];
	outputActivityCache.clear();
}

export function stopResultAnimations(): void {
	for (const [timer, state] of resultAnimationTimers) {
		clearInterval(timer);
		state.subagentResultAnimationTimer = undefined;
	}
	resultAnimationTimers.clear();
}

/**
 * Render the async jobs widget
 */
export function renderWidget(ctx: ExtensionContext, jobs: AsyncJobState[]): void {
	if (jobs.length === 0) {
		stopWidgetAnimation();
		if (ctx.hasUI) ctx.ui.setWidget(WIDGET_KEY, undefined);
		return;
	}
	if (!ctx.hasUI) {
		stopWidgetAnimation();
		return;
	}
	latestWidgetCtx = ctx;
	latestWidgetJobs = [...jobs];

	ctx.ui.setWidget(WIDGET_KEY, buildWidgetLines(jobs, ctx.ui.theme));
	if (hasAnimatedWidgetJobs(jobs)) ensureWidgetAnimation();
	else stopWidgetAnimation();
}

function renderSingleCompact(d: Details, r: Details["results"][number], theme: Theme): Component {
	const output = r.truncation?.text || getSingleResultOutput(r);
	const progress = r.progress || r.progressSummary;
	const isRunning = r.progress?.status === "running";
	const contextBadge = d.context === "fork" ? theme.fg("warning", " [fork]") : "";
	const stats = statJoin(theme, [
		formatTurnStat(r.usage?.turns),
		formatProgressStats(theme, progress),
	]);
	const c = new Container();
	const width = getTermWidth() - 4;
	// Sparkline persists after completion: when not running, anchor `now` to the
	// last sample's timestamp so the final shape freezes at the moment of finish
	// rather than continuing to age leftward into oblivion.
	const sparkSamples = r.progress?.tokenSamples;
	const sparkNow = isRunning ? Date.now() : (sparkSamples?.[sparkSamples.length - 1]?.ts ?? Date.now());
	const spark = r.progress && sparkSamples && sparkSamples.length >= 2
		? buildSparkline(sparkSamples, adaptiveSparkWidth(), theme, sparkNow)
		: "";
	// Single-agent block has no parent headline above it, so the row glyph itself
	// must carry the liveness signal -- use the sparkle spinner instead of the
	// static ◇ that resultGlyph returns for running multi-block rows.
	const headGlyph = isRunning ? theme.fg("accent", multiSpinnerFrame()) : resultGlyph(r, output, theme, isRunning);
	const boldName = theme.bold(r.agent);
	const tintedName = r.progress?.color ? tintAgentName(boldName, r.progress.color) : theme.fg("toolTitle", boldName);
	const headBase = `${headGlyph} ${tintedName}${contextBadge}${stats ? ` ${theme.fg("dim", "·")} ${stats}` : ""}`;
	c.addChild(new Text(truncLine(rightAlignSuffix(headBase, spark, width), width), 0, 0));

	if (isRunning && r.progress) {
		const current = buildLiveCurrentLine(r.progress, width);
		const history = buildLiveHistoryLines(r.progress, adaptiveSingleHistoryCount(), width);
		// Chronological layout: history (oldest -> newest) on top, current activity at the bottom
		// so the freshest information sits right next to "now".
		for (let i = 0; i < history.length; i++) {
			c.addChild(new Text(truncLine(theme.fg("dim", `  ├─ ${history[i]}`), width), 0, 0));
		}
		c.addChild(new Text(truncLine(`${theme.fg("dim", "  └─")} ${theme.fg(current.tone, current.text)}`, width), 0, 0));
		return c;
	}

	c.addChild(new Text(truncLine(theme.fg("dim", `  └─ ${resultStatusLine(r, output)}`), width), 0, 0));
	const preview = firstOutputLine(output);
	if (preview && r.exitCode === 0 && !hasEmptyTextOutputWithoutOutputTarget(r.task, output)) {
		c.addChild(new Text(truncLine(theme.fg("dim", `     ${preview}`), width), 0, 0));
	}
	if (r.artifactPaths) c.addChild(new Text(truncLine(theme.fg("dim", `  output: ${shortenPath(r.artifactPaths.outputPath)}`), width), 0, 0));
	if (r.truncation?.artifactPath) c.addChild(new Text(truncLine(theme.fg("dim", `  full output: ${shortenPath(r.truncation.artifactPath)}`), width), 0, 0));
	return c;
}

function renderMultiCompact(d: Details, theme: Theme): Component {
	const hasRunning = d.progress?.some((p) => p.status === "running")
		|| d.results.some((r) => r.progress?.status === "running");
	const ok = d.results.filter((r) =>
		!r.interrupted
		&& !r.detached
		&& (r.progress?.status === "completed" || (r.exitCode === 0 && r.progress?.status !== "running" && r.progress?.status !== "pending"))
	).length;
	const failed = d.results.some((r) => r.exitCode !== 0 && r.progress?.status !== "running");
	const paused = d.results.some((r) => (r.interrupted || r.detached) && r.progress?.status !== "running");
	const totalTurns = d.results.reduce((sum, r) => sum + (r.usage?.turns || 0), 0);
	let totalSummary = d.progressSummary;
	if (!totalSummary) {
		let sawProgress = false;
		const summary = { toolCount: 0, tokens: 0, durationMs: 0 };
		for (const r of d.results) {
			const prog = r.progress || r.progressSummary;
			if (!prog) continue;
			sawProgress = true;
			summary.toolCount += prog.toolCount;
			summary.tokens += prog.tokens;
			summary.durationMs = d.mode === "chain" ? summary.durationMs + prog.durationMs : Math.max(summary.durationMs, prog.durationMs);
		}
		if (sawProgress) totalSummary = summary;
	}
	const hasParallelInChain = d.chainAgents?.some((a) => a.startsWith("["));
	const totalCount = hasParallelInChain ? d.results.length : (d.totalSteps ?? d.results.length);
	const currentStep = d.currentStepIndex !== undefined ? d.currentStepIndex + 1 : Math.min(totalCount, ok + (hasRunning ? 1 : 0));
	const itemLabel = d.mode === "parallel" ? "agent" : "step";
	const itemTitle = d.mode === "parallel" ? "Agent" : "Step";
	const stepInfo = hasRunning ? `${itemLabel} ${currentStep}/${totalCount}` : `${itemLabel} ${ok}/${totalCount}`;
	const stats = statJoin(theme, [stepInfo, formatTurnStat(totalTurns), formatProgressStats(theme, totalSummary)]);
	const glyph = hasRunning
		? theme.fg("accent", multiSpinnerFrame())
		: failed
			? theme.fg("error", "✗")
			: paused
				? theme.fg("warning", "■")
				: theme.fg("success", "✓");
	const contextBadge = d.context === "fork" ? theme.fg("warning", " [fork]") : "";
	const c = new Container();
	const width = getTermWidth() - 4;
	// Chain progress bar for chain mode only (parallel/swarm have no inherent order).
	const chainBar = (d.mode === "chain" && !hasParallelInChain && totalCount > 1)
		? buildChainBar(theme, ok, hasRunning ? 1 : 0, totalCount, adaptiveBarWidth())
		: "";
	const chainBarPrefix = chainBar ? `${chainBar} ` : "";
	// Only emit the '· stats' tail when stats is non-empty (prevents a hanging '· ' on empty early frames).
	const statsTail = stats ? ` ${theme.fg("dim", "·")} ${stats}` : "";
	const headlinePrefix = chainBarPrefix ? ` ${chainBarPrefix}` : "";
	c.addChild(new Text(truncLine(`${glyph} ${theme.fg("toolTitle", theme.bold(d.mode))}${contextBadge}${headlinePrefix}${statsTail}`, width), 0, 0));

	const useResultsDirectly = hasParallelInChain || !d.chainAgents?.length;
	const stepsToShow = useResultsDirectly ? d.results.length : d.chainAgents!.length;

	// Count concurrently-running agents so we can adapt history density.
	let runningCount = 0;
	for (let i = 0; i < stepsToShow; i++) {
		const r = d.results[i];
		if (!r) continue;
		const pf = d.progress?.find((p) => p.index === i) || d.progress?.find((p) => p.agent === r.agent && p.status === "running");
		const rp = r.progress || pf || r.progressSummary;
		if (rp && "status" in rp && rp.status === "running") runningCount++;
	}
	const historyN = historyLinesForRunningCount(runningCount);

	for (let i = 0; i < stepsToShow; i++) {
		const r = d.results[i];
		const agentName = useResultsDirectly ? (r?.agent || `${itemLabel}-${i + 1}`) : (d.chainAgents![i] || r?.agent || `${itemLabel}-${i + 1}`);
		if (!r) {
			c.addChild(new Text(truncLine(theme.fg("dim", `  ◦ ${itemTitle} ${i + 1}: ${agentName} · pending`), width), 0, 0));
			continue;
		}
		const output = getSingleResultOutput(r);
		const progressFromArray = d.progress?.find((p) => p.index === i) || d.progress?.find((p) => p.agent === r.agent && p.status === "running");
		const rProg = r.progress || progressFromArray || r.progressSummary;
		const rRunning = rProg && "status" in rProg && rProg.status === "running";
		const rPending = rProg && "status" in rProg && rProg.status === "pending";
		const stepNumber = r.progress?.index !== undefined ? r.progress.index + 1 : progressFromArray?.index !== undefined ? progressFromArray.index + 1 : i + 1;
		const stepStats = statJoin(theme, [
			formatTurnStat(r.usage?.turns),
			formatProgressStats(theme, rProg),
		]);
		const glyph = rPending ? theme.fg("dim", "◦") : resultGlyph(r, output, theme, rRunning);
		const pendingLabel = rPending ? ` ${theme.fg("dim", "· pending")}` : "";
		// Sparkline source: prefer r.progress, fall back to progressFromArray (live updates put a full AgentProgress in d.progress).
		const fullProgForSpark = r.progress
			?? (progressFromArray && "tokenSamples" in progressFromArray ? progressFromArray as AgentProgress : undefined);
		const sparkSamples = fullProgForSpark?.tokenSamples;
		const sparkNow = rRunning ? Date.now() : (sparkSamples?.[sparkSamples.length - 1]?.ts ?? Date.now());
		const spark = fullProgForSpark && sparkSamples && sparkSamples.length >= 2
			? buildSparkline(sparkSamples, adaptiveSparkWidth(), theme, sparkNow)
			: "";
		const rowBoldName = themeBold(theme, agentName);
		// Color survives completion: read from any progress-shaped object that carries it.
		const rowColor = r.progress?.color
			?? (progressFromArray && "color" in progressFromArray ? (progressFromArray as { color?: string }).color : undefined);
		const coloredName = rowColor ? tintAgentName(rowBoldName, rowColor) : rowBoldName;
		const lineBase = `  ${glyph} ${itemTitle} ${stepNumber}: ${coloredName}${stepStats ? ` ${theme.fg("dim", "·")} ${stepStats}` : ""}${pendingLabel}`;
		c.addChild(new Text(truncLine(rightAlignSuffix(lineBase, spark, width), width), 0, 0));
		if (rRunning && rProg && "status" in rProg) {
			const fullProg = r.progress ?? (progressFromArray && "recentTools" in progressFromArray ? progressFromArray as AgentProgress : undefined);
			if (fullProg) {
				const current = buildLiveCurrentLine(fullProg, width);
				const history = buildLiveHistoryLines(fullProg, historyN, width);
				// Chronological layout: history (oldest -> newest) on top, current activity at the bottom.
				for (let h = 0; h < history.length; h++) {
					c.addChild(new Text(truncLine(theme.fg("dim", `    ├─ ${history[h]}`), width), 0, 0));
				}
				c.addChild(new Text(truncLine(`${theme.fg("dim", "    └─")} ${theme.fg(current.tone, current.text)}`, width), 0, 0));
			} else {
				// Fallback when only ProgressSummary is available (no recentTools).
				const activity = compactCurrentActivity(rProg as AgentProgress);
				c.addChild(new Text(truncLine(theme.fg("dim", `    └─ ${activity}`), width), 0, 0));
			}
		} else if (!rPending && (r.exitCode !== 0 || r.interrupted || r.detached || hasEmptyTextOutputWithoutOutputTarget(r.task, output))) {
			c.addChild(new Text(truncLine(theme.fg(r.exitCode !== 0 ? "error" : "dim", `    └─ ${resultStatusLine(r, output)}`), width), 0, 0));
		}
		// Spacer between running blocks only (skip after last row; skip after completed/pending rows).
		// Running blocks are dense (header + current + N history) and benefit from a breathing line.
		// Completed/pending blocks stay compact so scrollback doesn't bloat.
		// pi-tui's empty Text collapses to 0 height; use Spacer(1) to actually allocate a row.
		if (rRunning && i < stepsToShow - 1) {
			c.addChild(new Spacer(1));
		}
	}
	if (!hasRunning && d.artifacts) c.addChild(new Text(truncLine(theme.fg("dim", `  artifacts: ${shortenPath(d.artifacts.dir)}`), width), 0, 0));
	return c;
}

/**
 * Render a subagent result
 */
export function renderSubagentResult(
	result: AgentToolResult<Details>,
	options: { expanded: boolean },
	theme: Theme,
): Component {
	const d = result.details;
	if (!d || !d.results.length) {
		const t = result.content[0];
		const text = t?.type === "text" ? t.text : "(no output)";
		const contextPrefix = d?.context === "fork" ? `${theme.fg("warning", "[fork]")} ` : "";
		const width = getTermWidth() - 4;
		const lines = text.split("\n");
		if (lines.length === 1) return new Text(truncLine(`${contextPrefix}${text}`, width), 0, 0);
		const c = new Container();
		lines.forEach((line, index) => {
			c.addChild(new Text(truncLine(`${index === 0 ? contextPrefix : ""}${line}`, width), 0, 0));
		});
		return c;
	}

	const expanded = options.expanded;
	const mdTheme = getMarkdownTheme();

	if (d.mode === "single" && d.results.length === 1) {
		const r = d.results[0];
		if (!expanded) return renderSingleCompact(d, r, theme);
		const isRunning = r.progress?.status === "running";
		const icon = isRunning
			? theme.fg("warning", "running")
			: r.detached
				? theme.fg("warning", "detached")
				: r.exitCode === 0
					? theme.fg("success", "ok")
					: theme.fg("error", "failed");
		const contextBadge = d.context === "fork" ? theme.fg("warning", " [fork]") : "";
		const output = r.truncation?.text || getSingleResultOutput(r);

		const progressInfo = isRunning && r.progress
			? ` | ${r.progress.toolCount} tools, ${formatTokens(r.progress.tokens)} tok, ${formatDuration(r.progress.durationMs)}`
			: r.progressSummary
				? ` | ${r.progressSummary.toolCount} tools, ${formatTokens(r.progressSummary.tokens)} tok, ${formatDuration(r.progressSummary.durationMs)}`
				: "";

		const w = getTermWidth() - 4;
		const fit = (text: string) => expanded ? text : truncLine(text, w);
		const toolCallLines = getToolCallLines(r, expanded);
		const c = new Container();
		c.addChild(new Text(fit(`${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${contextBadge}${progressInfo}`), 0, 0));
		c.addChild(new Spacer(1));
		const taskMaxLen = Math.max(20, w - 8);
		const taskPreview = expanded || r.task.length <= taskMaxLen
			? r.task
			: `${r.task.slice(0, taskMaxLen)}...`;
		c.addChild(
			new Text(fit(theme.fg("dim", `Task: ${taskPreview}`)), 0, 0),
		);
		c.addChild(new Spacer(1));

		if (isRunning && r.progress) {
			const toolLine = formatCurrentToolLine(r.progress, w, expanded);
			if (toolLine) {
				c.addChild(new Text(fit(theme.fg("warning", `> ${toolLine}`)), 0, 0));
			}
			const liveStatusLine = buildLiveStatusLine(r.progress);
			if (liveStatusLine) {
				c.addChild(new Text(fit(theme.fg("accent", liveStatusLine)), 0, 0));
			}
			c.addChild(new Text(fit(theme.fg("accent", "Press Ctrl+O for live detail")), 0, 0));
			if (r.artifactPaths) {
				c.addChild(new Text(fit(theme.fg("dim", `Artifacts: ${shortenPath(r.artifactPaths.outputPath)}`)), 0, 0));
			}
			if (r.progress.recentTools?.length) {
				for (const t of r.progress.recentTools.slice(-3)) {
					const maxArgsLen = Math.max(40, w - 24);
					const argsPreview = expanded || t.args.length <= maxArgsLen
						? t.args
						: `${t.args.slice(0, maxArgsLen)}...`;
					c.addChild(new Text(fit(theme.fg("dim", `${t.tool}: ${argsPreview}`)), 0, 0));
				}
			}
			for (const line of (r.progress.recentOutput ?? []).slice(-5)) {
				c.addChild(new Text(fit(theme.fg("dim", `  ${line}`)), 0, 0));
			}
			if (toolLine || liveStatusLine || r.progress.recentTools?.length || r.progress.recentOutput?.length || r.artifactPaths) {
				c.addChild(new Spacer(1));
			}
		}

		if (expanded) {
			for (const line of toolCallLines) {
				c.addChild(new Text(fit(theme.fg("muted", line)), 0, 0));
			}
			if (toolCallLines.length) c.addChild(new Spacer(1));
		}

		if (output) c.addChild(new Markdown(output, 0, 0, mdTheme));
		c.addChild(new Spacer(1));
		if (r.skills?.length) {
			c.addChild(new Text(fit(theme.fg("dim", `Skills: ${r.skills.join(", ")}`)), 0, 0));
		}
		if (r.skillsWarning) {
			c.addChild(new Text(fit(theme.fg("warning", `Warning: ${r.skillsWarning}`)), 0, 0));
		}
		if (r.attemptedModels && r.attemptedModels.length > 1) {
			c.addChild(new Text(fit(theme.fg("dim", `Fallbacks: ${r.attemptedModels.join(" → ")}`)), 0, 0));
		}
		c.addChild(new Text(fit(theme.fg("dim", formatUsage(r.usage, r.model))), 0, 0));
		if (r.sessionFile) {
			c.addChild(new Text(fit(theme.fg("dim", `Session: ${shortenPath(r.sessionFile)}`)), 0, 0));
		}

		if (!isRunning && r.artifactPaths) {
			c.addChild(new Spacer(1));
			c.addChild(new Text(fit(theme.fg("dim", `Artifacts: ${shortenPath(r.artifactPaths.outputPath)}`)), 0, 0));
		}
		return c;
	}

	if (!expanded) return renderMultiCompact(d, theme);

	const hasRunning = d.progress?.some((p) => p.status === "running") 
		|| d.results.some((r) => r.progress?.status === "running");
	const ok = d.results.filter((r) => r.progress?.status === "completed" || (r.exitCode === 0 && r.progress?.status !== "running")).length;
	const hasEmptyWithoutTarget = d.results.some((r) =>
		r.exitCode === 0
		&& r.progress?.status !== "running"
		&& hasEmptyTextOutputWithoutOutputTarget(r.task, getSingleResultOutput(r)),
	);
	const icon = hasRunning
		? theme.fg("warning", "running")
		: hasEmptyWithoutTarget
			? theme.fg("warning", "warning")
			: ok === d.results.length
				? theme.fg("success", "ok")
				: theme.fg("error", "failed");

	const totalSummary =
		d.progressSummary ||
		d.results.reduce(
			(acc, r) => {
				const prog = r.progress || r.progressSummary;
				if (prog) {
					acc.toolCount += prog.toolCount;
					acc.tokens += prog.tokens;
					acc.durationMs =
						d.mode === "chain"
							? acc.durationMs + prog.durationMs
							: Math.max(acc.durationMs, prog.durationMs);
				}
				return acc;
			},
			{ toolCount: 0, tokens: 0, durationMs: 0 },
		);

	const summaryStr =
		totalSummary.toolCount || totalSummary.tokens
			? ` | ${totalSummary.toolCount} tools, ${formatTokens(totalSummary.tokens)} tok, ${formatDuration(totalSummary.durationMs)}`
			: "";

	const modeLabel = d.mode;
	const contextBadge = d.context === "fork" ? theme.fg("warning", " [fork]") : "";
	const hasParallelInChain = d.chainAgents?.some((a) => a.startsWith("["));
	const totalCount = hasParallelInChain ? d.results.length : (d.totalSteps ?? d.results.length);
	const currentStep = d.currentStepIndex !== undefined ? d.currentStepIndex + 1 : ok + 1;
	const stepInfo = hasRunning ? ` ${currentStep}/${totalCount}` : ` ${ok}/${totalCount}`;
	const itemTitle = d.mode === "parallel" ? "Agent" : "Step";
	
	const chainVis = d.chainAgents?.length && !hasParallelInChain
		? d.chainAgents
				.map((agent, i) => {
					const result = d.results[i];
					const isFailed = result && result.exitCode !== 0 && result.progress?.status !== "running";
					const isComplete = result && result.exitCode === 0 && result.progress?.status !== "running";
					const isEmptyWithoutTarget = Boolean(result)
						&& Boolean(isComplete)
						&& hasEmptyTextOutputWithoutOutputTarget(result.task, getSingleResultOutput(result));
					const isCurrent = i === (d.currentStepIndex ?? d.results.length);
					const stepIcon = isFailed
						? theme.fg("error", "failed")
						: isEmptyWithoutTarget
							? theme.fg("warning", "warning")
							: isComplete
								? theme.fg("success", "done")
								: isCurrent && hasRunning
									? theme.fg("warning", "running")
									: theme.fg("dim", "pending");
					return `${stepIcon} ${agent}`;
				})
				.join(theme.fg("dim", " → "))
		: null;

	const w = getTermWidth() - 4;
	const fit = (text: string) => expanded ? text : truncLine(text, w);
	const c = new Container();
	c.addChild(
		new Text(
			fit(`${icon} ${theme.fg("toolTitle", theme.bold(modeLabel))}${contextBadge}${stepInfo}${summaryStr}`),
			0,
			0,
		),
	);
	if (chainVis) {
		c.addChild(new Text(fit(`  ${chainVis}`), 0, 0));
	}

	const useResultsDirectly = hasParallelInChain || !d.chainAgents?.length;
	const stepsToShow = useResultsDirectly ? d.results.length : d.chainAgents!.length;

	c.addChild(new Spacer(1));

	for (let i = 0; i < stepsToShow; i++) {
		const r = d.results[i];
		const agentName = useResultsDirectly 
			? (r?.agent || `step-${i + 1}`)
			: (d.chainAgents![i] || r?.agent || `step-${i + 1}`);

		if (!r) {
			c.addChild(new Text(fit(theme.fg("dim", `  ${itemTitle} ${i + 1}: ${agentName}`)), 0, 0));
			c.addChild(new Text(theme.fg("dim", `    status: pending`), 0, 0));
			c.addChild(new Spacer(1));
			continue;
		}

		const progressFromArray = d.progress?.find((p) => p.index === i) 
			|| d.progress?.find((p) => p.agent === r.agent && p.status === "running");
		const rProg = r.progress || progressFromArray || r.progressSummary;
		const rRunning = rProg?.status === "running";
		const stepNumber = typeof rProg?.index === "number" ? rProg.index + 1 : i + 1;

		const resultOutput = getSingleResultOutput(r);
		const statusIcon = rRunning
			? theme.fg("warning", "running")
			: r.exitCode !== 0
				? theme.fg("error", "failed")
				: hasEmptyTextOutputWithoutOutputTarget(r.task, resultOutput)
					? theme.fg("warning", "warning")
					: theme.fg("success", "done");
		const stats = rProg ? ` | ${rProg.toolCount} tools, ${formatDuration(rProg.durationMs)}` : "";
		const modelDisplay = r.model ? theme.fg("dim", ` (${r.model})`) : "";
		const stepHeader = rRunning
			? `${statusIcon} ${itemTitle} ${stepNumber}: ${theme.bold(theme.fg("warning", r.agent))}${modelDisplay}${stats}`
			: `${statusIcon} ${itemTitle} ${stepNumber}: ${theme.bold(r.agent)}${modelDisplay}${stats}`;
		const toolCallLines = getToolCallLines(r, expanded);
		c.addChild(new Text(fit(stepHeader), 0, 0));

		const taskMaxLen = Math.max(20, w - 12);
		const taskPreview = expanded || r.task.length <= taskMaxLen
			? r.task
			: `${r.task.slice(0, taskMaxLen)}...`;
		c.addChild(new Text(fit(theme.fg("dim", `    task: ${taskPreview}`)), 0, 0));

		const outputTarget = extractOutputTarget(r.task);
		if (outputTarget) {
			c.addChild(new Text(fit(theme.fg("dim", `    output: ${outputTarget}`)), 0, 0));
		}

		if (r.skills?.length) {
			c.addChild(new Text(fit(theme.fg("dim", `    skills: ${r.skills.join(", ")}`)), 0, 0));
		}
		if (r.skillsWarning) {
			c.addChild(new Text(fit(theme.fg("warning", `    Warning: ${r.skillsWarning}`)), 0, 0));
		}
		if (r.attemptedModels && r.attemptedModels.length > 1) {
			c.addChild(new Text(fit(theme.fg("dim", `    fallbacks: ${r.attemptedModels.join(" → ")}`)), 0, 0));
		}

		if (rRunning && rProg) {
			if (rProg.skills?.length) {
				c.addChild(new Text(fit(theme.fg("accent", `    skills: ${rProg.skills.join(", ")}`)), 0, 0));
			}
			const toolLine = formatCurrentToolLine(rProg, w, expanded);
			if (toolLine) {
				c.addChild(new Text(fit(theme.fg("warning", `    > ${toolLine}`)), 0, 0));
			}
			const liveStatusLine = buildLiveStatusLine(rProg);
			if (liveStatusLine) {
				c.addChild(new Text(fit(theme.fg("accent", `    ${liveStatusLine}`)), 0, 0));
			}
			if (rProg.recentTools?.length) {
				for (const t of rProg.recentTools.slice(-3)) {
					const maxArgsLen = Math.max(40, w - 30);
					const argsPreview = expanded || t.args.length <= maxArgsLen
						? t.args
						: `${t.args.slice(0, maxArgsLen)}...`;
					c.addChild(new Text(fit(theme.fg("dim", `      ${t.tool}: ${argsPreview}`)), 0, 0));
				}
			}
			const recentLines = (rProg.recentOutput ?? []).slice(-5);
			for (const line of recentLines) {
				c.addChild(new Text(fit(theme.fg("dim", `      ${line}`)), 0, 0));
			}
		}

		if (!rRunning && r.artifactPaths) {
			c.addChild(new Text(fit(theme.fg("dim", `    artifacts: ${shortenPath(r.artifactPaths.outputPath)}`)), 0, 0));
		}

		if (expanded && !rRunning) {
			for (const line of toolCallLines) {
				c.addChild(new Text(fit(theme.fg("muted", `      ${line}`)), 0, 0));
			}
			if (toolCallLines.length) c.addChild(new Spacer(1));
		}

		c.addChild(new Spacer(1));
	}

	if (d.artifacts) {
		c.addChild(new Spacer(1));
		c.addChild(new Text(fit(theme.fg("dim", `Artifacts dir: ${shortenPath(d.artifacts.dir)}`)), 0, 0));
	}
	return c;
}
