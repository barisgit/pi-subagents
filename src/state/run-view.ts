// Canonical dashboard display type. Both run producers — the on-disk async/
// registry overlay and the in-memory foreground runs — project onto this single
// `RunView` shape so the dashboard renders one type instead of forking on the
// run's provenance. Provenance (live vs foreign) lives on the `LiveRun` wrapper
// as `ownership`, NOT as a field on the view itself.
//
// Types-only leaf: no fs imports, no IO. The view's field types mirror the
// former AsyncRunSummary exactly; the trailing block holds foreground-only
// optionals (absent on disk-derived views).
import type { ActivityState, RunDisplayState, TokenUsage } from "../protocol/types.ts";
import type { RunPhase } from "./run-phase.ts";

export interface RunViewStep {
	index: number;
	agent: string;
	label?: string;
	status: string;
	activityState?: ActivityState;
	displayState?: RunDisplayState;
	/** Current execution phase mirrored from status.steps[i].live. */
	phase?: RunPhase;
	/** Milliseconds since epoch when the step's current phase was entered. */
	phaseStartedAt?: number;
	lastActivityAt?: number;
	currentTool?: string;
	currentToolStartedAt?: number;
	durationMs?: number;
	tokens?: TokenUsage;
	skills?: string[];
	model?: string;
	attemptedModels?: string[];
	error?: string;
	// Theme color token for the agent name; mirrored from status.steps[i].live.color.
	color?: string;
}

export interface RunView {
	id: string;
	// RELAXED to optional vs the former AsyncRunSummary: foreground views lack a
	// run-record dir until/unless one is mirrored to disk.
	asyncDir?: string;
	// charter nested-subagent-display: dashboard hierarchy parent link.
	parentRunId?: string;
	// Immediate dispatcher session. Carried from the registry entry.
	parentSessionId?: string;
	// Top-of-tree user session. Carried from the registry entry so the overlay
	// can scope strictly to the current session and its full nested subtree.
	rootSessionId?: string;
	label?: string;
	workflow?: boolean;
	phaseIndex?: number;
	phaseTitle?: string;
	parallelGroupId?: string;
	state: "queued" | "running" | "complete" | "failed" | "paused" | "lost" | "interrupted" | "skipped";
	activityState?: ActivityState;
	displayState?: RunDisplayState;
	lastActivityAt?: number;
	currentTool?: string;
	currentToolStartedAt?: number;
	mode: "single" | "parallel";
	cwd?: string;
	startedAt: number;
	/** Wall time the run actually began executing (queued->running flip); falls back to startedAt when absent. */
	executionStartedAt?: number;
	lastUpdate?: number;
	endedAt?: number;
	runnerHeartbeatAt?: number;
	resumedAt?: number;
	resumeCount?: number;
	/** Current execution phase mirrored from status.json. */
	phase?: RunPhase;
	/** Milliseconds since epoch when the current phase was entered. */
	phaseStartedAt?: number;
	currentStep?: number;
	// REQUIRED: disk views carry real steps; foreground views produce [].
	steps: RunViewStep[];
	sessionDir?: string;
	outputFile?: string;
	totalTokens?: TokenUsage;
	sessionFile?: string;
	// ── foreground-only fields (absent on disk-derived views) ──────────────────
	/** Live current agent name; foreground single/parallel progress. */
	currentAgent?: string;
	/** Theme color token for tinting the current agent name in the left pane. */
	currentAgentColor?: string;
	currentIndex?: number;
	/** Per-step caller-provided labels aligned by index. */
	agentLabels?: string[];
	recentTools?: Array<{ tool: string; args?: string; endMs?: number }>;
	recentOutput?: string[];
	finalOutput?: string;
}

// Provenance discriminator: 'live' = in-memory foreground run, 'foreign' =
// on-disk async/registry overlay run. Both carry the same RunView shape.
export type LiveRun = { ownership: "live" | "foreign"; run: RunView };
