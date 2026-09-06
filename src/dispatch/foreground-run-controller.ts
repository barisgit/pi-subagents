import type { AgentProgress, SubagentState } from "../protocol/types.ts";
import { applyForegroundProgress } from "./executor-helpers.ts";

type ForegroundControl = SubagentState["foregroundControls"] extends Map<string, infer T> ? T : never;

interface ForegroundRunControllerOptions {
	/**
	 * Optional status mirror invoked after the in-memory field-copy. Single +
	 * resume sites pass it (they echo progress into status.json); the parallel
	 * site omits it (parallel children persist via StatusWriter).
	 */
	mirror?: (firstProgress: AgentProgress | undefined, index: number, finalOutput: string | undefined) => void;
}

interface ForegroundRunController {
	/** Register a step on the control: agent/index identity + interrupt closure. */
	beginStep(agent: string, index: number, interrupt: (reason?: string) => boolean): void;
	/** Copy a runner progress snapshot onto the control, then mirror to status. */
	applyProgress(
		agent: string,
		index: number,
		firstProgress: AgentProgress | undefined,
		finalOutput: string | undefined,
	): void;
	/** Clear activity when a needs_attention interrupt fires (parallel site). */
	markNeedsAttention(): void;
	/** Teardown the active step: clear interrupt and (single only) copy final fields. */
	finalizeStep(index: number, final?: { progress: AgentProgress | undefined; finalOutput: string | undefined }): void;
}

/**
 * Own the register -> progress -> needs_attention -> teardown ordering for a
 * single foreground ForegroundControl ref (which may be undefined when no
 * in-memory control exists). Behavior-preserving wrapper around the existing
 * field-copy mutations previously inlined at the single, resume, and parallel
 * dispatch sites.
 */
export function createForegroundRunController(
	control: ForegroundControl | undefined,
	opts?: ForegroundRunControllerOptions,
): ForegroundRunController {
	const activeInterrupts = new Map<number, (reason?: string) => boolean>();
	const interruptActiveSteps = (reason?: string): boolean => {
		let interrupted = false;
		for (const interrupt of activeInterrupts.values()) {
			if (interrupt(reason)) interrupted = true;
		}
		return interrupted;
	};

	return {
		beginStep(agent, index, interrupt) {
			if (!control) return;
			activeInterrupts.set(index, interrupt);
			control.currentAgent = agent;
			control.currentIndex = index;
			control.currentActivityState = undefined;
			control.updatedAt = Date.now();
			control.interrupt = interruptActiveSteps;
		},
		applyProgress(agent, index, firstProgress, finalOutput) {
			if (!control) return;
			// First progress means a child acquired its leaf permit and began
			// executing: the live dashboard view may now render this run "running"
			// (before this it is "queued", possibly blocked on the concurrency pool).
			control.started = true;
			// Stamp the queued->running flip once so the elapsed timer measures real
			// execution time, not queue-wait. The mirror echoes this onto status.json.
			control.executionStartedAt ??= Date.now();
			applyForegroundProgress(control, agent, index, firstProgress, finalOutput);
			opts?.mirror?.(firstProgress, index, finalOutput);
		},
		markNeedsAttention() {
			if (!control) return;
			control.currentActivityState = undefined;
			control.updatedAt = Date.now();
		},
		finalizeStep(index, final) {
			if (!control || !activeInterrupts.has(index)) return;
			activeInterrupts.delete(index);
			if (final) {
				if (control.currentIndex === index) {
					control.currentActivityState = final.progress?.activityState;
					control.lastActivityAt = final.progress?.lastActivityAt;
					control.currentTool = final.progress?.currentTool;
					control.currentToolStartedAt = final.progress?.currentToolStartedAt;
					control.phase = final.progress?.phase;
					control.phaseStartedAt = final.progress?.phaseStartedAt;
					control.lastToolEndAt = final.progress?.lastToolEndAt;
					control.recentTools = final.progress?.recentTools;
					control.recentOutput = final.progress?.recentOutput;
					control.finalOutput = final.finalOutput;
				}
			}
			if (activeInterrupts.size === 0) control.interrupt = undefined;
			control.updatedAt = Date.now();
		},
	};
}
