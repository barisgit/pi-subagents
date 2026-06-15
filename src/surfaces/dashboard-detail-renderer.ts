/**
 * Right-pane / transcript renderer for the subagent dashboard. Builds the
 * detail-pane line buffers for a selected run: the generic per-step transcript
 * (buildRightLines) and the purpose-built workflow-group pane (script + phase
 * outline) via buildWorkflowRightLines. Pure functions over run data — the
 * SubagentsStatusComponent owns selection/scroll and feeds the selected run in.
 */

import { colorForAgentName } from "../shared/agents.ts";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { type AsyncRunSummary, sortedWorkflowChildren, workflowPhaseLabel } from "../state/async-status.ts";
import { readWorkflowScript } from "../workflow/workflow-group-state.ts";
import { previewArgs, readRunTranscript } from "../state/run-transcript.ts";
import { formatDuration, formatTokens } from "./formatters.ts";
import { findInlineChildRun, renderNestedChild } from "./render-inline.ts";
import { multiSpinnerFrame, tintAgentName } from "./render-shared.ts";
import type { ActivityState, RunDisplayState } from "../protocol/types.ts";
import { parentRunIdOf } from "./dashboard-row-model.ts";
import type { LiveRun } from "../state/run-view.ts";

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
			return theme.fg("accent", multiSpinnerFrame());
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
	// Children are selected by structural parent linkage (parentRunId), NOT
	// provenance: an owned-async run's children (now ownership:'live') must still
	// appear in the right-pane Steps list.
	const children = runs.filter((candidate) => candidate.run.parentRunId === run.id).map((candidate) => candidate.run);
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
		ended?: boolean;
		task?: string;
		label?: string;
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
		out.push(
			theme.fg(
				"accent",
				truncateToWidth(`─── ${stepWord} ${step.index + 1}: ${step.agent || "agent"} ───`, width),
			),
		);
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
