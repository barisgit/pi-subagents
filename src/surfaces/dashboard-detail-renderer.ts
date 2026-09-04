/**
 * Right-pane / transcript renderer for the subagent dashboard. Builds the
 * detail-pane line buffers for a selected run: the generic per-step transcript
 * (buildRightLines) and the purpose-built workflow-group pane (script + phase
 * outline) via buildWorkflowRightLines. Pure functions over run data — the
 * SubagentsStatusComponent owns selection/scroll and feeds the selected run in.
 */

import * as fs from "node:fs";
import * as path from "node:path";
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
import type { AgentProgress } from "../protocol/types.ts";
import { Markdown, type TUI, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
	type AsyncRunSummary,
	readLeafRunViewCached,
	sortedWorkflowChildren,
	workflowPhaseLabel,
} from "../state/async-status.ts";
import { readWorkflowGroupRecord, readWorkflowScript } from "../workflow/workflow-group-state.ts";
import { readRunTranscript, type RunMessageSession, type TranscriptLine } from "../state/run-transcript.ts";
import { formatDuration, formatTokenCounter, shortenPath } from "./formatters.ts";
import { findInlineChildRun, renderNestedChild } from "./render-inline.ts";
import { RUNNING_GLYPH, tintAgentName } from "./render-shared.ts";
import { aggregateState, cellsFromRunView, renderRowLine, rowGlyph, type RowState } from "./row-line.ts";
import { parentRunIdOf, type DetailTarget } from "./dashboard-row-model.ts";
import { buildLiveCurrentLine, buildLiveHistoryLines } from "./render-result.ts";
import type { LiveRun } from "../state/run-view.ts";
import {
	dashboardPartialResult,
	type LiveToolProgress,
	type LiveToolProgressBySession,
} from "../shared/live-session-relay.ts";
import { locateOutputBlockForDisplay, OUTPUT_OPEN } from "../protocol/output-contract.ts";
import { canonicalWorkflowPhaseTitle } from "../shared/workflow-phase-title.ts";
import { formatWorkflowPhase } from "../state/workflow-display.ts";

// Single ellipsis glyph for every dashboard truncation. pi-tui's
// truncateToWidth defaults to a three-dot "..."; the rest of the surfaces use
// "…", so clip() pins the dashboard to the same single-glyph ellipsis.
const ELLIPSIS = "…";
const TAB_WIDTH = 4;

function normalizePaneText(text: string): string {
	return text.replace(/\t/g, " ".repeat(TAB_WIDTH));
}

function detailState(run: LiveRun): RowState {
	return cellsFromRunView(run.run, Date.now()).state;
}

function runDuration(run: LiveRun, now = Date.now()): number {
	return Math.max(0, (run.run.endedAt ?? now) - (run.run.executionStartedAt ?? run.run.startedAt));
}

function runAgent(run: LiveRun): string {
	return (
		run.run.currentAgent ??
		run.run.steps.find((step) => step.agent)?.agent ??
		(run.run.asyncDir
			? readLeafRunViewCached(run.run.asyncDir)?.steps.find((step) => step.agent)?.agent
			: undefined) ??
		run.run.mode
	);
}

function renderDetailStep(
	theme: Theme,
	run: LiveRun,
	width: number,
	options: { parallel?: boolean; pipelineStageCount?: number } = {},
): string {
	const cells = cellsFromRunView(run.run, Date.now());
	const agent = runAgent(run);
	cells.name = tintAgentName(agent, colorForAgentName(agent));
	delete cells.nameColor;
	cells.depth = 0;
	cells.parallel = options.parallel;
	if (run.run.phaseIndex !== undefined) {
		const title = run.run.phaseTitle ? ` ${canonicalWorkflowPhaseTitle(run.run.phaseTitle)}` : "";
		cells.phaseChip = `P${run.run.phaseIndex}${title}`;
	}
	if (options.pipelineStageCount && run.run.pipeline) {
		cells.badge = `stage ${run.run.pipeline.stageIndex + 1}/${options.pipelineStageCount}`;
	}
	return renderRowLine(theme, cells, width, "detailStep");
}

export function formatPersistedResult(text: string): string[] {
	let rendered = text;
	try {
		rendered = JSON.stringify(JSON.parse(text), null, 2);
	} catch {
		// Plain returned strings remain markdown source.
	}
	const lines = normalizePaneText(rendered).split("\n");
	if (lines.length <= 40) return lines;
	return [...lines.slice(0, 39), `${ELLIPSIS} +${lines.length - 39} lines · ⏎ open transcript`];
}

interface PipelineItemView {
	itemIndex: number;
	label?: string;
	stages: LiveRun[];
}

interface PipelineView {
	id: string;
	name: string;
	itemCount: number;
	stageCount: number;
	stageTitles: Array<string | undefined>;
	items: PipelineItemView[];
}

function workflowChildren(workflowId: string, runs: LiveRun[]): LiveRun[] {
	return runs.filter((candidate) => candidate.run.parentRunId === workflowId);
}

function pipelineView(children: LiveRun[], pipelineId: string): PipelineView {
	const stages = children.filter((child) => child.run.pipeline?.id === pipelineId);
	const itemCount = Math.max(
		1,
		...stages.map((stage) => stage.run.pipeline?.itemCount ?? (stage.run.pipeline?.itemIndex ?? 0) + 1),
	);
	const stageCount = Math.max(
		1,
		...stages.map((stage) => stage.run.pipeline?.stageCount ?? (stage.run.pipeline?.stageIndex ?? 0) + 1),
	);
	const stageTitles = Array.from({ length: stageCount }, (_, stageIndex) => {
		return stages.find((stage) => stage.run.pipeline?.stageIndex === stageIndex)?.run.pipeline?.stageTitle;
	});
	const items = Array.from({ length: itemCount }, (_, itemIndex) => {
		const itemStages = stages
			.filter((stage) => stage.run.pipeline?.itemIndex === itemIndex)
			.sort((a, b) => (a.run.pipeline?.stageIndex ?? 0) - (b.run.pipeline?.stageIndex ?? 0));
		const label = itemStages.find((stage) => stage.run.pipeline?.itemLabel)?.run.pipeline?.itemLabel;
		return { itemIndex, ...(label ? { label } : {}), stages: itemStages };
	});
	return {
		id: pipelineId,
		name: stages.find((stage) => stage.run.pipeline?.name)?.run.pipeline?.name ?? "pipeline",
		itemCount,
		stageCount,
		stageTitles,
		items,
	};
}

function pipelineGrid(theme: Theme, pipeline: PipelineView, width: number): string[] {
	const stageTitles = pipeline.stageTitles.map((title, index) => title ?? `stage ${index + 1}`);
	const out = [theme.fg("muted", clip(`item · ${stageTitles.join(" · ")} · progress · duration`, width))];
	for (const item of pipeline.items) {
		const byIndex = new Map(item.stages.map((stage) => [stage.run.pipeline?.stageIndex ?? 0, stage]));
		const glyphs = pipeline.stageTitles.map((_, stageIndex) => {
			const stage = byIndex.get(stageIndex);
			return stage ? rowGlyph(theme, detailState(stage)) : theme.fg("dim", "·");
		});
		const done = item.stages.filter((stage) =>
			["complete", "failed", "interrupted", "skipped"].includes(stage.run.state),
		).length;
		const duration = item.stages.reduce((sum, stage) => sum + runDuration(stage), 0);
		out.push(
			clip(
				`${item.label ?? `Item ${item.itemIndex + 1}`} · ${glyphs.join(" · ")} · ${done}/${pipeline.stageCount} · ${formatDuration(duration)}`,
				width,
			),
		);
	}
	return out;
}

function buildPhaseTargetLines(
	theme: Theme,
	target: Extract<DetailTarget, { kind: "phase" }>,
	width: number,
	runs: LiveRun[],
): string[] {
	const tokens = target.children.reduce((sum, child) => sum + childTokenTotal(child.run), 0);
	const title = `Phase ${target.phaseIndex}${target.title ? `: ${target.title}` : ""}`;
	const lines = [
		`${rowGlyph(theme, aggregateState(target.children.map(detailState)))} ${title}`,
		theme.fg("muted", `${target.children.length} runs · ${formatTokenCounter(tokens)} tokens`),
	];
	const pipelineIds = Array.from(
		new Set(target.children.map((child) => child.run.pipeline?.id).filter((id): id is string => id !== undefined)),
	);
	const allChildren = workflowChildren(target.workflow.run.id, runs);
	for (const pipelineId of pipelineIds) {
		const pipeline = pipelineView(allChildren, pipelineId);
		const phaseStages = target.children.filter((child) => child.run.pipeline?.id === pipelineId);
		const stageIndexes = Array.from(new Set(phaseStages.map((child) => child.run.pipeline?.stageIndex ?? 0))).sort(
			(a, b) => a - b,
		);
		for (const stageIndex of stageIndexes) {
			lines.push(
				"",
				theme.fg(
					"accent",
					clip(
						`── ${pipeline.name} · ${pipeline.stageTitles[stageIndex] ?? `stage ${stageIndex + 1}`}`,
						width,
					),
				),
			);
			for (const child of phaseStages.filter((candidate) => candidate.run.pipeline?.stageIndex === stageIndex)) {
				lines.push(renderDetailStep(theme, child, width));
			}
		}
	}
	const loose = target.children.filter((child) => child.run.pipeline === undefined);
	if (loose.length > 0) lines.push("", theme.fg("accent", clip("── Loose runs", width)));
	for (const child of loose) {
		lines.push(renderDetailStep(theme, child, width, { parallel: Boolean(child.run.parallelGroupId) }));
	}
	return lines.map((line) => clip(line, width));
}

function buildPipelineGroupTargetLines(
	theme: Theme,
	target: Extract<DetailTarget, { kind: "pipelineGroup" }>,
	width: number,
	runs: LiveRun[],
): string[] {
	const pipeline = pipelineView(workflowChildren(target.workflow.run.id, runs), target.pipelineId);
	const title = pipeline.stageTitles[target.stageIndex] ?? `stage ${target.stageIndex + 1}`;
	const lines = [
		clip(
			`${rowGlyph(theme, aggregateState(target.runs.map(detailState)))} ${pipeline.name} · ${title} · ${target.runs.length}/${pipeline.itemCount} items`,
			width,
		),
		"",
		theme.fg(
			"accent",
			clip(`── ${pipeline.name} (${pipeline.itemCount} items × ${pipeline.stageCount} stages)`, width),
		),
		...pipelineGrid(theme, pipeline, width),
		"",
		theme.fg("accent", clip(`── ${title}`, width)),
	];
	for (const child of target.runs) lines.push(renderDetailStep(theme, child, width));
	return lines;
}

function progressForStage(stage: LiveRun): AgentProgress {
	const recentTools = (stage.run.recentTools ?? []).map((entry) => ({
		tool: entry.tool,
		args: entry.args ?? "",
		endMs: entry.endMs ?? stage.run.lastUpdate ?? stage.run.startedAt,
	}));
	const status =
		stage.run.state === "complete"
			? "completed"
			: stage.run.state === "failed" || stage.run.state === "lost"
				? "failed"
				: stage.run.state === "running"
					? "running"
					: "pending";
	return {
		agent: runAgent(stage),
		status,
		task: "",
		...(stage.run.activityState ? { activityState: stage.run.activityState } : {}),
		...(stage.run.lastActivityAt !== undefined ? { lastActivityAt: stage.run.lastActivityAt } : {}),
		...(stage.run.currentTool ? { currentTool: stage.run.currentTool } : {}),
		...(stage.run.currentToolStartedAt !== undefined
			? { currentToolStartedAt: stage.run.currentToolStartedAt }
			: {}),
		...(stage.run.phase ? { phase: stage.run.phase } : {}),
		...(stage.run.phaseStartedAt !== undefined ? { phaseStartedAt: stage.run.phaseStartedAt } : {}),
		...(recentTools.at(-1)?.endMs !== undefined ? { lastToolEndAt: recentTools.at(-1)?.endMs } : {}),
		recentTools,
		recentOutput: stage.run.recentOutput ?? [],
		toolCount: recentTools.length + (stage.run.currentTool ? 1 : 0),
		tokens: childTokenTotal(stage.run),
		durationMs: runDuration(stage),
	};
}

function buildPipelineChainLines(theme: Theme, selected: LiveRun, width: number, runs: LiveRun[]): string[] {
	const metadata = selected.run.pipeline;
	if (!metadata) return [];
	const children = workflowChildren(selected.run.parentRunId ?? "", runs);
	const pipeline = pipelineView(children, metadata.id);
	const item = pipeline.items[metadata.itemIndex] ?? { itemIndex: metadata.itemIndex, stages: [] };
	const byStage = new Map(item.stages.map((stage) => [stage.run.pipeline?.stageIndex ?? 0, stage]));
	const totalDuration = item.stages.reduce((sum, stage) => sum + runDuration(stage), 0);
	const states = item.stages.map(detailState);
	const itemOrdinal = metadata.itemCount
		? `item ${metadata.itemIndex + 1}/${metadata.itemCount}`
		: `item ${metadata.itemIndex + 1}`;
	const stageCount = metadata.stageCount ?? pipeline.stageCount;
	const lines = [
		clip(
			`${rowGlyph(theme, aggregateState(states))} ${item.label ?? `item ${metadata.itemIndex + 1}`}   ${pipeline.name} · ${itemOrdinal} · stage ${metadata.stageIndex + 1}/${stageCount} · ${formatDuration(totalDuration)}`,
			width,
		),
	];
	for (let stageIndex = 0; stageIndex < pipeline.stageCount; stageIndex += 1) {
		const stage = byStage.get(stageIndex);
		const stageTitle = pipeline.stageTitles[stageIndex];
		const ruleTitle = stageTitle ?? "stage";
		if (!stage) {
			lines.push(
				"",
				theme.fg(
					"dim",
					clip(`── ${ruleTitle} ${stageIndex + 1}/${pipeline.stageCount} ── · not started`, width),
				),
			);
			continue;
		}
		const agent = runAgent(stage);
		const toolCount = (stage.run.recentTools?.length ?? 0) + (stage.run.currentTool ? 1 : 0);
		const stats = `${rowGlyph(theme, detailState(stage))} ${tintAgentName(agent, colorForAgentName(agent))} · ${toolCount} tool${toolCount === 1 ? "" : "s"} · ${formatTokenCounter(childTokenTotal(stage.run))} tokens · ${formatDuration(runDuration(stage))}`;
		const rule = clip(`── ${ruleTitle} ${stageIndex + 1}/${pipeline.stageCount} ── ${stats}`, width);
		lines.push("", stage.run.id === selected.run.id ? theme.fg("accent", rule) : theme.fg("muted", rule));
		if (stage.run.state === "running") {
			const progress = progressForStage(stage);
			for (const history of buildLiveHistoryLines(progress, 3, width))
				lines.push(theme.fg("dim", clip(history, width)));
			const current = buildLiveCurrentLine(progress, width, runAgent(stage));
			lines.push(theme.fg(current.tone, clip(current.text, width)));
		} else if (stage.run.finalOutput !== undefined) {
			lines.push(...renderMarkdownLines(formatPersistedResult(stage.run.finalOutput).join("\n"), width));
		}
	}
	return lines;
}

function buildPipelineStageHeader(theme: Theme, run: LiveRun, width: number): string[] {
	const metadata = run.run.pipeline;
	if (!metadata) return buildRunHeader(theme, run, width);
	const agent = runAgent(run);
	const toolCount = (run.run.recentTools?.length ?? 0) + (run.run.currentTool ? 1 : 0);
	const stageCount = metadata.stageCount ?? metadata.stageIndex + 1;
	return [
		clip(
			`${rowGlyph(theme, detailState(run))} ${metadata.itemLabel ?? `item ${metadata.itemIndex + 1}`} · ${metadata.name ?? "pipeline"} · ${metadata.stageTitle ?? "stage"} ${metadata.stageIndex + 1}/${stageCount} · ${tintAgentName(agent, colorForAgentName(agent))} · ${toolCount} tool${toolCount === 1 ? "" : "s"} · ${formatTokenCounter(childTokenTotal(run.run))} tokens · ${formatDuration(runDuration(run))}`,
			width,
		),
		theme.fg("dim", clip("⏎ item chain", width)),
	];
}

function buildRunHeader(theme: Theme, run: LiveRun, width: number): string[] {
	const tokens = childTokenTotal(run.run);
	return [
		renderDetailStep(theme, run, width),
		theme.fg("muted", clip(`${run.run.mode} · ${formatTokenCounter(tokens)} tokens`, width)),
	];
}

export function buildRightLines(
	theme: Theme,
	targetOrRun: DetailTarget | LiveRun | undefined,
	width: number,
	runs: LiveRun[] = [],
	live?: Parameters<typeof buildRunRightLines>[4],
	historical?: Parameters<typeof buildRunRightLines>[5],
	options: { pipelineChain?: boolean } = {},
): string[] {
	if (!targetOrRun) return [theme.fg("dim", "(no events yet)")];
	const target: DetailTarget = "ownership" in targetOrRun ? { kind: "run", run: targetOrRun } : targetOrRun;
	if (target.kind === "phase") return buildPhaseTargetLines(theme, target, width, runs);
	if (target.kind === "pipelineGroup") return buildPipelineGroupTargetLines(theme, target, width, runs);
	if (target.run.run.workflow) return buildWorkflowRightLines(theme, target.run.run, width, runs);
	if (target.run.run.pipeline) {
		if (options.pipelineChain) return buildPipelineChainLines(theme, target.run, width, runs);
		return [
			...buildPipelineStageHeader(theme, target.run, width),
			...buildRunRightLines(theme, target.run, width, runs, live, historical),
		];
	}
	return [
		...buildRunHeader(theme, target.run, width),
		...buildRunRightLines(theme, target.run, width, runs, live, historical),
	];
}

function outputPanelContent(content: string): { kind: "json" | "markdown"; text: string } {
	try {
		return { kind: "json", text: JSON.stringify(JSON.parse(content), null, 2) };
	} catch {
		return { kind: "markdown", text: content };
	}
}

function renderOutputPanel(theme: Theme, content: string, width: number): string[] {
	const innerWidth = Math.max(1, width - 2);
	const panel = outputPanelContent(content);
	const rendered =
		panel.kind === "json"
			? fitAnsiLines(panel.text.split("\n"), innerWidth)
			: renderMarkdownLines(panel.text, innerWidth);
	const lines = ["", ...rendered.map((line) => ` ${line}`), ""];
	return ["", ...lines.map((line) => bgLine(theme, "customMessageBg", theme.fg("customMessageText", line), width))];
}

function renderOutputAwareText(theme: Theme, text: string, width: number): string[] | undefined {
	const output = locateOutputBlockForDisplay(text);
	if (!output) return undefined;
	return [
		...renderMarkdownLines(output.prefix, width),
		...renderOutputPanel(theme, output.content, width),
		...renderMarkdownLines(output.suffix, width),
	];
}

type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;

function withoutAssistantStopMetadata(message: AssistantMessage): AssistantMessage {
	return { ...message, stopReason: "stop", errorMessage: undefined };
}

function hasAssistantStopFooter(message: AssistantMessage): boolean {
	return message.stopReason === "length" || message.stopReason === "aborted" || message.stopReason === "error";
}

function isOutputPanelEligible(message: AssistantMessage): boolean {
	return !message.content.some((content) => content.type === "toolCall");
}

function renderAssistantMessage(
	theme: Theme,
	message: AssistantMessage,
	hideThinking: boolean,
	width: number,
): string[] {
	let laterIncompleteOutput = false;
	for (let index = message.content.length - 1; index >= 0; index--) {
		const item = message.content[index];
		if (item?.type !== "text") continue;
		const output = locateOutputBlockForDisplay(item.text);
		if (!output) {
			if (item.text.includes(OUTPUT_OPEN)) laterIncompleteOutput = true;
			continue;
		}
		if (laterIncompleteOutput) break;
		const beforeContent = [
			...message.content.slice(0, index),
			...(output.prefix ? [{ ...item, text: output.prefix }] : []),
		];
		const afterContent = [
			...(output.suffix ? [{ ...item, text: output.suffix }] : []),
			...message.content.slice(index + 1),
		];
		const lines: string[] = [];
		if (beforeContent.length > 0) {
			lines.push(
				...new AssistantMessageComponent(
					{ ...withoutAssistantStopMetadata(message), content: beforeContent },
					hideThinking,
					getMarkdownTheme(),
					undefined,
					0,
				).render(width),
			);
		}
		lines.push(...renderOutputPanel(theme, output.content, width));
		if (afterContent.length > 0) {
			lines.push(
				...new AssistantMessageComponent(
					{ ...withoutAssistantStopMetadata(message), content: afterContent },
					hideThinking,
					getMarkdownTheme(),
					undefined,
					0,
				).render(width),
			);
		}
		if (hasAssistantStopFooter(message)) {
			lines.push(
				...new AssistantMessageComponent(
					{ ...message, content: [] },
					hideThinking,
					getMarkdownTheme(),
					undefined,
					0,
				).render(width),
			);
		}
		return lines;
	}
	return new AssistantMessageComponent(message, hideThinking, getMarkdownTheme(), undefined, 0).render(width);
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
	const children = workflowChildren(run.id, runs);
	const header = cellsFromRunView(run, Date.now());
	header.name = run.workflowMeta?.name ?? "workflow";
	out.push(renderRowLine(theme, header, width, "detailStep"));
	if (run.workflowMeta?.description) {
		for (const line of wrapTextWithAnsi(run.workflowMeta.description, width)) out.push(theme.fg("muted", line));
	}

	const script = run.asyncDir ? readWorkflowScript(run.asyncDir) : undefined;
	if (script) {
		out.push("", theme.fg("accent", clip("── Script", width)));
		const scriptLines = normalizePaneText(script).split("\n");
		while (scriptLines.length > 0 && scriptLines[0]?.trim() === "") scriptLines.shift();
		while (scriptLines.length > 0 && scriptLines[scriptLines.length - 1]?.trim() === "") scriptLines.pop();
		for (const line of highlightCode(scriptLines.join("\n"), "ts")) {
			if (visibleWidth(line) <= width) out.push(line);
			else out.push(...wrapTextWithAnsi(line, width));
		}
	}

	out.push("", theme.fg("accent", clip("── Phases", width)));
	const phaseIndexes = Array.from(
		new Set([
			...(run.workflowMeta?.phases.map((_, index) => index + 1) ?? []),
			...children.map((child) => child.run.phaseIndex).filter((index): index is number => index !== undefined),
		]),
	).sort((a, b) => a - b);
	for (const phaseIndex of phaseIndexes) {
		const phaseChildren = children.filter((child) => child.run.phaseIndex === phaseIndex);
		const title =
			run.workflowMeta?.phases[phaseIndex - 1]?.title ??
			children.find((child) => child.run.phaseIndex === phaseIndex)?.run.phaseTitle;
		const phase = formatWorkflowPhase(run.workflowMeta, phaseIndex, title) ?? `Phase ${phaseIndex}`;
		if (phaseChildren.length === 0) {
			out.push(theme.fg("dim", clip(`· ${phase} –`, width)));
			continue;
		}
		const done = phaseChildren.filter((child) =>
			["complete", "failed", "interrupted", "skipped"].includes(child.run.state),
		).length;
		const duration = phaseChildren.reduce((sum, child) => sum + runDuration(child), 0);
		out.push(
			clip(
				`${rowGlyph(theme, aggregateState(phaseChildren.map(detailState)))} ${phase} ${done}/${phaseChildren.length} · ${formatDuration(duration)}`,
				width,
			),
		);
	}
	const done = children.filter((child) =>
		["complete", "failed", "interrupted", "skipped"].includes(child.run.state),
	).length;
	const running = children.filter((child) => child.run.state === "running").length;
	const queued = children.filter((child) => child.run.state === "queued").length;
	const tokens = children.reduce((sum, child) => sum + childTokenTotal(child.run), 0);
	const totalDuration = children.reduce((sum, child) => sum + runDuration(child), 0);
	out.push(
		theme.fg(
			"muted",
			clip(
				`${children.length} runs · ${done} done · ${running} running · ${queued} queued · ${formatTokenCounter(tokens)} tokens · ${formatDuration(totalDuration)}`,
				width,
			),
		),
	);

	const pipelineIds = Array.from(
		new Set(children.map((child) => child.run.pipeline?.id).filter((id): id is string => id !== undefined)),
	);
	for (const pipelineId of pipelineIds) {
		const pipeline = pipelineView(children, pipelineId);
		out.push(
			"",
			theme.fg(
				"accent",
				clip(`── ${pipeline.name} (${pipeline.itemCount} items × ${pipeline.stageCount} stages)`, width),
			),
			...pipelineGrid(theme, pipeline, width),
		);
	}

	const loose = children.filter((child) => child.run.pipeline === undefined);
	if (loose.length > 0) {
		out.push("", theme.fg("accent", clip("── Loose runs", width)));
		for (const child of sortedWorkflowChildren(loose.map((candidate) => candidate.run))) {
			const live = loose.find((candidate) => candidate.run.id === child.id);
			if (live) out.push(renderDetailStep(theme, live, width, { parallel: Boolean(child.parallelGroupId) }));
		}
	}

	const result = run.asyncDir ? readWorkflowGroupRecord(run.asyncDir)?.result : undefined;
	if (result) {
		out.push("", theme.fg("accent", clip("── Result", width)));
		out.push(
			...(result.json ? fitAnsiLines(result.text.split("\n"), width) : renderMarkdownLines(result.text, width)),
		);
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
	readonly cacheKey?: DashboardMessageSession;
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
		session = session.cacheKey ?? session;
		this.entries.delete(session);
		if (this.liveToolComponents) {
			this.liveToolComponents.releaseSession(session);
			this.pendingSessions.delete(session);
		} else {
			this.clearPendingTools(session);
		}
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
		for (const session of [...this.pendingSessions]) {
			if (this.liveToolComponents) this.liveToolComponents.releaseSession(session);
			else this.clearPendingTools(session);
		}
		this.pendingSessions.clear();
	}

	invalidate(session: DashboardMessageSession, event?: AgentSessionEvent): void {
		session = session.cacheKey ?? session;
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
		const cacheSession = session.cacheKey ?? session;
		const entry = this.entries.get(cacheSession);
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
		let pendingTools = this.liveToolComponents?.toolsFor(cacheSession) ?? this.pendingTools.get(cacheSession);
		if (!pendingTools) {
			pendingTools = new Map();
			if (!this.liveToolComponents) this.pendingTools.set(cacheSession, pendingTools);
		}
		for (let index = rebuildFrom; index < groups.length; index++) {
			const messages = groups[index]!;
			renderedGroups.push({ messages, lines: renderGroup(messages, pendingTools) });
		}
		const lines = renderedGroups.flatMap((group) => group.lines);
		if (this.liveToolComponents) {
			for (const [toolCallId, pending] of pendingTools) {
				if (pending.completed) pendingTools.delete(toolCallId);
			}
		}
		if (this.liveToolComponents && pendingTools.size === 0) this.liveToolComponents.releaseSession(cacheSession);
		if (pendingTools.size > 0) {
			this.pendingSessions.add(cacheSession);
		} else {
			if (!this.liveToolComponents) this.pendingTools.delete(cacheSession);
			this.pendingSessions.delete(cacheSession);
		}
		this.entries.set(cacheSession, { width, revision, groups: renderedGroups, lines });
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
	theme: Theme,
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
			if (isOutputPanelEligible(message)) {
				lines.push(...renderAssistantMessage(theme, message, display.hideThinking, width));
			} else {
				lines.push(
					...new AssistantMessageComponent(message, display.hideThinking, markdownTheme, undefined, 0).render(
						width,
					),
				);
			}
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
	theme: Theme,
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
				theme,
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

function buildRunRightLines(
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
		loading?: boolean;
	},
): string[] {
	if (!run) return [theme.fg("dim", "(no events yet)")];
	if (live?.sessions.length) {
		try {
			const lines = buildLiveRightLines(
				theme,
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
				theme,
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
	if (historical?.loading) return [theme.fg("dim", "Loading transcript…")];
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
		finalOutputEligible?: boolean;
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
			const outputLines =
				event.outputEligible !== false ? renderOutputAwareText(theme, event.text, width) : undefined;
			if (outputLines) {
				pushStepLines(step, "other", outputLines);
				continue;
			}
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
						const nested = renderNestedChild(child.id, 1, event.rawArgs, rightPaneUsed, theme).map((line) =>
							clip(line, width),
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
			step.finalOutputEligible = event.outputEligible !== false;
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
			const outputLines =
				step.finalOutputEligible !== false ? renderOutputAwareText(theme, step.final, width) : undefined;
			if (outputLines) {
				out.push(...outputLines);
			} else {
				const border = "─".repeat(Math.max(0, width));
				out.push(theme.fg("dim", border));
				for (const wrapped of renderMarkdownLines(step.final, width)) out.push(wrapped);
				out.push(theme.fg("dim", border));
			}
		}
	}
	return out;
}
