/**
 * Right-pane / transcript renderer for the subagent dashboard. Builds the
 * detail-pane line buffers for a selected run: the generic per-step transcript
 * (buildRightLines) and the purpose-built workflow-group pane (script + phase
 * outline) via buildWorkflowRightLines. Pure functions over run data — the
 * SubagentsStatusComponent owns selection/scroll and feeds the selected run in.
 */

import { colorForAgentName } from "../shared/agents.ts";
import {
	AssistantMessageComponent,
	BashExecutionComponent,
	getMarkdownTheme,
	highlightCode,
	ToolExecutionComponent,
	type AgentSession,
	type AgentSessionEvent,
	type Theme,
	type ToolDefinition,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Markdown, type TUI, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { type AsyncRunSummary, sortedWorkflowChildren, workflowPhaseLabel } from "../state/async-status.ts";
import { readWorkflowScript } from "../workflow/workflow-group-state.ts";
import { readRunTranscript, type RunMessageSession, type TranscriptLine } from "../state/run-transcript.ts";
import { formatDuration, formatTokenCounter, shortenPath } from "./formatters.ts";
import { findInlineChildRun, renderNestedChild } from "./render-inline.ts";
import { RUNNING_GLYPH, tintAgentName } from "./render-shared.ts";
import type { ActivityState, RunDisplayState } from "../protocol/types.ts";
import { parentRunIdOf } from "./dashboard-row-model.ts";
import type { LiveRun } from "../state/run-view.ts";
import { shapeWorkflowPhasePlan } from "../state/workflow-display.ts";
import {
	dashboardPartialResult,
	type LiveToolProgress,
	type LiveToolProgressBySession,
} from "../shared/live-session-relay.ts";

// Single ellipsis glyph for every dashboard truncation. pi-tui's
// truncateToWidth defaults to a three-dot "..."; the rest of the surfaces use
// "…", so clip() pins the dashboard to the same single-glyph ellipsis.
const ELLIPSIS = "…";
const TAB_WIDTH = 4;

function normalizePaneText(text: string): string {
	return text.replace(/\t/g, " ".repeat(TAB_WIDTH));
}

export class LiveToolComponentStore {
	private readonly pendingTools = new Map<DashboardMessageSession, Map<string, PendingToolComponent>>();

	toolsFor(session: DashboardMessageSession): Map<string, PendingToolComponent> {
		let tools = this.pendingTools.get(session);
		if (!tools) {
			tools = new Map();
			this.pendingTools.set(session, tools);
		}
		return tools;
	}

	handleSessionEvent(session: AgentSession, event: AgentSessionEvent): void {
		if (event.type === "compaction_end") {
			this.releaseSession(session);
			return;
		}
		const tools = this.pendingTools.get(session);
		if (!tools) return;
		const pending = "toolCallId" in event ? tools.get(event.toolCallId) : undefined;
		if (!pending) return;
		if (event.type === "tool_execution_start" || event.type === "tool_execution_update") {
			updatePendingTool(pending, () => {
				pending.component.updateArgs(event.args);
				if (!pending.argsComplete) {
					pending.component.setArgsComplete();
					pending.argsComplete = true;
				}
				if (!pending.executionStarted) {
					pending.component.markExecutionStarted();
					pending.executionStarted = true;
				}
				if (event.type === "tool_execution_update") {
					const partialResult = dashboardPartialResult(event.partialResult);
					if (partialResult) {
						pending.latestResult = partialResult;
						pending.component.updateResult(partialResult, true);
					}
				}
			});
			return;
		}
		if (event.type === "tool_execution_end") {
			updatePendingTool(pending, () =>
				pending.component.updateResult({ ...event.result, isError: event.isError }),
			);
			tools.delete(event.toolCallId);
			if (tools.size === 0) this.pendingTools.delete(session);
		}
	}

	releaseSession(session: DashboardMessageSession): void {
		const tools = this.pendingTools.get(session);
		if (!tools) return;
		for (const pending of tools.values()) {
			updatePendingTool(pending, () =>
				pending.component.updateResult(pending.latestResult ?? { content: [], isError: true }),
			);
		}
		this.pendingTools.delete(session);
	}

	dispose(): void {
		for (const session of [...this.pendingTools.keys()]) this.releaseSession(session);
	}
}

export interface DashboardDisplayMode {
	revision: number;
	toolsExpanded: boolean;
	hideThinking: boolean;
}

function clip(text: string, width: number): string {
	return truncateToWidth(normalizePaneText(text), width, ELLIPSIS);
}

// Render prose (agent markdown output / prompts) through pi-tui's Markdown
// component so headings, lists, and code fences read correctly in the pane.
function renderMarkdownLines(text: string, width: number): string[] {
	if (width <= 0) return [];
	return new Markdown(normalizePaneText(text), 0, 0, getMarkdownTheme()).render(width);
}

export function statusGlyph(
	theme: Theme,
	state: AsyncRunSummary["state"],
	activity: ActivityState | undefined,
	displayState?: RunDisplayState,
): string {
	if (displayState === "lost") return theme.fg("error", "!");
	if (displayState === "needs_attention" || activity === "needs_attention") return theme.fg("warning", "!");
	switch (state) {
		case "running":
			return theme.fg("accent", RUNNING_GLYPH);
		case "queued":
			return theme.fg("dim", "○");
		case "paused":
			return theme.fg("warning", "⏸");
		case "complete":
			return theme.fg("success", "✓");
		case "failed":
			return theme.fg("error", "✗");
		case "interrupted":
			return theme.fg("warning", "■");
		case "skipped":
			return theme.fg("dim", "·");
		case "lost":
			return theme.fg("error", "!");
	}
	return theme.fg("dim", "·");
}

function wrapText(text: string, width: number): string[] {
	if (width <= 0) return [];
	const out: string[] = [];
	for (const paragraph of normalizePaneText(text).split("\n")) {
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

// ── Tool call cards ────────────────────────────────────────────────────────
// Each tool call renders as a mini card on the host's tool-card palette
// (toolSuccessBg, or toolErrorBg when the transcript recorded a failed call).
// Pattern matches pi-tui's Box.applyBg: pad the styled line to the pane width
// FIRST, then wrap the whole padded line in theme.bg. theme.bg closes every
// line with a background-only reset, so the color never bleeds into the pane
// border or the following row.
type ThemeBg = Parameters<Theme["bg"]>[0];

function bgLine(theme: Theme, color: ThemeBg, text: string, width: number): string {
	const normalized = normalizePaneText(text);
	const pad = Math.max(0, width - visibleWidth(normalized));
	return theme.bg(color, `${normalized}${" ".repeat(pad)}`);
}

type ToolEvent = Extract<TranscriptLine, { kind: "tool" }>;

function trimBlankEdges(lines: string[]): string[] {
	while (lines.length > 0 && lines[0]?.trim() === "") lines.shift();
	while (lines.length > 0 && lines[lines.length - 1]?.trim() === "") lines.pop();
	return lines;
}

function withoutFullReset(line: string): string {
	return line.replace(/\x1b\[0m/g, "\x1b[39m");
}

function fitAnsiLines(lines: string[], width: number): string[] {
	const fitted: string[] = [];
	for (const sourceLine of lines) {
		const line = normalizePaneText(sourceLine);
		if (visibleWidth(line) <= width) fitted.push(line);
		else fitted.push(...wrapTextWithAnsi(line, width));
	}
	return fitted;
}

function appendFoldedLines(
	out: string[],
	lines: string[],
	hiddenSourceLines: number,
	maxLines: number,
	indent: string,
	theme: Theme,
): void {
	let hidden = hiddenSourceLines;
	let shown = lines;
	if (hidden > 0) {
		const keep = Math.min(lines.length, Math.max(0, maxLines - 1));
		hidden += lines.length - keep;
		shown = lines.slice(0, keep);
	} else if (lines.length > maxLines) {
		const keep = Math.max(0, maxLines - 1);
		hidden = lines.length - keep;
		shown = lines.slice(0, keep);
	}
	for (const line of shown) out.push(`${indent}${line}`);
	if (hidden > 0) out.push(`${indent}${theme.fg("dim", `${ELLIPSIS} (+${hidden} lines)`)}`);
}

function buildArgLines(theme: Theme, arg: ToolArgDisplay, width: number): string[] {
	const source = trimBlankEdges(normalizePaneText(arg.text).split("\n"));
	if (source.length === 0) return [];
	const shownSource = source.slice(0, 4);
	const hiddenSourceLines = source.length - shownSource.length;
	const rendered = arg.lang ? highlightCode(shownSource.join("\n"), arg.lang).map(withoutFullReset) : shownSource;
	const out: string[] = [];
	appendFoldedLines(out, fitAnsiLines(rendered, Math.max(1, width - 2)), hiddenSourceLines, 5, "  ", theme);
	return out;
}

function buildResultLines(theme: Theme, event: ToolEvent, width: number): string[] {
	if (!event.resultHint) return [];
	const allSource = normalizePaneText(event.resultHint).split("\n");
	const source = allSource.slice(0, 3);
	const totalSourceLines = event.resultLineCount ?? allSource.length;
	const fitted = fitAnsiLines(source, Math.max(1, width - 4));
	let hidden = Math.max(0, totalSourceLines - source.length);
	let shown = fitted;
	if (fitted.length > 3) {
		shown = fitted.slice(0, 3);
		hidden += fitted.length - shown.length;
	}
	const out = shown.map((line, index) => theme.fg("toolOutput", index === 0 ? `  ↳ ${line}` : `    ${line}`));
	if (hidden > 0) out.push(theme.fg("dim", `    ${ELLIPSIS} (+${hidden} lines)`));
	return out;
}

// Top padding, title, verbatim primary arg block, result preview, bottom padding.
function buildToolBlock(theme: Theme, event: ToolEvent, arg: ToolArgDisplay, width: number): string[] {
	const color: ThemeBg = event.isError ? "toolErrorBg" : "toolSuccessBg";
	const inner: string[] = [""];
	const duration = event.durationMs !== undefined ? theme.fg("dim", ` · ${formatDuration(event.durationMs)}`) : "";
	const title = theme.fg("toolTitle", clip(`→ ${event.toolName}`, Math.max(1, width - visibleWidth(duration))));
	inner.push(`${title}${duration}`);
	inner.push(...buildArgLines(theme, arg, width));
	inner.push(...buildResultLines(theme, event, width));
	inner.push("");
	return inner.map((line) => bgLine(theme, color, line, width));
}

function buildChildSummaryLines(theme: Theme, run: LiveRun, width: number, runs: LiveRun[]): string[] {
	const children = runs.filter((candidate) => parentRunIdOf(candidate) === run.run.id);
	if (children.length === 0) return [];
	// Field priority preserved: currentAgent (live-only) wins, else first step's
	// agent (foreign carries steps; live carries steps:[]), else mode.
	const agents = children.map(
		(child) => child.run.currentAgent ?? child.run.steps.find((step) => step.agent)?.agent ?? child.run.mode,
	);
	const uniqueAgents = Array.from(new Set(agents.filter(Boolean)));
	const agentWord = children.length === 1 ? "agent" : "agents";
	const suffix = uniqueAgents.length > 0 ? `: ${uniqueAgents.join(", ")}` : "";
	return [theme.fg("dim", clip(`${children.length} ${agentWord}${suffix}`, width))];
}

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
	if (run.workflowMeta) {
		out.push(theme.fg("accent", clip(run.workflowMeta.name, width)));
		for (const line of wrapTextWithAnsi(run.workflowMeta.description, width)) out.push(theme.fg("muted", line));
		if (run.workflowMeta.phases.length > 0) {
			out.push("");
			out.push(theme.fg("accent", clip("─── Phase plan ───", width)));
			const children = sortedWorkflowChildren(
				runs.filter((candidate) => candidate.run.parentRunId === run.id).map((candidate) => candidate.run),
			);
			const reachedTitles = [
				...(run.reachedPhaseTitles ?? []),
				...children.map((child) => child.phaseTitle).filter((title): title is string => title !== undefined),
			];
			for (const [index, phase] of shapeWorkflowPhasePlan(
				run.workflowMeta,
				reachedTitles,
				run.state === "running" || run.state === "queued",
				run.phaseTitle,
			).entries()) {
				const detail = phase.detail ? ` — ${phase.detail}` : "";
				out.push(clip(`${index + 1}. ${phase.title} · ${phase.state}${detail}`, width));
			}
		}
		out.push("");
	}
	const script = run.asyncDir ? readWorkflowScript(run.asyncDir) : undefined;
	if (script) {
		out.push(theme.fg("accent", clip("─── Script ───", width)));
		const scriptLines = normalizePaneText(script).split("\n");
		// Trim leading/trailing blank lines but keep interior structure verbatim:
		// code must not be word-wrap reflowed.
		while (scriptLines.length > 0 && scriptLines[0]?.trim() === "") scriptLines.shift();
		while (scriptLines.length > 0 && scriptLines[scriptLines.length - 1]?.trim() === "") scriptLines.pop();
		// Whole script, syntax-highlighted; long lines wrap (ANSI-aware) instead of
		// truncating so no code is hidden. No line cap: the script is the workflow's
		// identity and the pane scrolls.
		for (const line of highlightCode(scriptLines.join("\n"), "ts")) {
			if (visibleWidth(line) <= width) out.push(line);
			else for (const wrapped of wrapTextWithAnsi(line, width)) out.push(wrapped);
		}
	}
	// Children are selected by structural parent linkage (parentRunId), NOT
	// provenance: an owned-async run's children (now ownership:'live') must still
	// appear in the right-pane Steps list.
	const children = runs.filter((candidate) => candidate.run.parentRunId === run.id).map((candidate) => candidate.run);
	if (children.length > 0) {
		if (out.length > 0) out.push("");
		out.push(theme.fg("accent", clip("─── Steps ───", width)));
		let lastPhaseKey: number | undefined;
		let shownPhaseHeader = false;
		for (const child of sortedWorkflowChildren(children)) {
			if (child.phaseIndex !== lastPhaseKey || !shownPhaseHeader) {
				lastPhaseKey = child.phaseIndex;
				shownPhaseHeader = true;
				const label = child.phaseIndex === undefined && !child.phaseTitle ? "" : workflowPhaseLabel(child);
				if (label) out.push(theme.fg("muted", clip(label, width)));
			}
			const agent = child.steps.find((step) => step.agent)?.agent ?? child.mode;
			const glyph = statusGlyph(theme, child.state, child.activityState, child.displayState);
			// parallelGroupId is a raw UUID; render a compact marker instead of the id.
			const parallelTag = child.parallelGroupId ? theme.fg("dim", "∥ ") : "";
			const stats: string[] = [child.state];
			const end = child.endedAt ?? Date.now();
			stats.push(formatDuration(Math.max(0, end - child.startedAt)));
			const tokens = childTokenTotal(child);
			if (tokens > 0) stats.push(formatTokenCounter(tokens));
			if (child.state === "running" && child.currentTool) stats.push(`→ ${child.currentTool}`);
			const labelPart = child.label ? ` — ${child.label}` : "";
			const line = `  ${glyph} ${parallelTag}${tintAgentName(agent, colorForAgentName(agent))} · ${stats.join(" · ")}${labelPart}`;
			out.push(clip(line, width));
		}
	}
	return out;
}

// ── Tool-call primary arg selection ────────────────────────────────────────
// Raw JSON args are too faithful for the pane: a `run {code:"\n…"}` call would
// render as escaped noise. Instead each tool selects the string argument that
// best identifies the call. Rendering keeps that string verbatim and owns caps.

export interface ToolArgDisplay {
	text: string;
	lang?: string;
}

function str(args: Record<string, unknown>, key: string): string | undefined {
	const value = args[key];
	return typeof value === "string" && value.trim() ? value : undefined;
}

function display(text: string | undefined, key?: string): ToolArgDisplay | undefined {
	if (text === undefined) return undefined;
	if (key === "code" || key === "script") return { text, lang: "javascript" };
	if (key === "command" || key === "cmd") return { text, lang: "bash" };
	return { text };
}

function firstDisplay(args: Record<string, unknown>, keys: readonly string[]): ToolArgDisplay | undefined {
	for (const key of keys) {
		const selected = display(str(args, key), key);
		if (selected !== undefined) return selected;
	}
	return undefined;
}

const PRIMARY_CODE_KEYS = ["code", "command", "cmd", "script"] as const;
const SALIENT_KEYS = [
	"path",
	"file",
	"url",
	"query",
	"pattern",
	"command",
	"cmd",
	"task",
	"prompt",
	"name",
	"id",
] as const;

function textOnly(text: string): ToolArgDisplay {
	return { text };
}

function pathHint(args: Record<string, unknown>): ToolArgDisplay {
	const target = firstDisplay(args, ["path", "file_path", "filePath", "file"]);
	return textOnly(target ? shortenPath(target.text) : "");
}

function patternPathHint(args: Record<string, unknown>): ToolArgDisplay {
	const pattern = firstDisplay(args, ["pattern", "query", "regex"]);
	const target = pathHint(args).text;
	if (pattern) return textOnly(target ? `${pattern.text} ${target}` : pattern.text);
	return textOnly(target);
}

// Per-tool selector table. Builtins first, then the extension tools this repo ships.
const TOOL_ARG_SELECTORS: Record<string, (args: Record<string, unknown>) => ToolArgDisplay> = {
	read: pathHint,
	edit: pathHint,
	write: pathHint,
	ls: pathHint,
	grep: patternPathHint,
	find: patternPathHint,
	run: (args) => firstDisplay(args, PRIMARY_CODE_KEYS) ?? textOnly(""),
	bash: (args) => firstDisplay(args, PRIMARY_CODE_KEYS) ?? textOnly(""),
	subagent: (args) => {
		const agent = str(args, "agent");
		const task = str(args, "task");
		if (agent || task) return textOnly([agent, task].filter(Boolean).join(" "));
		return textOnly([str(args, "action"), str(args, "id")].filter(Boolean).join(" "));
	},
	workflow: (args) => firstDisplay(args, ["script"]) ?? textOnly(str(args, "phase") ?? ""),
	process: (args) => textOnly([str(args, "action"), str(args, "name")].filter(Boolean).join(" ")),
	fetch: (args) => textOnly(str(args, "url") ?? ""),
	ast_grep: (args) => textOnly(str(args, "pattern") ?? ""),
	mcp: (args) =>
		textOnly(str(args, "tool") ?? str(args, "describe") ?? str(args, "search") ?? str(args, "server") ?? ""),
	task: (args) => textOnly(str(args, "action") ?? ""),
	apply_patch: pathHint,
};

// Fallback for unknown tools: first string among salient keys, else the first
// short string prop — never raw JSON.
function genericHint(args: Record<string, unknown>): ToolArgDisplay {
	const salient = firstDisplay(args, SALIENT_KEYS);
	if (salient !== undefined) return salient;
	for (const [key, value] of Object.entries(args)) {
		if (typeof value === "string" && value.trim() && value.length <= 200)
			return display(value, key) ?? textOnly(value);
	}
	return textOnly("");
}

export function selectToolArg(toolName: string, args: Record<string, unknown> | undefined): ToolArgDisplay {
	if (!args) return textOnly("");
	const selector = TOOL_ARG_SELECTORS[toolName];
	if (selector) {
		const hint = selector(args);
		if (hint.text) return hint;
	}
	return genericHint(args);
}

function userMessageText(message: Extract<AgentMessage, { role: "user" }>): string {
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("");
}

interface DashboardMessageSession {
	readonly messages: AgentMessage[];
	readonly stepIndex?: number;
	getToolDefinition?(name: string): ToolDefinition | undefined;
}

export interface LiveDashboardSession extends DashboardMessageSession {
	subscribe(listener: (event?: AgentSessionEvent) => void): () => void;
}

interface RenderedMessageGroup {
	messages: AgentMessage[];
	lines: string[];
}

interface LiveSessionCacheEntry {
	width: number;
	revision: number;
	groups: RenderedMessageGroup[];
	lines: string[];
	dirtyFrom?: number;
}

type ToolResultPayload = Parameters<ToolExecutionComponent["updateResult"]>[0];

interface PendingToolComponent {
	component: ToolExecutionComponent;
	executionStarted: boolean;
	argsComplete: boolean;
	completed: boolean;
	renderRequestsEnabled: boolean;
	latestResult?: ToolResultPayload;
}

function updatePendingTool(pending: PendingToolComponent, update: () => void): void {
	pending.renderRequestsEnabled = false;
	try {
		update();
	} finally {
		pending.renderRequestsEnabled = true;
	}
}

function messageGroups(messages: AgentMessage[]): AgentMessage[][] {
	const groups: AgentMessage[][] = [];
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
	return groups;
}

function sameMessageGroup(left: AgentMessage[], right: AgentMessage[]): boolean {
	return left.length === right.length && left.every((message, index) => message === right[index]);
}

export class LiveSessionRenderCache {
	private readonly entries = new WeakMap<DashboardMessageSession, LiveSessionCacheEntry>();
	private readonly pendingTools = new WeakMap<DashboardMessageSession, Map<string, PendingToolComponent>>();
	private readonly pendingSessions = new Set<DashboardMessageSession>();
	private readonly liveToolComponents: LiveToolComponentStore | undefined;

	constructor(liveToolComponents?: LiveToolComponentStore) {
		this.liveToolComponents = liveToolComponents;
	}

	clear(session: DashboardMessageSession): void {
		this.entries.delete(session);
		if (!this.liveToolComponents) this.clearPendingTools(session);
	}

	private clearPendingTools(session: DashboardMessageSession): void {
		const tools = this.pendingTools.get(session);
		if (!tools) return;
		for (const pending of tools.values()) {
			updatePendingTool(pending, () =>
				pending.component.updateResult(pending.latestResult ?? { content: [], isError: true }),
			);
		}
		this.pendingTools.delete(session);
		this.pendingSessions.delete(session);
	}

	dispose(): void {
		if (this.liveToolComponents) return;
		for (const session of [...this.pendingSessions]) this.clearPendingTools(session);
	}

	invalidate(session: DashboardMessageSession, event?: AgentSessionEvent): void {
		const entry = this.entries.get(session);
		if (event?.type === "compaction_end") {
			if (this.liveToolComponents) this.liveToolComponents.releaseSession(session);
			else this.clearPendingTools(session);
			if (!entry) return;
			entry.dirtyFrom = 0;
			return;
		}
		if (!entry) return;
		if (event?.type === "message_start") {
			entry.dirtyFrom = Math.min(entry.dirtyFrom ?? entry.groups.length, entry.groups.length);
			return;
		}
		if (
			event === undefined ||
			event.type === "message_update" ||
			event.type === "message_end" ||
			event.type === "tool_execution_start" ||
			event.type === "tool_execution_update" ||
			event.type === "tool_execution_end" ||
			event.type === "agent_end"
		) {
			entry.dirtyFrom = Math.min(entry.dirtyFrom ?? entry.groups.length, Math.max(0, entry.groups.length - 1));
		}
	}

	render(
		session: DashboardMessageSession,
		width: number,
		revision: number,
		renderGroup: (messages: AgentMessage[], pendingTools: Map<string, PendingToolComponent>) => string[],
	): string[] {
		const entry = this.entries.get(session);
		if (entry && entry.width === width && entry.revision === revision && entry.dirtyFrom === undefined)
			return entry.lines;

		const groups = messageGroups(session.messages);
		const canReuse = entry?.width === width && entry.revision === revision;
		let rebuildFrom = canReuse ? (entry.dirtyFrom ?? 0) : 0;
		if (canReuse) {
			const shared = Math.min(entry.groups.length, groups.length);
			for (let index = 0; index < shared; index++) {
				if (!sameMessageGroup(entry.groups[index]!.messages, groups[index]!)) {
					rebuildFrom = Math.min(rebuildFrom, index);
					break;
				}
			}
			if (groups.length < entry.groups.length) rebuildFrom = Math.min(rebuildFrom, groups.length);
		}

		const renderedGroups = canReuse ? entry.groups.slice(0, rebuildFrom) : [];
		let pendingTools = this.liveToolComponents?.toolsFor(session) ?? this.pendingTools.get(session);
		if (!pendingTools) {
			pendingTools = new Map();
			if (!this.liveToolComponents) this.pendingTools.set(session, pendingTools);
		}
		for (let index = rebuildFrom; index < groups.length; index++) {
			const messages = groups[index]!;
			renderedGroups.push({ messages, lines: renderGroup(messages, pendingTools) });
		}
		const lines = renderedGroups.flatMap((group) => group.lines);
		if (this.liveToolComponents && pendingTools.size === 0) this.liveToolComponents.releaseSession(session);
		if (!this.liveToolComponents && pendingTools.size > 0) {
			this.pendingSessions.add(session);
		} else if (!this.liveToolComponents) {
			if (pendingTools.size === 0) this.pendingTools.delete(session);
			this.pendingSessions.delete(session);
		}
		this.entries.set(session, { width, revision, groups: renderedGroups, lines });
		return lines;
	}
}

function controlSequenceEnd(text: string, start: number): number {
	for (let index = start; index < text.length; index++) {
		const code = text.charCodeAt(index);
		if (code >= 0x40 && code <= 0x7e) return index + 1;
		if (code < 0x20 || code > 0x3f) return index + 1;
	}
	return text.length;
}

function controlStringEnd(text: string, start: number): number {
	for (let index = start; index < text.length; index++) {
		const code = text.charCodeAt(index);
		if (code === 0x07 || code === 0x9c) return index + 1;
		if (code === 0x1b && text[index + 1] === "\\") return index + 2;
	}
	return text.length;
}

function sanitizeLiveRow(row: string): string {
	let safe = "";
	for (let index = 0; index < row.length; ) {
		const code = row.charCodeAt(index);
		if (code === 0x1b) {
			const introducer = row[index + 1];
			if (introducer === "[") {
				const end = controlSequenceEnd(row, index + 2);
				const sequence = row.slice(index, end);
				const parameters = sequence.slice(2, -1);
				if (sequence.endsWith("m") && /^[0-9:;]*$/.test(parameters)) safe += sequence;
				index = end;
				continue;
			}
			if (
				introducer === "]" ||
				introducer === "P" ||
				introducer === "_" ||
				introducer === "^" ||
				introducer === "X"
			) {
				index = controlStringEnd(row, index + 2);
				continue;
			}
			index = Math.min(row.length, index + 2);
			continue;
		}
		if (code === 0x9b) {
			index = controlSequenceEnd(row, index + 1);
			continue;
		}
		if (code === 0x90 || code === 0x98 || code === 0x9d || code === 0x9e || code === 0x9f) {
			index = controlStringEnd(row, index + 1);
			continue;
		}
		if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
			index++;
			continue;
		}
		safe += row[index];
		index++;
	}
	return safe;
}

function renderLiveMessages(
	session: DashboardMessageSession,
	messages: AgentMessage[],
	pendingTools: Map<string, PendingToolComponent>,
	tui: TUI,
	width: number,
	cwd: string,
	getToolDefinition?: (name: string) => ToolDefinition | undefined,
	toolProgress?: ReadonlyMap<string, LiveToolProgress>,
	display: DashboardDisplayMode = { revision: 0, toolsExpanded: false, hideThinking: false },
	requestRender?: () => void,
): string[] {
	const lines: string[] = [];
	const openToolIds = new Set<string>();
	const markdownTheme = getMarkdownTheme();
	const renderTui = new Proxy(tui, {
		get(target, property, receiver) {
			if (property === "requestRender") return () => {};
			return Reflect.get(target, property, receiver);
		},
	});
	for (const message of messages) {
		let component: { render(renderWidth: number): string[] } | undefined;
		if (message.role === "user") {
			const text = userMessageText(message);
			if (text) component = new UserMessageComponent(text, markdownTheme, 0);
		} else if (message.role === "assistant") {
			component = new AssistantMessageComponent(message, display.hideThinking, markdownTheme, undefined, 0);
			for (const content of message.content) {
				if (content.type !== "toolCall") continue;
				let pending = pendingTools.get(content.id);
				if (!pending) {
					let created: PendingToolComponent | undefined;
					const componentTui = new Proxy(tui, {
						get(target, property, receiver) {
							if (property === "requestRender")
								return () => created?.renderRequestsEnabled && requestRender?.();
							return Reflect.get(target, property, receiver);
						},
					});
					pending = {
						component: new ToolExecutionComponent(
							content.name,
							content.id,
							content.arguments,
							{ showImages: false },
							session.getToolDefinition?.(content.name) ?? getToolDefinition?.(content.name),
							componentTui,
							cwd,
						),
						executionStarted: false,
						argsComplete: false,
						completed: false,
						renderRequestsEnabled: true,
					};
					created = pending;
					pendingTools.set(content.id, pending);
				}
				updatePendingTool(pending, () => {
					pending.component.setExpanded(display.toolsExpanded);
					if (pending.completed) return;
					pending.component.updateArgs(content.arguments);
					const progress = toolProgress?.get(content.id);
					if (progress) {
						if (!pending.argsComplete) {
							pending.component.setArgsComplete();
							pending.argsComplete = true;
						}
						if (!pending.executionStarted) {
							pending.component.markExecutionStarted();
							pending.executionStarted = true;
						}
						if (progress.partialResult) {
							pending.latestResult = progress.partialResult;
							pending.component.updateResult(progress.partialResult, true);
						}
					}
				});
				openToolIds.add(content.id);
			}
		} else if (message.role === "toolResult") {
			const pending = pendingTools.get(message.toolCallId);
			if (pending) {
				pending.renderRequestsEnabled = false;
				try {
					if (!pending.completed) {
						if (!pending.argsComplete) {
							pending.component.setArgsComplete();
							pending.argsComplete = true;
						}
						const finalResult = {
							...message,
							content: message.content.filter((content) => content.type !== "image"),
						};
						pending.latestResult = finalResult;
						pending.component.updateResult(finalResult);
						pending.completed = true;
					}
					lines.push(...pending.component.render(width));
				} finally {
					pending.renderRequestsEnabled = true;
				}
				openToolIds.delete(message.toolCallId);
			}
		} else if (message.role === "bashExecution") {
			const bash = new BashExecutionComponent(message.command, renderTui, message.excludeFromContext);
			bash.setExpanded(display.toolsExpanded);
			if (message.output) bash.appendOutput(message.output);
			bash.setComplete(message.exitCode, message.cancelled, undefined, message.fullOutputPath);
			component = bash;
		}
		if (component) lines.push(...component.render(width));
	}
	for (const toolCallId of openToolIds) {
		const pending = pendingTools.get(toolCallId);
		if (pending) lines.push(...pending.component.render(width));
	}
	return lines.map(sanitizeLiveRow);
}

function buildLiveRightLines<TSession extends DashboardMessageSession>(
	sessions: TSession[],
	tui: TUI,
	width: number,
	cwd: string,
	cache?: LiveSessionRenderCache,
	getToolDefinition?: (name: string) => ToolDefinition | undefined,
	toolProgress?: ReadonlyMap<TSession, ReadonlyMap<string, LiveToolProgress>>,
	display: DashboardDisplayMode = { revision: 0, toolsExpanded: false, hideThinking: false },
): string[] {
	const lines: string[] = [];
	for (const [index, session] of sessions.entries()) {
		const uncachedPendingTools = new Map<string, PendingToolComponent>();
		const requestRender = () => {
			cache?.invalidate(session);
			tui.requestRender();
		};
		const render = (messages: AgentMessage[], pendingTools = uncachedPendingTools) =>
			renderLiveMessages(
				session,
				messages,
				pendingTools,
				tui,
				width,
				cwd,
				getToolDefinition,
				toolProgress?.get(session),
				display,
				requestRender,
			);
		const sessionLines = cache ? cache.render(session, width, display.revision, render) : render(session.messages);
		if (sessionLines.length === 0) continue;
		if (sessions.length > 1) {
			const stepNumber = session.stepIndex === undefined ? index + 1 : session.stepIndex + 1;
			lines.push(`Step ${stepNumber}`);
		}
		lines.push(...sessionLines);
	}
	return lines;
}

export function buildRightLines(
	theme: Theme,
	run: LiveRun | undefined,
	width: number,
	runs: LiveRun[] = [],
	live?: {
		sessions: LiveDashboardSession[];
		tui: TUI;
		cache?: LiveSessionRenderCache;
		toolProgress?: LiveToolProgressBySession<LiveDashboardSession>;
		display?: DashboardDisplayMode;
	},
	historical?: {
		sessions: RunMessageSession[];
		tui: TUI;
		cache?: LiveSessionRenderCache;
		getToolDefinition: (name: string) => ToolDefinition | undefined;
		display?: DashboardDisplayMode;
	},
): string[] {
	if (!run) return [theme.fg("dim", "(no events yet)")];
	if (live?.sessions.length) {
		try {
			const lines = buildLiveRightLines(
				live.sessions,
				live.tui,
				width,
				run.run.cwd ?? process.cwd(),
				live.cache,
				undefined,
				live.toolProgress,
				live.display,
			);
			if (lines.length > 0) return lines;
		} catch {
			// A stale or unusable handle falls through to the persisted transcript.
		}
	}
	if (historical?.sessions.some((session) => session.messages.length > 0)) {
		try {
			const lines = buildLiveRightLines(
				historical.sessions,
				historical.tui,
				width,
				run.run.cwd ?? process.cwd(),
				historical.cache,
				historical.getToolDefinition,
				undefined,
				historical.display,
			);
			if (lines.length > 0) return lines;
		} catch {
			// Malformed or unusable persisted messages fall through to the compact transcript.
		}
	}
	if (run.run.workflow) {
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
	type Step = {
		index: number;
		agent: string;
		startTs?: number;
		lines: string[];
		final?: string;
		task?: string;
		lastKind?: "tool" | "narration" | "other";
	};
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
	// Breathing room: tool cards are background blocks, so a plain blank line
	// separates a card from adjacent narration or another card. Narration after
	// narration stays contiguous (markdown owns its own spacing).
	const pushStepLines = (step: Step, kind: "tool" | "narration" | "other", lines: string[]): void => {
		if (lines.length === 0) return;
		const last = step.lines[step.lines.length - 1];
		if (last !== undefined && last !== "" && (kind === "tool" || step.lastKind === "tool")) step.lines.push("");
		step.lines.push(...lines);
		step.lastKind = kind;
	};

	for (const event of events) {
		if (event.kind === "step-start") {
			const step = ensureStep(event.stepIndex, event.agent);
			if (!step.startTs) step.startTs = event.ts;
			if (event.task && !step.task) step.task = event.task;
			continue;
		}
		if (event.kind === "assistant-text") {
			const step = ensureStep(event.stepIndex, "");
			// Mid-run narration: markdown-rendered but dimmed, so it reads as the
			// agent's running commentary rather than competing with the final block.
			pushStepLines(
				step,
				"narration",
				renderMarkdownLines(event.text, width).map((line) => theme.fg("muted", line)),
			);
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
						const nested = renderNestedChild(child.id, 1, event.rawArgs, rightPaneUsed).map((line) =>
							theme.fg("dim", clip(line, width)),
						);
						pushStepLines(step, "tool", nested);
						continue;
					}
				}
			}
			const arg = event.rawArgs ? selectToolArg(event.toolName, event.rawArgs) : { text: event.argsPreview };
			pushStepLines(step, "tool", buildToolBlock(theme, event, arg, width));
			continue;
		}
		if (event.kind === "step-end") {
			ensureStep(event.stepIndex, event.agent);
			continue;
		}
		if (event.kind === "final-text") {
			const step = ensureStep(event.stepIndex, event.agent);
			step.final = event.text;
		}
	}

	const ordered = [...steps.values()].sort((a, b) => {
		if (a.startTs !== undefined && b.startTs !== undefined) return a.startTs - b.startTs;
		return a.index - b.index;
	});
	const out: string[] = [];
	for (const step of ordered) {
		if (ordered.length > 1 && out.length > 0)
			out.push(theme.fg("dim", clip(`── ${step.agent || "agent"} ──`, width)));
		if (step.task) {
			// Host convention: user prompts render on userMessageBg — same pad-then-bg
			// pattern as the tool cards so the block spans the pane width.
			const wrapped = wrapText(step.task, Math.max(1, width - 2));
			out.push(bgLine(theme, "userMessageBg", "", width));
			for (const line of wrapped) out.push(bgLine(theme, "userMessageBg", `  ${line}`, width));
			out.push(bgLine(theme, "userMessageBg", "", width));
		}
		// One blank line of breathing room between the header area and the feed.
		if (step.lines.length > 0) out.push("");
		for (const line of step.lines) out.push(line);
		if (step.final) {
			const border = "─".repeat(Math.max(0, width));
			out.push(theme.fg("dim", border));
			// Agent output is typically markdown; render it as such.
			for (const wrapped of renderMarkdownLines(step.final, width)) out.push(wrapped);
			out.push(theme.fg("dim", border));
		}
	}
	return out;
}
