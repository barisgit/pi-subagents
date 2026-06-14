/**
 * Inline-child renderer: looks up and renders nested async child runs inline
 * (the one-level-deep nested cards inside a compact result). Owns the inline
 * child-run lookup cache.
 */

import { readStatus } from "../shared/utils.ts";
import { statusToSummary, type AsyncRunSummary } from "../state/async-status.ts";
import { formatPhase } from "../state/run-phase.ts";
import { readRunTranscript, type TranscriptLine } from "../state/run-transcript.ts";
import { readAllEntries } from "../state/runs-registry.ts";
import { formatDuration, formatTokens } from "./formatters.ts";


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

export function argBoolean(args: Record<string, unknown> | undefined, key: string): boolean {
	return args?.[key] === true;
}

function childMatchesArgs(child: AsyncRunSummary, args: Record<string, unknown> | undefined): boolean {
	// The subagent tool's real args are { run: [{ agent, task, label? }] }, so agent/label
	// live under run[0], not at the top level. Accept either shape (top-level is used by
	// some synthetic callers/tests; run[0] is the on-disk dispatch shape).
	const firstRun = Array.isArray((args as { run?: unknown })?.run)
		? ((args as { run: Array<Record<string, unknown>> }).run[0])
		: undefined;
	const agent = argString(args, "agent") ?? argString(firstRun, "agent");
	const label = argString(args, "label") ?? argString(firstRun, "label");
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
	return `${tools} tools · ${formatTokens(tokens)} tok · ${formatDuration(inlineDuration(summary))}`;
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

export function renderInlineAsyncToolLine(parentRunId: string, args: Record<string, unknown> | undefined, used = new Set<string>()): string | undefined {
	const child = findInlineChildRun(parentRunId, args, used);
	if (!child) return undefined;
	used.add(child.id);
	return `${inlinePrefix(1)} subagent (background): ${inlineRunAgent(child, args)} · ${inlineRunLabel(child, args)} → ${child.id.slice(0, 8)}`;
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

/**
 * Render ONE async-widget-style summary line for a single nested child run.
 *
 * The inline widget is a glance; the dashboard is the tree. We deliberately render
 * at most one level of nesting inline: the dispatched agent (level 0) keeps its full
 * card, but each subagent it spawns (level 1) collapses to a single rolled-up line —
 * for running and terminal children alike. Sub-subagents (level 2+) are never expanded
 * inline; their tools fold into this line's `inlineMeta` tool count and a `↳ K nested`
 * hint points at the dashboard. This is structurally bounded (header + own tools +
 * one line per direct child) with no depth×breadth compounding.
 *
 * Mirrors the async widget's run line: a kind tag (subagent | parallel | workflow),
 * the agent/label, rolled-up tools/tokens/duration, and — while running — what the
 * child is doing now (the phase chip).
 */
export function renderNestedChild(runId: string, depth = 1, args?: Record<string, unknown>, used = new Set<string>()): string[] {
	const data = readInlineRun(runId);
	if (!data) return [];
	const { summary, events } = data;
	used.add(runId);
	const label = inlineRunLabel(summary, args);
	const glyph = inlineStateGlyph(summary.state);
	const kind = summary.workflow ? "workflow" : summary.mode === "parallel" ? "parallel" : "subagent";
	const meta = inlineMeta(summary, events);
	const nested = countCollapsedNested(runId);
	const nestedHint = nested.nested > 0 ? ` · ↳ ${nested.nested} nested` : "";
	if (isTerminalInlineState(summary.state)) {
		return [`${inlinePrefix(depth)} ${glyph} ${kind}: ${label} · ${meta}${nestedHint}`];
	}
	// Running: show the agent and what it's doing now (phase chip), like the async widget.
	const phase = formatPhase(summary.phase, summary.phaseStartedAt, Date.now(), summary.currentTool);
	const phasePart = phase ? ` · ${phase}` : "";
	return [`${inlinePrefix(depth)} ${glyph} ${kind}: ${inlineRunAgent(summary, args)} · ${label} · ${meta}${phasePart}${nestedHint}`];
}
