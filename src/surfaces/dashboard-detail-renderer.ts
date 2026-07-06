/**
 * Right-pane / transcript renderer for the subagent dashboard. Builds the
 * detail-pane line buffers for a selected run: the generic per-step transcript
 * (buildRightLines) and the purpose-built workflow-group pane (script + phase
 * outline) via buildWorkflowRightLines. Pure functions over run data — the
 * SubagentsStatusComponent owns selection/scroll and feeds the selected run in.
 */

import { colorForAgentName } from "../shared/agents.ts";
import { getMarkdownTheme, highlightCode, type Theme } from "@earendil-works/pi-coding-agent";
import { Markdown, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { type AsyncRunSummary, sortedWorkflowChildren, workflowPhaseLabel } from "../state/async-status.ts";
import { readWorkflowScript } from "../workflow/workflow-group-state.ts";
import { readRunTranscript, type TranscriptLine } from "../state/run-transcript.ts";
import { formatDuration, formatTokens, shortenPath } from "./formatters.ts";
import { findInlineChildRun, renderNestedChild } from "./render-inline.ts";
import { RUNNING_GLYPH, tintAgentName } from "./render-shared.ts";
import type { ActivityState, RunDisplayState } from "../protocol/types.ts";
import { parentRunIdOf } from "./dashboard-row-model.ts";
import type { LiveRun } from "../state/run-view.ts";

// Single ellipsis glyph for every dashboard truncation. pi-tui's
// truncateToWidth defaults to a three-dot "..."; the rest of the surfaces use
// "…", so clip() pins the dashboard to the same single-glyph ellipsis.
const ELLIPSIS = "…";
function clip(text: string, width: number): string {
	return truncateToWidth(text, width, ELLIPSIS);
}

// Render prose (agent markdown output / prompts) through pi-tui's Markdown
// component so headings, lists, and code fences read correctly in the pane.
function renderMarkdownLines(text: string, width: number): string[] {
	if (width <= 0) return [];
	return new Markdown(text, 0, 0, getMarkdownTheme()).render(width);
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

// ── Tool call cards ────────────────────────────────────────────────────────
// Each tool call renders as a mini card on the host's tool-card palette
// (toolSuccessBg, or toolErrorBg when the transcript recorded a failed call).
// Pattern matches pi-tui's Box.applyBg: pad the styled line to the pane width
// FIRST, then wrap the whole padded line in theme.bg. theme.bg closes every
// line with a background-only reset, so the color never bleeds into the pane
// border or the following row.
type ThemeBg = Parameters<Theme["bg"]>[0];
const ARG_HINT_MAX_LINES = 2;
const RESULT_HINT_MAX_LINES = 2;

function bgLine(theme: Theme, color: ThemeBg, text: string, width: number): string {
	const pad = Math.max(0, width - visibleWidth(text));
	return theme.bg(color, `${text}${" ".repeat(pad)}`);
}

// Word-wrap capped at maxLines; a clipped tail gets the shared ellipsis so the
// reader can tell the hint continues.
function wrapCapped(text: string, width: number, maxLines: number): string[] {
	if (width <= 0) return [];
	const lines = wrapText(text, width);
	if (lines.length <= maxLines) return lines;
	const capped = lines.slice(0, maxLines);
	const last = capped[capped.length - 1] ?? "";
	capped[capped.length - 1] = truncateToWidth(`${last}${ELLIPSIS}`, width, ELLIPSIS);
	return capped;
}

type ToolEvent = Extract<TranscriptLine, { kind: "tool" }>;

// Line 1: tool name (toolTitle) + duration; line 2+: arg hint wrapped to a
// small cap; then the result hint (↳, toolOutput) inside the same bg block.
function buildToolBlock(theme: Theme, event: ToolEvent, hint: string, width: number): string[] {
	const color: ThemeBg = event.isError ? "toolErrorBg" : "toolSuccessBg";
	const inner: string[] = [];
	const duration = event.durationMs !== undefined ? theme.fg("dim", ` · ${formatDuration(event.durationMs)}`) : "";
	const title = theme.fg("toolTitle", clip(`→ ${event.toolName}`, Math.max(1, width - visibleWidth(duration))));
	inner.push(`${title}${duration}`);
	if (hint) {
		for (const line of wrapCapped(hint, Math.max(1, width - 2), ARG_HINT_MAX_LINES)) inner.push(`  ${line}`);
	}
	if (event.resultHint) {
		const lines = wrapCapped(event.resultHint, Math.max(1, width - 4), RESULT_HINT_MAX_LINES);
		for (let i = 0; i < lines.length; i++) {
			inner.push(theme.fg("toolOutput", i === 0 ? `  ↳ ${lines[i]}` : `    ${lines[i]}`));
		}
	}
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
	const script = run.asyncDir ? readWorkflowScript(run.asyncDir) : undefined;
	if (script) {
		out.push(theme.fg("accent", clip("─── Script ───", width)));
		const scriptLines = script.split("\n");
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
			if (tokens > 0) stats.push(`${formatTokens(tokens)} tok`);
			if (child.state === "running" && child.currentTool) stats.push(`→ ${child.currentTool}`);
			const labelPart = child.label ? ` — ${child.label}` : "";
			const line = `  ${glyph} ${parallelTag}${tintAgentName(agent, colorForAgentName(agent))} · ${stats.join(" · ")}${labelPart}`;
			out.push(clip(line, width));
		}
	}
	return out;
}

// ── Tool-call humanization ─────────────────────────────────────────────────
// Raw JSON args are too faithful for the pane: a `run {code:"\n…"}` call would
// render as escaped noise. Instead each tool gets a CI-log style hint from a
// data-driven table. Host builtins are only read/edit/write/grep/ls/find;
// everything else is an extension tool with its own salient field. Display
// concern only, so it lives inside the renderer.

function firstMeaningfulLine(text: string): string {
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed) return trimmed.replace(/\s+/g, " ");
	}
	return "";
}

function str(args: Record<string, unknown>, key: string): string | undefined {
	const value = args[key];
	return typeof value === "string" && value.trim() ? value : undefined;
}

function firstStr(args: Record<string, unknown>, keys: readonly string[]): string | undefined {
	for (const key of keys) {
		const value = str(args, key);
		if (value !== undefined) return value;
	}
	return undefined;
}

const CODE_KEYS = ["code", "command", "cmd", "script"] as const;
const SALIENT_KEYS = ["path", "file", "url", "query", "pattern", "command", "task", "prompt", "name", "id"] as const;

function pathHint(args: Record<string, unknown>): string {
	const target = firstStr(args, ["path", "file_path", "filePath", "file"]);
	return target ? shortenPath(target) : "";
}

function patternPathHint(args: Record<string, unknown>): string {
	const pattern = firstStr(args, ["pattern", "query", "regex"]);
	const target = pathHint(args);
	if (pattern) return target ? `${firstMeaningfulLine(pattern)} ${target}` : firstMeaningfulLine(pattern);
	return target;
}

function codeHint(args: Record<string, unknown>): string {
	const code = firstStr(args, CODE_KEYS);
	return code ? firstMeaningfulLine(code) : "";
}

// Per-tool hint table. Builtins first, then the extension tools this repo ships.
const TOOL_HINTS: Record<string, (args: Record<string, unknown>) => string> = {
	read: pathHint,
	edit: pathHint,
	write: pathHint,
	ls: pathHint,
	grep: patternPathHint,
	find: patternPathHint,
	run: codeHint,
	bash: codeHint,
	subagent: (args) => {
		const agent = str(args, "agent");
		const task = str(args, "task");
		if (agent || task) return [agent, task ? firstMeaningfulLine(task) : undefined].filter(Boolean).join(" ");
		const action = str(args, "action");
		const id = str(args, "id");
		return [action, id].filter(Boolean).join(" ");
	},
	workflow: (args) => {
		const script = str(args, "script");
		if (script) return firstMeaningfulLine(script);
		return str(args, "phase") ?? "";
	},
	process: (args) => [str(args, "action"), str(args, "name")].filter(Boolean).join(" "),
	fetch: (args) => str(args, "url") ?? "",
	ast_grep: (args) => {
		const pattern = str(args, "pattern");
		return pattern ? firstMeaningfulLine(pattern) : "";
	},
	mcp: (args) => str(args, "tool") ?? str(args, "describe") ?? str(args, "search") ?? str(args, "server") ?? "",
	task: (args) => str(args, "action") ?? "",
	apply_patch: pathHint,
};

// Fallback for unknown tools: first string among salient keys, else the first
// short string prop — never raw JSON.
function genericHint(args: Record<string, unknown>): string {
	const salient = firstStr(args, SALIENT_KEYS);
	if (salient !== undefined) return firstMeaningfulLine(salient);
	for (const value of Object.values(args)) {
		if (typeof value === "string" && value.trim() && value.length <= 200) return firstMeaningfulLine(value);
	}
	return "";
}

export function humanizeToolArgs(toolName: string, args: Record<string, unknown> | undefined): string {
	if (!args) return "";
	const hinter = TOOL_HINTS[toolName];
	if (hinter) {
		const hint = hinter(args);
		if (hint) return hint;
	}
	return genericHint(args);
}

// The prompt is context, not content: show only its first wrapped lines with a
// dim "(N more lines)" marker instead of a wall of muted prose.
const PROMPT_PREVIEW_LINES = 3;

export function buildRightLines(theme: Theme, run: LiveRun | undefined, width: number, runs: LiveRun[] = []): string[] {
	if (!run) return [theme.fg("dim", "(no events yet)")];
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
		toolCount: number;
		final?: string;
		task?: string;
		label?: string;
		endTokens?: number;
		endDurationMs?: number;
		lastKind?: "tool" | "narration" | "other";
	};
	const steps = new Map<number, Step>();
	const ensureStep = (index: number, agent: string): Step => {
		let s = steps.get(index);
		if (!s) {
			s = { index, agent, lines: [], toolCount: 0 };
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
			if (event.label && !step.label) step.label = event.label;
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
						step.toolCount++;
						continue;
					}
				}
			}
			const hint = event.rawArgs ? humanizeToolArgs(event.toolName, event.rawArgs) : event.argsPreview;
			pushStepLines(step, "tool", buildToolBlock(theme, event, hint, width));
			step.toolCount++;
			continue;
		}
		if (event.kind === "step-end") {
			const step = ensureStep(event.stepIndex, event.agent);
			if (event.tokens !== undefined) step.endTokens = event.tokens;
			if (event.durationMs !== undefined) step.endDurationMs = event.durationMs;
			const middle: string[] = ["done"];
			if (event.status) middle.push(event.status);
			if (event.tokens !== undefined) middle.push(`${event.tokens}t`);
			if (event.durationMs !== undefined) middle.push(`${event.durationMs}ms`);
			const text = `─── ${middle.join(" · ")} ───`;
			pushStepLines(step, "other", [theme.fg("dim", clip(text, width))]);
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
	// Parallel children aren't 'steps' -- they race concurrently. Use 'Task N' so the
	// right pane reads correctly for tasks: [...] async runs.
	const stepWord = run.run.steps.length > 0 && run.run.mode === "parallel" ? "Task" : "Step";
	for (const step of ordered) {
		out.push(theme.fg("accent", clip(`─── ${stepWord} ${step.index + 1}: ${step.agent || "agent"} ───`, width)));
		if (step.label) {
			out.push(theme.fg("muted", clip(`Label: ${step.label}`, width)));
		}
		// Compact activity gist near the header so the reader doesn't have to scroll
		// through the tool feed to size up the step.
		if (step.toolCount > 0) {
			const gist = [`${step.toolCount} tool${step.toolCount === 1 ? "" : "s"}`];
			if (step.endTokens !== undefined) gist.push(`${step.endTokens}t`);
			if (step.endDurationMs !== undefined) gist.push(formatDuration(step.endDurationMs));
			out.push(theme.fg("dim", clip(gist.join(" · "), width)));
		}
		if (step.task) {
			// Host convention: user prompts render on userMessageBg — same pad-then-bg
			// pattern as the tool cards so the block spans the pane width.
			const wrapped = wrapText(step.task, Math.max(1, width - 2));
			const preview = wrapped.slice(0, PROMPT_PREVIEW_LINES);
			out.push(theme.fg("dim", clip("prompt:", width)));
			for (const line of preview) out.push(bgLine(theme, "userMessageBg", ` ${line}`, width));
			const hidden = wrapped.length - preview.length;
			if (hidden > 0) {
				out.push(
					bgLine(
						theme,
						"userMessageBg",
						theme.fg("dim", clip(` ${ELLIPSIS} (${hidden} more lines)`, width)),
						width,
					),
				);
			}
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
