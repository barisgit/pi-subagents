/**
 * Rendering functions for subagent results
 */

import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { getMarkdownTheme, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import {
	type AgentProgress,
	type AsyncJobState,
	type Details,
	MAX_WIDGET_JOBS,
	WIDGET_KEY,
} from "./types.ts";
import { formatTokens, formatUsage, formatDuration, formatToolCall, shortenPath } from "./formatters.ts";
import { displayStatePriority } from "./run-liveness.ts";
import { formatPhase } from "./run-phase.ts";
import { describeAgentLabel, formatShapeBadge } from "./run-shape.ts";
import { getDisplayItems, getSingleResultOutput, readStatus } from "./utils.ts";
import { readRunTranscript, previewArgs, type TranscriptLine } from "./run-transcript.ts";
import { statusToSummary, type AsyncRunSummary } from "./async-status.ts";
import { readAllEntries } from "./runs-registry.ts";

type Theme = Pick<ExtensionContext["ui"]["theme"], "fg"> & { bold: (value: string) => string };

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
let latestWidgetTui: TUI | undefined;
let latestWidgetJobs: AsyncJobState[] = [];

const resultAnimationTimers = new Map<ReturnType<typeof setInterval>, ResultAnimationContext["state"]>();

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

export function tintAgentName(name: string, color: string | undefined): string {
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
export function multiSpinnerFrame(): string {
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
			: `${progress.currentToolArgs.slice(0, Math.max(0, maxToolArgsLen - 1))}…`)
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

const RESULT_STATUS_LINE_PREVIEW_MAX = 200;

function resultStatusLine(result: Details["results"][number], output: string): string {
	if (result.detached) return result.detachedReason ? `Detached: ${result.detachedReason}` : "Detached";
	if (result.interrupted) return "Paused";
	if (result.exitCode !== 0) return `Error: ${result.error ?? (firstOutputLine(output) || `exit ${result.exitCode}`)}`;
	if (hasEmptyTextOutputWithoutOutputTarget(result.task, output)) return "Done (no text output)";
	// Show the first line of the agent's response so the row is informative.
	// `Done` (literal status) is reserved for the empty-output branch above.
	const preview = firstOutputLine(output);
	if (!preview) return "Done";
	return preview.length > RESULT_STATUS_LINE_PREVIEW_MAX
		? `${preview.slice(0, RESULT_STATUS_LINE_PREVIEW_MAX - 1)}…`
		: preview;
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
	const phaseLine = formatPhase(progress.phase, progress.phaseStartedAt, Date.now(), progress.currentTool);
	if (phaseLine && isToolPhase(progress.phase) && !progress.currentToolArgs) return phaseLine;
	const toolLine = formatCurrentToolLine(progress, getTermWidth() - 4, false);
	if (toolLine) return toolLine;
	return phaseLine || buildLiveStatusLine(progress) || "thinking…";
}

function isToolPhase(phase: AgentProgress["phase"]): boolean {
	return phase === "tool_running" || phase === "tool_streaming";
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
	const phaseLine = formatPhase(progress.phase, progress.phaseStartedAt, Date.now(), progress.currentTool);
	if (phaseLine && isToolPhase(progress.phase) && !progress.currentToolArgs) return { text: phaseLine, tone: "accent" };
	const toolLine = formatCurrentToolLine(progress, availableWidth, false);
	if (toolLine) return { text: toolLine, tone: "accent" };
	if (phaseLine) return { text: phaseLine, tone: "accent" };
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
	return slice.map((entry) => formatLiveHistoryEntry(entry, availableWidth));
}

function formatLiveHistoryEntry(entry: AgentProgress["recentTools"][number], availableWidth: number): string {
	const maxArgsLen = Math.max(20, availableWidth - 24);
	const args = entry.args
		? (entry.args.length <= maxArgsLen ? entry.args : `${entry.args.slice(0, Math.max(0, maxArgsLen - 1))}…`)
		: "";
	const durationSuffix = entry.durationMs !== undefined ? `  ${formatDuration(entry.durationMs)}` : "";
	return args
		? `← ${entry.tool}: ${args}${durationSuffix}`
		: `← ${entry.tool}${durationSuffix}`;
}

const MAX_INLINE_NESTING_DEPTH = 4;

function isTerminalInlineState(state: AsyncRunSummary["state"]): boolean {
	return state === "complete" || state === "failed" || state === "paused" || state === "lost";
}

function inlineStateGlyph(state: AsyncRunSummary["state"]): string {
	if (state === "complete") return "✓";
	if (state === "failed") return "×";
	if (state === "lost") return "!";
	if (state === "paused") return "‖";
	return "◇";
}

function readInlineRun(runId: string): { summary: AsyncRunSummary; events: TranscriptLine[] } | undefined {
	const asyncDir = readAllEntries().find((entry) => entry.runId === runId)?.runRecordDir;
	if (!asyncDir) return undefined;
	const status = readStatus(asyncDir);
	if (!status) return undefined;
	return { summary: statusToSummary(asyncDir, status), events: readRunTranscript(asyncDir) };
}

// Short-TTL cache: re-read the registry at most every 250ms per parent.
const inlineChildRunCache = new Map<string, { ts: number; ids: string[] }>();
const INLINE_CHILD_RUN_CACHE_TTL_MS = 250;

function listInlineChildRunIds(parentRunId: string): string[] {
	const now = Date.now();
	const cached = inlineChildRunCache.get(parentRunId);
	if (cached && now - cached.ts < INLINE_CHILD_RUN_CACHE_TTL_MS) return cached.ids;
	const entries = readAllEntries({ limit: 500 });
	const out: Array<{ id: string; startedAt: number }> = [];
	for (const entry of entries) {
		const asyncDir = entry.runRecordDir;
		const status = readStatus(asyncDir);
		if (!status || status.parentRunId !== parentRunId) continue;
		out.push({ id: status.runId || entry.runId, startedAt: status.startedAt });
	}
	const ids = out.sort((a, b) => a.startedAt - b.startedAt).map((child) => child.id);
	inlineChildRunCache.set(parentRunId, { ts: now, ids });
	return ids;
}

function listInlineChildRuns(parentRunId: string): AsyncRunSummary[] {
	const out: AsyncRunSummary[] = [];
	const entriesById = new Map<string, string>();
	for (const entry of readAllEntries({ limit: 500 })) {
		if (!entriesById.has(entry.runId)) entriesById.set(entry.runId, entry.runRecordDir);
	}
	for (const id of listInlineChildRunIds(parentRunId)) {
		const asyncDir = entriesById.get(id);
		if (!asyncDir) continue;
		const status = readStatus(asyncDir);
		if (!status || status.parentRunId !== parentRunId) continue;
		out.push(statusToSummary(asyncDir, status));
	}
	return out.sort((a, b) => a.startedAt - b.startedAt);
}

function argString(args: Record<string, unknown> | undefined, key: string): string | undefined {
	const value = args?.[key];
	return typeof value === "string" && value ? value : undefined;
}

function argBoolean(args: Record<string, unknown> | undefined, key: string): boolean {
	return args?.[key] === true;
}

function childMatchesArgs(child: AsyncRunSummary, args: Record<string, unknown> | undefined): boolean {
	const agent = argString(args, "agent");
	const label = argString(args, "label");
	if (agent && !child.steps.some((step) => step.agent === agent)) return false;
	if (label && child.label && child.label !== label) return false;
	return true;
}

export function findInlineChildRun(parentRunId: string, args: Record<string, unknown> | undefined, used: Set<string>, spawnedAt?: number): AsyncRunSummary | undefined {
	const directRunId = argString(args, "runId") ?? argString(args, "id");
	if (directRunId && !used.has(directRunId)) {
		const data = readInlineRun(directRunId);
		if (data?.summary.parentRunId === parentRunId && childMatchesArgs(data.summary, args)) return data.summary;
	}
	const candidates = listInlineChildRuns(parentRunId).filter((child) => !used.has(child.id) && childMatchesArgs(child, args));
	if (spawnedAt === undefined) return candidates[0];
	const nearby = candidates
		.filter((child) => Math.abs(child.startedAt - spawnedAt) <= 60_000)
		.sort((a, b) => Math.abs(a.startedAt - spawnedAt) - Math.abs(b.startedAt - spawnedAt));
	return nearby[0] ?? candidates[0];
}

function inlineRunLabel(summary: AsyncRunSummary, args?: Record<string, unknown>): string {
	return argString(args, "label")
		?? summary.label
		?? summary.steps.find((step) => step.label)?.label
		?? summary.steps[0]?.agent
		?? summary.id;
}

function inlineRunAgent(summary: AsyncRunSummary, args?: Record<string, unknown>): string {
	return argString(args, "agent") ?? summary.steps[0]?.agent ?? summary.mode;
}

function inlineToolCount(events: TranscriptLine[]): number {
	return events.filter((event) => event.kind === "tool").length;
}

function inlineTokenCount(summary: AsyncRunSummary): number {
	return summary.totalTokens?.total ?? summary.steps.reduce((sum, step) => sum + (step.tokens?.total ?? 0), 0);
}

function inlineDuration(summary: AsyncRunSummary): number {
	const end = isTerminalInlineState(summary.state) ? (summary.endedAt ?? summary.lastUpdate ?? Date.now()) : Date.now();
	return Math.max(0, end - summary.startedAt);
}

function inlineMeta(summary: AsyncRunSummary, events: TranscriptLine[]): string {
	const tools = inlineToolCount(events);
	const tokens = inlineTokenCount(summary);
	return `${tools} tools · ~${formatTokens(tokens)} tok · ${formatDuration(inlineDuration(summary))}`;
}

function inlinePrefix(depth: number): string {
	return `${"  ".repeat(Math.max(0, depth - 1))}└─`;
}

function countCollapsedNested(runId: string): { nested: number; tools: number } {
	let nested = 0;
	let tools = 0;
	for (const child of listInlineChildRuns(runId)) {
		nested++;
		const childData = readInlineRun(child.id);
		tools += childData ? inlineToolCount(childData.events) : 0;
		const rest = countCollapsedNested(child.id);
		nested += rest.nested;
		tools += rest.tools;
	}
	return { nested, tools };
}

function formatInlineTool(event: Extract<TranscriptLine, { kind: "tool" }>, maxWidth?: number): string {
	const duration = event.durationMs !== undefined ? `  ${formatDuration(event.durationMs)}` : "";
	const prefix = `${event.toolName}: `;
	const argsBudget = maxWidth === undefined
		? undefined
		: Math.max(1, maxWidth - visibleWidth(prefix) - visibleWidth(duration));
	const args = event.rawArgs ? previewArgs(event.rawArgs, argsBudget) : event.argsPreview;
	return args ? `${event.toolName}: ${args}${duration}` : `${event.toolName}${duration}`;
}

export function renderInlineAsyncToolLine(parentRunId: string, args: Record<string, unknown> | undefined, used = new Set<string>()): string | undefined {
	const child = findInlineChildRun(parentRunId, args, used);
	if (!child) return undefined;
	used.add(child.id);
	return `${inlinePrefix(1)} subagent (async): ${inlineRunAgent(child, args)} · ${inlineRunLabel(child, args)} → ${child.id.slice(0, 8)}`;
}

export function countLiveInlineAsyncChildren(parentRunId: string, tools: Array<{ tool: string; rawArgs?: Record<string, unknown> }>): number {
	const used = new Set<string>();
	let count = 0;
	for (const tool of tools) {
		if (tool.tool !== "subagent" || !argBoolean(tool.rawArgs, "async")) continue;
		const child = findInlineChildRun(parentRunId, tool.rawArgs, used);
		if (!child) continue;
		used.add(child.id);
		if (!isTerminalInlineState(child.state)) count++;
	}
	return count;
}

/**
 * Count inline child tallies (sync + async) under a parent. Used by the post-complete
 * header to summarise "this parent spawned N sync · M async" without re-expanding
 * each child card (which duplicates info the dashboard already shows).
 */
export function countInlineChildTally(parentRunId: string, tools: Array<{ tool: string; rawArgs?: Record<string, unknown> }>): { sync: number; async: number } {
	const used = new Set<string>();
	let sync = 0;
	let async = 0;
	for (const tool of tools) {
		if (tool.tool !== "subagent") continue;
		const isAsync = argBoolean(tool.rawArgs, "async");
		const child = findInlineChildRun(parentRunId, tool.rawArgs, used);
		if (!child) continue;
		used.add(child.id);
		if (isAsync) async++; else sync++;
	}
	return { sync, async };
}

export function renderNestedChild(runId: string, depth = 1, args?: Record<string, unknown>, used = new Set<string>(), maxWidth?: number): string[] {
	const data = readInlineRun(runId);
	if (!data) return [];
	const { summary, events } = data;
	used.add(runId);
	if (depth >= MAX_INLINE_NESTING_DEPTH) {
		const collapsed = countCollapsedNested(runId);
		return collapsed.nested > 0 ? [`${inlinePrefix(depth)} … ${collapsed.nested} more nested · ${collapsed.tools} tools`] : [];
	}
	const label = inlineRunLabel(summary, args);
	if (isTerminalInlineState(summary.state)) {
		return [`${inlinePrefix(depth)} ${inlineStateGlyph(summary.state)} subagent: ${label} · ${inlineMeta(summary, events)}`];
	}
	const lines = [`${inlinePrefix(depth)} ${inlineStateGlyph(summary.state)} subagent: ${inlineRunAgent(summary, args)} · ${label} · ${inlineMeta(summary, events)}`];
	for (const event of events) {
		if (event.kind !== "tool") continue;
		if (event.toolName === "subagent") {
			if (argBoolean(event.rawArgs, "async")) {
				const asyncLine = renderInlineAsyncToolLine(summary.id, event.rawArgs, used);
				if (asyncLine) lines.push(`${"  ".repeat(depth)}${asyncLine.slice(3)}`);
				else lines.push(`${inlinePrefix(depth + 1)} ${formatInlineTool(event, maxWidth === undefined ? undefined : maxWidth - visibleWidth(inlinePrefix(depth + 1)) - 1)}`);
				continue;
			}
			const child = findInlineChildRun(summary.id, event.rawArgs, used);
			if (child) {
				lines.push(...renderNestedChild(child.id, depth + 1, event.rawArgs, used, maxWidth));
				continue;
			}
		}
		lines.push(`${inlinePrefix(depth + 1)} ${formatInlineTool(event, maxWidth === undefined ? undefined : maxWidth - visibleWidth(inlinePrefix(depth + 1)) - 1)}`);
	}
	return lines;
}

/**
 * Render the live "current activity" footer of a running compact card.
 * When the agent is currently in the middle of a sync `subagent` tool call,
 * try to expand the in-flight child as a nested compact card (matching the
 * post-complete render). Falls back to the generic `tool: args | dur` line
 * when the child hasn't published its status.json yet or the call is async.
 */
function addLiveCurrentLines(
	c: Container,
	theme: Theme,
	parentRunId: string | undefined,
	progress: AgentProgress,
	width: number,
	indent: string,
	used: Set<string>,
): void {
	const rawArgs = (progress as { currentToolRawArgs?: Record<string, unknown> }).currentToolRawArgs;
	if (
		progress.currentTool === "subagent"
		&& parentRunId
		&& !argBoolean(rawArgs, "async")
	) {
		const child = findInlineChildRun(parentRunId, rawArgs, used);
		if (child) {
			for (const line of renderNestedChild(child.id, 1, rawArgs, used)) {
				c.addChild(new Text(truncLine(theme.fg("dim", `${indent}${line}`), width), 0, 0));
			}
			return;
		}
	}
	const current = buildLiveCurrentLine(progress, width);
	c.addChild(new Text(truncLine(`${theme.fg("dim", `${indent}└─`)} ${theme.fg(current.tone, current.text)}`, width), 0, 0));
}

function addCompactRecentToolLines(
	c: Container,
	theme: Theme,
	parentRunId: string | undefined,
	recentTools: AgentProgress["recentTools"],
	count: number,
	width: number,
	indent: string,
	used: Set<string>,
	includePlainTools = true,
	options: { expandSyncChildren?: boolean; includeAsyncSubagents?: boolean } = {},
): void {
	if (count <= 0 || !recentTools.length) return;
	const expandSyncChildren = options.expandSyncChildren ?? true;
	const includeAsyncSubagents = options.includeAsyncSubagents ?? true;
	for (const entry of recentTools.slice(-count)) {
		if (entry.tool === "subagent") {
			const isAsync = argBoolean(entry.rawArgs, "async");
			if (isAsync) {
				// Async subagents are summarised in the header tally; emitting them here
				// only adds a transient line that scrolls out the moment the parent moves on.
				if (!includeAsyncSubagents) continue;
				c.addChild(new Text(truncLine(theme.fg("dim", `${indent}├─ ${formatLiveHistoryEntry(entry, width)}`), width), 0, 0));
				continue;
			}
			if (!expandSyncChildren || !parentRunId) continue;
			const child = findInlineChildRun(parentRunId, entry.rawArgs, used, entry.endMs);
			if (!child) continue;
			for (const line of renderNestedChild(child.id, 1, entry.rawArgs, used)) {
				c.addChild(new Text(truncLine(theme.fg("dim", `${indent}${line}`), width), 0, 0));
			}
			continue;
		}
		if (includePlainTools) {
			c.addChild(new Text(truncLine(theme.fg("dim", `${indent}├─ ${formatLiveHistoryEntry(entry, width)}`), width), 0, 0));
		}
	}
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
	return theme.fg("success", "\u2588".repeat(doneCells))
		+ theme.fg("accent", "\u2588".repeat(Math.max(0, runCells)))
		+ theme.fg("dim", "\u2591".repeat(emptyCells));
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

function widgetJobGlyph(job: AsyncJobState, theme: Theme): string {
	// TODO(f5): Replace this local phase check with phase-aware display-state derivation.
	const hasKnownActivePhase = formatPhase(job.phase, job.phaseStartedAt, Date.now(), job.currentTool) !== "";
	if (job.status === "lost" || (job.displayState === "lost" && !hasKnownActivePhase)) return theme.fg("error", "!");
	if (job.displayState === "needs_attention" || job.activityState === "needs_attention") return theme.fg("warning", "!");
	if (job.status === "running") return theme.fg("accent", multiSpinnerFrame());
	if (job.status === "queued") return theme.fg("dim", "·");
	if (job.status === "paused") return theme.fg("warning", "⏸");
	if (job.status === "failed") return theme.fg("error", "×");
	return theme.fg("success", "✓");
}

function widgetJobName(job: AsyncJobState, theme: Theme): string {
	// Parallel runs race N children; `currentAgent` would be misleading (it's just the
	// most recent step's agent). Show the parallel shape and unique agents instead, with
	// each agent piece tinted by its own color when available.
	const desc = describeAgentLabel({
		mode: job.mode,
		agents: job.agents ?? [],
		agentColors: job.agentColors,
		fallbackName: job.currentAgent ?? job.agents?.[0] ?? "agent",
		fallbackColor: job.agentColor,
	});
	const tint = (text: string, color: string | undefined): string => {
		const bold = themeBold(theme, text);
		return color ? tintAgentName(bold, color) : theme.fg("toolTitle", bold);
	};
	let base: string;
	if (desc.kind === "uniformParallel") base = tint(`parallel(${desc.total})`, desc.color);
	else if (desc.kind === "mixedParallel") {
		base = desc.agents.map((a) => tint(a.name, a.color)).join(theme.fg("dim", "+"));
	} else {
		base = tint(desc.name, desc.color);
	}
	// Run-level label: shown for single runs and uniform-label parallel runs.
	// Per-step labels surface in the dashboard right pane and in mixed-parallel
	// widget rows where a single run-level label would be a lie.
	if (job.label) {
		const trimmed = truncLine(job.label, 30);
		base += ` ${theme.fg("dim", "·")} ${theme.fg("muted", trimmed)}`;
	}
	return base;
}

function widgetJobStats(job: AsyncJobState, theme: Theme): string {
	const parts: string[] = [];
	const stepsTotal = job.stepsTotal ?? job.agents?.length ?? 1;
	const completedParallelSteps = job.stepStatuses?.filter((status) => status === "complete" || status === "failed" || status === "skipped").length;
	// Label distinguishes chain (sequential multi-step) from parallel (concurrent children).
	const badge = formatShapeBadge({
		mode: job.mode,
		total: stepsTotal,
		current: job.mode === "parallel" ? (completedParallelSteps ?? 0) : (job.currentStep ?? 0) + 1,
		fallbackLabel: "step",
	});
	if (badge) parts.push(badge);
	// Suppress phase chip for terminal runs so finished jobs don't keep
	// ticking `streaming Xs` / `tool: bash Xs` (stale phase from status.json
	// written before the finalize phase-clear lands).
	const phaseAllowed = job.status !== "complete" && job.status !== "failed" && job.status !== "lost";
	const phaseLabel = phaseAllowed ? formatPhase(job.phase, job.phaseStartedAt, Date.now(), job.currentTool) : "";
	if (phaseLabel) parts.push(phaseLabel);
	else if (job.status === "lost" || job.displayState === "lost") parts.push(theme.fg("error", "lost"));
	else if (job.displayState === "tool_running" && job.currentTool) parts.push(`tool ${job.currentTool}`);
	else if (job.displayState === "needs_attention") parts.push(theme.fg("warning", "needs attention"));
	else if (job.displayState === "quiet") parts.push("quiet");
	if (job.totalTokens?.total) parts.push(formatTokenStat(job.totalTokens.total));
	if (job.startedAt) {
		const endTs = job.status === "running" || job.status === "queued" ? Date.now() : (job.updatedAt ?? Date.now());
		parts.push(formatDuration(Math.max(0, endTs - job.startedAt)));
	}
	return parts.length > 0 ? theme.fg("dim", parts.join(" · ")) : "";
}

function orderWidgetJobsWithChildren(sorted: AsyncJobState[]): AsyncJobState[] {
	// charter nested-subagent-display: widget mirrors dashboard parent-child ordering.
	const ids = new Set(sorted.map((job) => job.asyncId));
	const byParent = new Map<string, AsyncJobState[]>();
	const roots: AsyncJobState[] = [];
	for (const job of sorted) {
		if (job.parentRunId && ids.has(job.parentRunId)) {
			const children = byParent.get(job.parentRunId) ?? [];
			children.push(job);
			byParent.set(job.parentRunId, children);
		} else {
			roots.push(job);
		}
	}
	const out: AsyncJobState[] = [];
	const visit = (job: AsyncJobState) => {
		out.push(job);
		for (const child of byParent.get(job.asyncId) ?? []) visit(child);
	};
	for (const job of roots) visit(job);
	return out;
}

function widgetDepths(jobs: AsyncJobState[]): Map<string, number> {
	const ids = new Set(jobs.map((job) => job.asyncId));
	const byId = new Map(jobs.map((job) => [job.asyncId, job] as const));
	const depths = new Map<string, number>();
	const depthFor = (job: AsyncJobState, seen = new Set<string>()): number => {
		const cached = depths.get(job.asyncId);
		if (cached !== undefined) return cached;
		if (!job.parentRunId || !ids.has(job.parentRunId) || seen.has(job.parentRunId)) {
			depths.set(job.asyncId, 0);
			return 0;
		}
		seen.add(job.asyncId);
		const parent = byId.get(job.parentRunId);
		const depth = parent ? Math.min(4, depthFor(parent, seen) + 1) : 0;
		depths.set(job.asyncId, depth);
		return depth;
	};
	for (const job of jobs) depthFor(job);
	return depths;
}

export function buildWidgetLines(jobs: AsyncJobState[], theme: Theme, width = getTermWidth()): string[] {
	if (jobs.length === 0) return [];

	// Single ordering rule: needs_attention pinned to the very top, then strictly by
	// spawn time (newest first). Bucket-by-status would pin old failures above
	// recently completed/running runs, which fights the user's mental model. The
	// glyph on each row already communicates status.
	const sorted = orderWidgetJobsWithChildren([...jobs].sort((a, b) => {
		const displayA = displayStatePriority(a.displayState ?? (a.activityState === "needs_attention" ? "needs_attention" : undefined));
		const displayB = displayStatePriority(b.displayState ?? (b.activityState === "needs_attention" ? "needs_attention" : undefined));
		if (displayA !== displayB) return displayA - displayB;
		return (b.startedAt ?? 0) - (a.startedAt ?? 0);
	}));
	const visible = sorted.slice(0, MAX_WIDGET_JOBS);
	const overflow = sorted.length - visible.length;
	const depthMap = widgetDepths(visible);

	const running = jobs.filter((job) => job.status === "running").length;
	const queued = jobs.filter((job) => job.status === "queued").length;
	const hasActive = running > 0 || queued > 0;
	const headerGlyph = theme.fg(hasActive ? "accent" : "dim", hasActive ? "●" : "○");
	const headerText = `${headerGlyph} ${theme.fg(hasActive ? "accent" : "dim", "Agents")} ${theme.fg("dim", "· /subagents-status")}`;
	const lines: string[] = [truncLine(headerText, width)];

	for (let i = 0; i < visible.length; i++) {
		const job = visible[i]!;
		const isLast = i === visible.length - 1 && overflow === 0;
		const depth = depthMap.get(job.asyncId) ?? 0;
		const branchGlyph = depth > 0
			? `${"  ".repeat(Math.max(0, depth - 1))}${isLast ? "└─" : "├─"}`
			: (isLast ? "└─" : "├─");
		const branch = theme.fg("dim", branchGlyph);
		const glyph = widgetJobGlyph(job, theme);
		const name = widgetJobName(job, theme);
		const stats = widgetJobStats(job, theme);
		const statsPart = stats ? ` ${theme.fg("dim", "·")} ${stats}` : "";
		lines.push(truncLine(`${branch} ${glyph} ${name}${statsPart}`, width));
	}

	if (overflow > 0) {
		lines.push(truncLine(`${theme.fg("dim", "└─")} ${theme.fg("dim", `+${overflow} more`)}`, width));
	}
	// Trailing blank line for vertical breathing room between widget and prompt.
	lines.push("");

	return lines;
}

// Widget is registered via a factory so the returned Component's render() lines
// pass through unwrapped (no `Text(line, 1, 0)` margin-collapse that would eat
// trailing blank rows). Mirrors the pi-dag-tasks pattern.
function buildWidgetComponent(theme: Theme): Component {
	return {
		render: (width: number) => buildWidgetLines(latestWidgetJobs, theme, width),
		invalidate: () => { /* no cached state */ },
	};
}

function refreshAnimatedWidget(): void {
	if (!latestWidgetCtx?.hasUI || latestWidgetJobs.length === 0) return;
	if (latestWidgetTui) latestWidgetTui.requestRender();
	else {
		// TODO(sdk-0.75-shape): tests and older runtimes may still expose this
		// optional UI hook; 0.75 widgets use TUI.requestRender once the factory runs.
		(latestWidgetCtx.ui as unknown as { requestRender?: () => void }).requestRender?.();
	}
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
	latestWidgetTui = undefined;
	latestWidgetJobs = [];
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

	// Factory delivers a Component; latestWidgetJobs is captured by closure so the
	// same factory continues to render fresh data on each animation tick.
	ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => {
		latestWidgetTui = tui;
		return buildWidgetComponent(theme);
	});
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
	const boldName = themeBold(theme, r.agent);
	const tintedName = r.progress?.color ? tintAgentName(boldName, r.progress.color) : theme.fg("toolTitle", boldName);
	const labelTail = r.label ? ` ${theme.fg("dim", "·")} ${theme.fg("muted", truncLine(r.label, 30))}` : "";
	const tallyRecentTools = r.progress?.recentTools ?? (progress && "recentTools" in progress ? progress.recentTools : undefined);
	const childTail = (() => {
		if (!d.runId || !tallyRecentTools) return "";
		if (isRunning) {
			const active = countLiveInlineAsyncChildren(d.runId, tallyRecentTools);
			return active > 0 ? theme.fg("dim", ` · ${active}↗ active`) : "";
		}
		const tally = countInlineChildTally(d.runId, tallyRecentTools);
		const total = tally.sync + tally.async;
		return total > 0 ? theme.fg("dim", ` · ${total} subagent${total === 1 ? "" : "s"}`) : "";
	})();
	const headBase = `${headGlyph} ${tintedName}${contextBadge}${labelTail}${stats ? ` ${theme.fg("dim", "·")} ${stats}` : ""}${childTail}`;
	c.addChild(new Text(truncLine(rightAlignSuffix(headBase, spark, width), width), 0, 0));

	if (isRunning && r.progress) {
		// Chronological layout: history (oldest -> newest) on top, current activity at the bottom
		// so the freshest information sits right next to "now".
		const used = new Set<string>();
		addCompactRecentToolLines(c, theme, d.runId, r.progress.recentTools, adaptiveSingleHistoryCount(), width, "  ", used);
		addLiveCurrentLines(c, theme, d.runId, r.progress, width, "  ", used);
		return c;
	}

	c.addChild(new Text(truncLine(theme.fg("dim", `  └─ ${resultStatusLine(r, output)}`), width), 0, 0));
	// Completed view: child detail lives in the header tally and the dashboard.
	// Skip both sync expansion and async one-liners so the transcript stays compact.
	if (progress && "recentTools" in progress) {
		const recentTools = progress.recentTools ?? [];
		addCompactRecentToolLines(
			c,
			theme,
			d.runId,
			recentTools,
			recentTools.length,
			width,
			"  ",
			new Set<string>(),
			false,
			{ expandSyncChildren: false, includeAsyncSubagents: false },
		);
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
	// For chains with nested parallel sub-steps, count parent chain steps (e.g. 3) rather than
	// flattened tasks (e.g. 4) so header/body share the same denominator. Compute parent-aware
	// done count by checking whether every child in a parallel group has settled.
	const chainParentTotal = hasParallelInChain && d.chainAgents?.length
		? d.chainAgents.length
		: (d.totalSteps ?? d.results.length);
	const chainParentOk = (() => {
		if (!hasParallelInChain || !d.chainAgents?.length) return ok;
		let done = 0;
		let cursor = 0;
		for (const entry of d.chainAgents) {
			const childCount = entry.startsWith("[") && entry.endsWith("]")
				? entry.slice(1, -1).split("+").length
				: 1;
			const slice = d.results.slice(cursor, cursor + childCount);
			const allSettled = slice.length === childCount && slice.every((r) => {
				const p = r?.progress;
				return r && (!p || p.status !== "running");
			});
			if (allSettled) done++;
			cursor += childCount;
		}
		return done;
	})();
	const totalCount = chainParentTotal;
	const currentStep = d.currentStepIndex !== undefined ? d.currentStepIndex + 1 : Math.min(totalCount, chainParentOk + (hasRunning ? 1 : 0));
	const itemLabel = d.mode === "parallel" ? "agent" : "step";
	const itemTitle = d.mode === "parallel" ? "Agent" : "Step";
	const stepInfo = hasRunning ? `${itemLabel} ${currentStep}/${totalCount}` : `${itemLabel} ${chainParentOk}/${totalCount}`;
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
	// Chain progress bar: parent-step granularity already computed above as chainParentTotal/Ok.
	const chainBar = (d.mode === "chain" && chainParentTotal > 1)
		? buildChainBar(theme, chainParentOk, hasRunning ? 1 : 0, chainParentTotal, adaptiveBarWidth())
		: "";
	const chainBarPrefix = chainBar ? `${chainBar} ` : "";
	// Child tally lives on each per-row header in multi-compact; the top-level mode
	// header only shows aggregate run stats. (Single-compact still puts the tally on
	// its single header since there's no per-row layer.)
	const statsTail = `${stats ? ` ${theme.fg("dim", "·")} ${stats}` : ""}`;
	const headlinePrefix = chainBarPrefix ? ` ${chainBarPrefix}` : "";
	const uniformLabel = (() => {
		if (d.label) return d.label;
		const first = d.results[0]?.label;
		if (!first) return undefined;
		return d.results.every((r) => r.label === first) ? first : undefined;
	})();
	const headLabelTail = uniformLabel ? ` ${theme.fg("dim", "·")} ${theme.fg("muted", truncLine(uniformLabel, 30))}` : "";
	c.addChild(new Text(truncLine(`${glyph} ${theme.fg("toolTitle", themeBold(theme, d.mode))}${contextBadge}${headlinePrefix}${headLabelTail}${statsTail}`, width), 0, 0));

	const useResultsDirectly = hasParallelInChain || !d.chainAgents?.length;
	const stepsToShow = useResultsDirectly ? d.results.length : d.chainAgents!.length;

	// When parallel sub-steps are nested in a chain, results are flattened but chainAgents preserves
	// the grouping (e.g. ["a", "[b+c]", "d"] for 3 chain steps / 4 results). Build a per-result
	// label override so the body shows "Step 2.1 / Step 2.2" instead of misleading sequential numbering.
	const chainStepLabels: string[] | undefined = (() => {
		if (!hasParallelInChain || !d.chainAgents?.length) return undefined;
		const labels: string[] = [];
		let resultCursor = 0;
		for (let stepIdx = 0; stepIdx < d.chainAgents.length; stepIdx++) {
			const entry = d.chainAgents[stepIdx];
			if (entry.startsWith("[") && entry.endsWith("]")) {
				const children = entry.slice(1, -1).split("+");
				for (let childIdx = 0; childIdx < children.length; childIdx++) {
					labels[resultCursor++] = `${stepIdx + 1}.${childIdx + 1}∥`;
				}
			} else {
				labels[resultCursor++] = `${stepIdx + 1}`;
			}
		}
		return labels;
	})();

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
		const stepNumber: string | number = chainStepLabels?.[i]
			?? (r.progress?.index !== undefined ? r.progress.index + 1 : progressFromArray?.index !== undefined ? progressFromArray.index + 1 : i + 1);
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
		const rowLabelTail = r.label ? ` ${theme.fg("dim", "·")} ${theme.fg("muted", truncLine(r.label, 30))}` : "";
		const rowChildTail = (() => {
			if (!d.runId || !rProg || !("recentTools" in rProg)) return "";
			const recentTools = rProg.recentTools ?? [];
			if (rRunning) {
				const active = countLiveInlineAsyncChildren(d.runId, recentTools);
				return active > 0 ? theme.fg("dim", ` · ${active}↗ active`) : "";
			}
			const tally = countInlineChildTally(d.runId, recentTools);
			const total = tally.sync + tally.async;
			return total > 0 ? theme.fg("dim", ` · ${total} subagent${total === 1 ? "" : "s"}`) : "";
		})();
		const lineBase = `  ${glyph} ${itemTitle} ${stepNumber}: ${coloredName}${rowLabelTail}${stepStats ? ` ${theme.fg("dim", "·")} ${stepStats}` : ""}${rowChildTail}${pendingLabel}`;
		c.addChild(new Text(truncLine(rightAlignSuffix(lineBase, spark, width), width), 0, 0));
		if (rRunning && rProg && "status" in rProg) {
			const fullProg = r.progress ?? (progressFromArray && "recentTools" in progressFromArray ? progressFromArray as AgentProgress : undefined);
			if (fullProg) {
				// Chronological layout: history (oldest -> newest) on top, current activity at the bottom.
				const used = new Set<string>();
				addCompactRecentToolLines(c, theme, d.runId, fullProg.recentTools ?? [], historyN, width, "    ", used);
				addLiveCurrentLines(c, theme, d.runId, fullProg, width, "    ", used);
			} else {
				// Fallback when only ProgressSummary is available (no recentTools).
				const activity = compactCurrentActivity(rProg as AgentProgress);
				c.addChild(new Text(truncLine(theme.fg("dim", `    └─ ${activity}`), width), 0, 0));
			}
		} else if (!rPending) {
			if (rProg && "recentTools" in rProg) {
				addCompactRecentToolLines(
					c,
					theme,
					d.runId,
					rProg.recentTools ?? [],
					(rProg.recentTools ?? []).length,
					width,
					"    ",
					new Set<string>(),
					false,
					{ expandSyncChildren: false, includeAsyncSubagents: false },
				);
			}
			if (r.exitCode !== 0 || r.interrupted || r.detached || hasEmptyTextOutputWithoutOutputTarget(r.task, output)) {
				c.addChild(new Text(truncLine(theme.fg(r.exitCode !== 0 ? "error" : "dim", `    └─ ${resultStatusLine(r, output)}`), width), 0, 0));
			}
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
		c.addChild(new Text(fit(`${icon} ${theme.fg("toolTitle", themeBold(theme, r.agent))}${contextBadge}${progressInfo}`), 0, 0));
		c.addChild(new Spacer(1));
		const taskMaxLen = Math.max(20, w - 8);
		const taskPreview = expanded || r.task.length <= taskMaxLen
			? r.task
			: `${r.task.slice(0, Math.max(0, taskMaxLen - 1))}…`;
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
						: `${t.args.slice(0, Math.max(0, maxArgsLen - 1))}…`;
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
	
	const chainVis = d.chainAgents?.length
		? (() => {
				let resultCursor = 0;
				const pieces = d.chainAgents.map((entry, stepIdx) => {
					const isParallel = entry.startsWith("[") && entry.endsWith("]");
					const children = isParallel ? entry.slice(1, -1).split("+") : [entry];
					const childPieces = children.map((agent) => {
						const result = d.results[resultCursor++];
						const isRunning = result?.progress?.status === "running";
						const isFailed = result && result.exitCode !== 0 && !isRunning;
						const isComplete = result && result.exitCode === 0 && !isRunning;
						const isEmptyWithoutTarget = Boolean(result)
							&& Boolean(isComplete)
							&& hasEmptyTextOutputWithoutOutputTarget(result!.task, getSingleResultOutput(result!));
						const stepIcon = isFailed
							? theme.fg("error", "failed")
							: isEmptyWithoutTarget
								? theme.fg("warning", "warning")
								: isComplete
									? theme.fg("success", "done")
									: isRunning
										? theme.fg("warning", "running")
										: theme.fg("dim", "pending");
						return `${stepIcon} ${agent}`;
					});
					return isParallel
						? `${theme.fg("dim", "[")}${childPieces.join(theme.fg("dim", " ∥ "))}${theme.fg("dim", "]")}`
						: childPieces[0];
				});
				return pieces.join(theme.fg("dim", " → "));
			})()
		: null;

	const w = getTermWidth() - 4;
	const fit = (text: string) => expanded ? text : truncLine(text, w);
	const c = new Container();
	c.addChild(
		new Text(
			fit(`${icon} ${theme.fg("toolTitle", themeBold(theme, modeLabel))}${contextBadge}${stepInfo}${summaryStr}`),
			0,
			0,
		),
	);
	if (chainVis) {
		c.addChild(new Text(fit(`  ${chainVis}`), 0, 0));
	}

	const useResultsDirectly = hasParallelInChain || !d.chainAgents?.length;
	const stepsToShow = useResultsDirectly ? d.results.length : d.chainAgents!.length;

	// Mirror the background-renderer logic so nested parallel sub-steps display as "2.1∥ / 2.2∥"
	// instead of falsely-sequential "Step 2 / Step 3".
	const chainStepLabelsFg: string[] | undefined = (() => {
		if (!hasParallelInChain || !d.chainAgents?.length) return undefined;
		const labels: string[] = [];
		let resultCursor = 0;
		for (let stepIdx = 0; stepIdx < d.chainAgents.length; stepIdx++) {
			const entry = d.chainAgents[stepIdx];
			if (entry.startsWith("[") && entry.endsWith("]")) {
				const children = entry.slice(1, -1).split("+");
				for (let childIdx = 0; childIdx < children.length; childIdx++) {
					labels[resultCursor++] = `${stepIdx + 1}.${childIdx + 1}∥`;
				}
			} else {
				labels[resultCursor++] = `${stepIdx + 1}`;
			}
		}
		return labels;
	})();

	c.addChild(new Spacer(1));

	for (let i = 0; i < stepsToShow; i++) {
		const r = d.results[i];
		const agentName = useResultsDirectly 
			? (r?.agent || `step-${i + 1}`)
			: (d.chainAgents![i] || r?.agent || `step-${i + 1}`);

		if (!r) {
			const pendingLabel = chainStepLabelsFg?.[i] ?? `${i + 1}`;
			c.addChild(new Text(fit(theme.fg("dim", `  ${itemTitle} ${pendingLabel}: ${agentName}`)), 0, 0));
			c.addChild(new Text(theme.fg("dim", `    status: pending`), 0, 0));
			c.addChild(new Spacer(1));
			continue;
		}

		const progressFromArray = d.progress?.find((p) => p.index === i) 
			|| d.progress?.find((p) => p.agent === r.agent && p.status === "running");
		const rProg = r.progress || progressFromArray || r.progressSummary;
		const rRunning = rProg?.status === "running";
		const stepNumber: string | number = chainStepLabelsFg?.[i]
			?? (typeof rProg?.index === "number" ? rProg.index + 1 : i + 1);

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
			? `${statusIcon} ${itemTitle} ${stepNumber}: ${themeBold(theme, theme.fg("warning", r.agent))}${modelDisplay}${stats}`
			: `${statusIcon} ${itemTitle} ${stepNumber}: ${themeBold(theme, r.agent)}${modelDisplay}${stats}`;
		const toolCallLines = getToolCallLines(r, expanded);
		c.addChild(new Text(fit(stepHeader), 0, 0));

		const taskMaxLen = Math.max(20, w - 12);
		const taskPreview = expanded || r.task.length <= taskMaxLen
			? r.task
			: `${r.task.slice(0, Math.max(0, taskMaxLen - 1))}…`;
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
						: `${t.args.slice(0, Math.max(0, maxArgsLen - 1))}…`;
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
