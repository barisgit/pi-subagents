/**
 * Shared grammar for compact surface rows.
 *
 * RowCells is an identity-free text-line DTO, NOT a run representation. It
 * must not gain run ids, parent ids, lineage, or other identity fields.
 */
import type { SingleResult } from "../protocol/types.ts";
import type { RunView } from "../state/run-view.ts";
import { colorForAgentName } from "../shared/agents.ts";
import { formatDuration, formatTokenCounter } from "../shared/formatting.ts";
import { RUNNING_GLYPH, tintAgentName, truncLine, type Theme } from "./render-shared.ts";

export type RowState =
	| "queued"
	| "running"
	| "paused"
	| "complete"
	| "failed"
	| "interrupted"
	| "skipped"
	| "lost"
	| "attention"
	| "delivering";

export function stateKey(state: RowState): "accent" | "success" | "error" | "warning" | "dim" {
	switch (state) {
		case "running":
		case "delivering":
			return "accent";
		case "complete":
			return "success";
		case "failed":
		case "lost":
			return "error";
		case "paused":
		case "interrupted":
		case "attention":
			return "warning";
		case "queued":
		case "skipped":
			return "dim";
	}
}

/** Dashboard-compatible glyphs: queued ○, running ◈, paused ⏸, complete ✓,
 * failed ✗, interrupted ■, skipped ·, lost/attention !, delivering ✓. */
export function rowGlyph(theme: Theme, state: RowState): string {
	const glyph: Record<RowState, string> = {
		queued: "○",
		running: RUNNING_GLYPH,
		paused: "⏸",
		complete: "✓",
		failed: "✗",
		interrupted: "■",
		skipped: "·",
		lost: "!",
		attention: "!",
		delivering: "✓",
	};
	return theme.fg(stateKey(state), glyph[state]);
}

export function aggregateState(children: readonly RowState[]): RowState {
	if (children.length === 0) return "queued";
	if (children.includes("failed")) return "failed";
	if (children.includes("lost")) return "lost";
	if (children.includes("attention")) return "attention";
	if (children.includes("running")) return "running";
	if (children.includes("queued")) return "queued";
	return "complete";
}

export interface RowCells {
	state: RowState;
	name: string;
	nameColor?: string;
	depth?: number;
	selected?: boolean;
	marker?: "collapsed" | "expanded";
	phaseChip?: string;
	badge?: string;
	label?: string;
	tools?: number;
	tokens?: number;
	durationMs?: number;
	endedAt?: number;
	stageStrip?: readonly RowState[];
	parallel?: boolean;
	resumeCount?: number;
	/** A completed container with no emitted child rows keeps the hollow marker. */
	empty?: boolean;
	/** Original-run age for resumed runs; the primary duration remains the current leg. */
	identityDurationMs?: number;
}

export type RowVariant = "dashboard" | "widget" | "detailStep" | "notice";

function textWidth(text: string): number {
	return Array.from(text.replace(/\x1b\[[0-9;]*m/g, "")).length;
}

function rowGlyphCell(theme: Theme, cells: RowCells): string {
	if (cells.empty) return theme.fg("dim", "○");
	if (cells.marker) return theme.fg(stateKey(cells.state), cells.marker === "collapsed" ? "▸" : "▾");
	if (cells.stageStrip && cells.stageStrip.length > 0) {
		return cells.stageStrip.map((state) => rowGlyph(theme, state)).join("");
	}
	return rowGlyph(theme, cells.state);
}

function rowName(theme: Theme, cells: RowCells): string {
	const prefix = cells.parallel ? theme.fg("dim", "∥ ") : "";
	if (cells.nameColor) return `${prefix}${tintAgentName(cells.name, cells.nameColor)}`;
	if (cells.marker || cells.stageStrip) return `${prefix}${theme.fg(stateKey(cells.state), cells.name)}`;
	return `${prefix}${cells.name}`;
}

export function renderRowLine(theme: Theme, cells: RowCells, width: number, variant: RowVariant): string {
	if (width <= 0) return "";
	const cursor = variant === "dashboard" ? (cells.selected ? theme.fg("accent", "> ") : "  ") : "";
	const depth = Math.max(0, cells.depth ?? 0);
	const indent = depth > 0 ? theme.fg("dim", `${"  ".repeat(depth - 1)}└─`) : "";
	const parts: string[] = [`${cursor}${indent}${rowGlyphCell(theme, cells)} ${rowName(theme, cells)}`];
	if (cells.phaseChip) parts.push(theme.fg("dim", cells.phaseChip));
	if (cells.badge) parts.push(theme.fg("dim", cells.badge));
	if ((cells.resumeCount ?? 0) > 0) parts.push(theme.fg("dim", `resumed ${cells.resumeCount}×`));
	if (cells.label) parts.push(theme.fg("muted", cells.label));
	if (cells.tools !== undefined) parts.push(theme.fg("dim", `${cells.tools} tool${cells.tools === 1 ? "" : "s"}`));
	if (cells.tokens !== undefined) parts.push(theme.fg("dim", formatTokenCounter(cells.tokens)));
	if (cells.durationMs !== undefined) parts.push(theme.fg("dim", formatDuration(Math.max(0, cells.durationMs))));
	if (cells.identityDurationMs !== undefined) {
		parts.push(theme.fg("dim", `age ${formatDuration(Math.max(0, cells.identityDurationMs))}`));
	}
	const base = parts.join(" · ");
	if (variant !== "dashboard" || cells.endedAt === undefined) return truncLine(base, width);

	const date = new Date(cells.endedAt);
	const stamp = theme.fg(
		"dim",
		`@${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`,
	);
	const stampWidth = 6;
	if (width <= stampWidth) return truncLine(stamp, width);
	const clippedBase = truncLine(base, width - stampWidth - 1);
	const gap = " ".repeat(Math.max(1, width - textWidth(clippedBase) - stampWidth));
	return `${clippedBase}${gap}${stamp}`;
}

export interface RowCellOptions {
	depth?: number;
	selected?: boolean;
	phaseChip?: string;
	badge?: string;
	pendingDelivery?: boolean;
}

function rowStateFromRunView(run: RunView, pendingDelivery: boolean): RowState {
	if (run.displayState === "lost" || run.state === "lost") return "lost";
	if (run.displayState === "needs_attention" || run.activityState === "needs_attention") return "attention";
	if (pendingDelivery) return "delivering";
	return run.state;
}

function runNameAndColor(run: RunView): { name: string; nameColor?: string } {
	if (run.currentAgent) {
		return {
			name: run.currentAgent,
			nameColor: run.currentAgentColor ?? colorForAgentName(run.currentAgent),
		};
	}
	const steps = run.steps.filter((step) => step.agent);
	if (run.mode === "parallel" && steps.length > 1) {
		const names = Array.from(new Set(steps.map((step) => step.agent)));
		if (names.length === 1) {
			const name = names[0] ?? run.mode;
			return { name: `parallel(${steps.length})`, nameColor: steps[0]?.color ?? colorForAgentName(name) };
		}
		return { name: names.join("+") };
	}
	const step = steps.find((candidate) => candidate.status === "running") ?? steps[0];
	const name = step?.agent ?? run.mode;
	const nameColor = step?.color ?? colorForAgentName(name);
	return { name, ...(nameColor !== undefined ? { nameColor } : {}) };
}

function isFrozenRun(run: RunView): boolean {
	return (
		run.state === "complete" ||
		run.state === "failed" ||
		run.state === "interrupted" ||
		run.state === "skipped" ||
		run.state === "paused" ||
		run.state === "lost" ||
		run.displayState === "lost"
	);
}

export function cellsFromRunView(run: RunView, now: number, opts: RowCellOptions = {}): RowCells {
	const state = rowStateFromRunView(run, opts.pendingDelivery ?? false);
	const name = runNameAndColor(run);
	const cells: RowCells = {
		state,
		...name,
		...(opts.depth !== undefined ? { depth: opts.depth } : {}),
		...(opts.selected !== undefined ? { selected: opts.selected } : {}),
		...(opts.phaseChip !== undefined ? { phaseChip: opts.phaseChip } : {}),
		...(opts.badge !== undefined ? { badge: opts.badge } : {}),
		...(run.label !== undefined ? { label: run.label } : {}),
		...((run.resumeCount ?? 0) > 0 ? { resumeCount: run.resumeCount } : {}),
	};
	if (run.state === "queued") return cells;

	const startedAt = run.resumedAt ?? run.executionStartedAt ?? run.startedAt;
	const frozenEnd = run.endedAt ?? (isFrozenRun(run) ? (run.lastUpdate ?? run.startedAt) : undefined);
	const durationEnd = frozenEnd ?? now;
	cells.durationMs = Math.max(0, durationEnd - startedAt);
	if ((run.resumeCount ?? 0) > 0) cells.identityDurationMs = Math.max(0, durationEnd - run.startedAt);
	const stampEnd = run.endedAt ?? (state === "lost" ? frozenEnd : undefined);
	if (stampEnd !== undefined) cells.endedAt = stampEnd;
	return cells;
}

export function cellsFromSingleResult(
	result: SingleResult,
	opts: Omit<RowCellOptions, "pendingDelivery"> = {},
): RowCells {
	const state: RowState = result.interrupted
		? "interrupted"
		: result.detached
			? "paused"
			: result.progress?.status === "pending"
				? "queued"
				: result.progress?.status === "running"
					? result.progress.activityState === "needs_attention"
						? "attention"
						: "running"
					: result.exitCode === 0
						? "complete"
						: "failed";
	const tokens = result.progress?.tokens ?? result.usage.input + result.usage.output;
	return {
		state,
		name: result.agent,
		...(result.progress?.color !== undefined ? { nameColor: result.progress.color } : {}),
		...(opts.depth !== undefined ? { depth: opts.depth } : {}),
		...(opts.selected !== undefined ? { selected: opts.selected } : {}),
		...(opts.phaseChip !== undefined ? { phaseChip: opts.phaseChip } : {}),
		...(opts.badge !== undefined ? { badge: opts.badge } : {}),
		...(result.label !== undefined ? { label: result.label } : {}),
		...((result.progress?.toolCount ?? result.toolCallCount) !== undefined
			? { tools: result.progress?.toolCount ?? result.toolCallCount }
			: {}),
		tokens,
		...(result.progress?.durationMs !== undefined ? { durationMs: result.progress.durationMs } : {}),
	};
}
