/**
 * Async-jobs widget renderer (the "above editor" widget). Owns the widget
 * animation timer and the latest-widget context/TUI/jobs module state.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { type AsyncJobState, MAX_WIDGET_JOBS, WIDGET_KEY } from "../protocol/types.ts";
import { formatDuration } from "./formatters.ts";
import { compareRunsForDisplay } from "../state/run-liveness.ts";
import { formatPhase } from "../state/run-phase.ts";
import { describeAgentLabel, formatShapeBadge } from "../state/run-shape.ts";
import { colorForAgentName } from "../shared/agents.ts";
import {
	getTermWidth,
	RUNNING_GLYPH,
	themeBold,
	tintAgentName,
	truncLine,
	WIDGET_ANIMATION_MS,
	formatTokenStat,
	type Theme,
} from "./render-shared.ts";
import type { UtilsClient } from "pi-extension-utils";

let widgetTimer: ReturnType<typeof setInterval> | undefined;
let latestWidgetCtx: ExtensionContext | undefined;
let latestWidgetTui: TUI | undefined;
let latestWidgetJobs: AsyncJobState[] = [];

function hasAnimatedWidgetJobs(jobs: AsyncJobState[]): boolean {
	// A 'lost' run (stale runner heartbeat) must not drive the spinner animation.
	return jobs.some((job) => job.status === "running" && job.displayState !== "lost");
}

function widgetJobGlyph(job: AsyncJobState, theme: Theme): string {
	// A stale runner heartbeat makes displayState 'lost' even while a frozen phase
	// still lingers in status.json (e.g. a force-killed run stuck mid 'streaming_text').
	// Honor displayState directly so a dead run stops rendering as a live spinner (f5).
	if (job.status === "lost" || job.displayState === "lost") return theme.fg("error", "!");
	if (job.displayState === "needs_attention" || job.activityState === "needs_attention")
		return theme.fg("warning", "!");
	if (job.status === "running") return theme.fg("accent", RUNNING_GLYPH);
	if (job.status === "queued") return theme.fg("dim", "·");
	if (job.status === "paused") return theme.fg("warning", "⏸");
	if (job.status === "failed") return theme.fg("error", "×");
	// Finished but the completion notification has not reached the host turn
	// yet (rollup still open, or delivery raced an interrupt). Accent, not
	// success, mirrors the dashboard's delivery-pending glyph.
	if (job.pendingDelivery) return theme.fg("accent", "✓");
	return theme.fg("success", "✓");
}

function widgetJobName(job: AsyncJobState, theme: Theme): string {
	// Parallel runs race N children; `currentAgent` would be misleading (it's just the
	// most recent step's agent). Show the parallel shape and unique agents instead, with
	// each agent piece tinted by its own color when available.
	// job.agentColors/job.agentColor are not populated by the async start event or
	// status.json, so fall back to the name -> color map (same source the dashboard
	// uses) — otherwise every async agent name renders uncolored in the widget.
	if (job.kind === "workflow") {
		// The workflow is ONE entity: one tinted name, with the current phase
		// (mirrored into job.label by the tracker) as its label.
		let base = tintAgentName(themeBold(theme, "workflow"), colorForAgentName("workflow"));
		if (job.label) {
			base += ` ${theme.fg("dim", "·")} ${theme.fg("muted", truncLine(job.label, 30))}`;
		}
		return base;
	}
	const agents = job.agents ?? [];
	const fallbackName = job.currentAgent ?? job.agents?.[0] ?? "agent";
	const desc = describeAgentLabel(
		agents.length ? agents : [fallbackName],
		job.mode ?? "single",
		// Empty string is the tracker's "no live color yet" sentinel (step.live?.color ?? ""),
		// not an explicit color; treat it as absent so each slot falls back by role name.
		job.agentColor || colorForAgentName(fallbackName),
		job.agentColors
			? job.agentColors.map((c, i) => c || colorForAgentName(agents[i] ?? fallbackName))
			: agents.map((a) => colorForAgentName(a)),
	);
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
	if (job.kind === "workflow") {
		// Group row: durable "X done · Y running · Z queued" tally. A workflow's
		// child count N is unknowable up front (runtime fan-out), so there is no
		// "done/total" fraction — only the live breakdown of what's settled vs
		// in flight. Counts come from the registry so completed children that were
		// cleaned out of the live map still show as done.
		const c = job.childCounts;
		if (c && c.done + c.running + c.queued > 0) {
			const segs: string[] = [];
			if (c.done > 0) segs.push(`${c.done} done`);
			if (c.running > 0) segs.push(`${c.running} running`);
			if (c.queued > 0) segs.push(`${c.queued} queued`);
			parts.push(segs.join(" · "));
		}
		if (job.pendingDelivery) parts.push(theme.fg("accent", "delivering…"));
		if (job.startedAt) {
			const isLive = job.status === "running" || job.status === "queued";
			const endTs = isLive ? Date.now() : (job.updatedAt ?? Date.now());
			parts.push(formatDuration(Math.max(0, endTs - job.startedAt)));
		}
		return parts.length > 0 ? theme.fg("dim", parts.join(" · ")) : "";
	}
	const stepsTotal = job.stepsTotal ?? job.agents?.length ?? 1;
	const completedParallelSteps = job.stepStatuses?.filter(
		(status) => status === "complete" || status === "failed" || status === "skipped",
	).length;
	// Label distinguishes sequence (sequential multi-step) from parallel (concurrent children).
	const badge = formatShapeBadge({
		mode: job.mode ?? "single",
		total: stepsTotal,
		current: job.mode === "parallel" ? (completedParallelSteps ?? 0) : (job.currentStep ?? 0) + 1,
	});
	if (badge) parts.push(badge);
	// A queued job is blocked on a leaf permit and has not begun executing: render the
	// lifecycle state explicitly (not the `quiet` activity discriminant) and skip the
	// phase chip + running timer below, so it never shows a misleading ticking elapsed.
	const isQueued = job.status === "queued";
	// Suppress phase chip for terminal runs so finished jobs don't keep
	// ticking `streaming Xs` / `tool: bash Xs` (stale phase from status.json
	// written before the finalize phase-clear lands).
	const phaseAllowed =
		!isQueued &&
		job.status !== "complete" &&
		job.status !== "failed" &&
		job.status !== "lost" &&
		job.displayState !== "lost";
	const phaseLabel = phaseAllowed ? formatPhase(job.phase, job.phaseStartedAt, Date.now(), job.currentTool) : "";
	if (isQueued) parts.push("queued");
	else if (phaseLabel) parts.push(phaseLabel);
	else if (job.status === "lost" || job.displayState === "lost") parts.push(theme.fg("error", "lost"));
	else if (job.displayState === "tool_running" && job.currentTool) parts.push(`tool ${job.currentTool}`);
	else if (job.displayState === "needs_attention") parts.push(theme.fg("warning", "needs attention"));
	else if (job.displayState === "quiet") parts.push("quiet");
	if (job.totalTokens?.total) parts.push(formatTokenStat(job.totalTokens.total));
	// 'done, result not yet delivered to the host turn' was invisible when the
	// only cue was the accent-vs-success checkmark tint; say it outright.
	if (job.pendingDelivery) parts.push(theme.fg("accent", "delivering…"));
	if ((job.resumeCount ?? 0) > 0) parts.push(`↻${job.resumeCount}`);
	// Skip the elapsed timer entirely for a queued job: it has no execution-start
	// instant yet, so `now - startedAt` would count queue-wait, not run time.
	if (job.startedAt && !isQueued) {
		// A 'lost' run is dead: freeze elapsed at its last known update instead of
		// ticking live, even though job.status may still read 'running' on disk.
		const isLive = job.status === "running" && job.displayState !== "lost";
		const endTs = isLive ? Date.now() : (job.updatedAt ?? Date.now());
		// Measure from the execution-start flip when known, else dispatch time.
		parts.push(formatDuration(Math.max(0, endTs - (job.resumedAt ?? job.executionStartedAt ?? job.startedAt))));
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
	// The workflow is ONE entity in the widget: its children are tracked for
	// aggregation but never rendered as rows (the dashboard shows the tree).
	const workflowIds = new Set(jobs.filter((job) => job.kind === "workflow").map((job) => job.asyncId));
	if (workflowIds.size > 0) {
		jobs = jobs.filter((job) => !(job.parentRunId && workflowIds.has(job.parentRunId)));
	}
	const nonWorkflowContainerIds = new Set(
		jobs
			.filter(
				(job) =>
					job.kind !== "workflow" &&
					job.mode === "parallel" &&
					jobs.some((other) => other.parentRunId === job.asyncId),
			)
			.map((job) => job.asyncId),
	);
	if (nonWorkflowContainerIds.size > 0) {
		jobs = jobs.filter((job) => !nonWorkflowContainerIds.has(job.asyncId));
	}
	if (jobs.length === 0) return [];

	// Single ordering rule: needs_attention pinned to the very top, then strictly by
	// spawn time (newest first). Bucket-by-status would pin old failures above
	// recently completed/running runs, which fights the user's mental model. The
	// glyph on each row already communicates status.
	const sorted = orderWidgetJobsWithChildren([...jobs].sort(compareRunsForDisplay));
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
		const branchGlyph =
			depth > 0 ? `${"  ".repeat(Math.max(0, depth - 1))}${isLast ? "└─" : "├─"}` : isLast ? "└─" : "├─";
		const branch = theme.fg("dim", branchGlyph);
		const glyph = widgetJobGlyph(job, theme);
		const name = widgetJobName(job, theme);
		const stats = widgetJobStats(job, theme);
		const statsPart = stats ? ` ${theme.fg("dim", "·")} ${stats}` : "";
		lines.push(truncLine(`${branch} ${glyph} ${name}${statsPart}`, width));
	}

	if (overflow > 0) {
		// When every hidden job is queued (the common permit-blocked fan-out case),
		// label the rollup `+N queued` so the user sees they are waiting, not active.
		const hidden = sorted.slice(visible.length);
		const allQueued = hidden.every((job) => job.status === "queued");
		const overflowLabel = allQueued ? `+${overflow} queued` : `+${overflow} more`;
		lines.push(truncLine(`${theme.fg("dim", "└─")} ${theme.fg("dim", overflowLabel)}`, width));
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
		invalidate: () => {
			/* no cached state */
		},
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
			stopWidgetTimer();
			return;
		}
		refreshAnimatedWidget();
	}, WIDGET_ANIMATION_MS);
	widgetTimer.unref?.();
}

function stopWidgetTimer(): void {
	if (widgetTimer) {
		clearInterval(widgetTimer);
		widgetTimer = undefined;
	}
}

export function stopWidgetAnimation(): void {
	stopWidgetTimer();
	latestWidgetCtx = undefined;
	latestWidgetTui = undefined;
	latestWidgetJobs = [];
}

/**
 * Render the async jobs widget
 */
export function renderWidget(ctx: ExtensionContext, jobs: AsyncJobState[], client?: UtilsClient): void {
	if (jobs.length === 0) {
		stopWidgetAnimation();
		if (ctx.hasUI) {
			if (client) client.widgets.remove("aboveEditor", WIDGET_KEY);
			else ctx.ui.setWidget(WIDGET_KEY, undefined);
		}
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
	const factory = (tui: TUI, theme: Theme) => {
		latestWidgetTui = tui;
		return buildWidgetComponent(theme);
	};
	if (client) client.widgets.set("aboveEditor", WIDGET_KEY, factory as Parameters<UtilsClient["widgets"]["set"]>[2]);
	else ctx.ui.setWidget(WIDGET_KEY, factory);
	if (hasAnimatedWidgetJobs(jobs)) ensureWidgetAnimation();
	else stopWidgetTimer();
}
