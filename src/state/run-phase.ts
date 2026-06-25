import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { formatDuration } from "../shared/formatting.ts";
import type { RunPhase } from "../protocol/status-types.ts";

export type { RunPhase } from "../protocol/status-types.ts";

/**
 * Pure, JSON-serializable phase snapshot for a child agent run.
 */
export interface RunPhaseState {
	/** Current phase derived from the observed session event stream. */
	phase: RunPhase;
	/** Milliseconds since epoch when the current phase was entered. */
	phaseStartedAt: number;
	/** Milliseconds since epoch for the last event or explicit latch that touched this phase. */
	lastPhaseTickAt: number;
	/** Tool name while `phase` is `tool_running` or `tool_streaming`. */
	toolName?: string;
	/** Previous phase when the most recent transition changed `phase`; otherwise omitted. */
	previousPhase?: RunPhase;
}

type InternalRunPhaseState = RunPhaseState & {
	/** JSON-safe internal marker for queue updates seen after `turn_end` and before `turn_start`. */
	afterTurnEnd?: boolean;
};

/**
 * Create the initial idle phase state at `now`.
 */
export function initialRunPhaseState(now: number): RunPhaseState {
	return {
		phase: "idle",
		phaseStartedAt: now,
		lastPhaseTickAt: now,
	};
}

/**
 * Advance the pure phase state by one `AgentSessionEvent`.
 *
 * `previousPhase` is set only when `event` changes `phase`; consumers can treat
 * `previousPhase !== undefined` as the transition signal. Non-transition events
 * still return a fresh JSON-serializable state with `lastPhaseTickAt` set to
 * `now` and `previousPhase` omitted.
 */
export function advanceRunPhase(prev: RunPhaseState, event: AgentSessionEvent, now: number): RunPhaseState {
	const record = event as Record<string, unknown>;
	const eventType = typeof record.type === "string" ? record.type : undefined;
	const boundary = nextAfterTurnEnd(prev, eventType);

	switch (eventType) {
		case "agent_start":
			return nextState(prev, "idle", now, { afterTurnEnd: false, resetPhaseStartedAt: true });
		case "turn_start":
			return nextState(prev, prev.phase === "idle" ? "waiting_model" : prev.phase, now, {
				afterTurnEnd: false,
				toolName: phaseKeepsToolName(prev.phase) ? prev.toolName : undefined,
			});
		case "message_start":
			if (messageRole(record) === "assistant") {
				return nextState(prev, "waiting_model", now, { afterTurnEnd: boundary });
			}
			return nextState(prev, prev.phase, now, {
				afterTurnEnd: boundary,
				toolName: phaseKeepsToolName(prev.phase) ? prev.toolName : undefined,
			});
		case "message_update": {
			const assistantType = assistantMessageEventType(record);
			if (assistantType === "thinking_delta") {
				return nextState(prev, "thinking", now, { afterTurnEnd: boundary });
			}
			if (assistantType === "text_delta") {
				return nextState(prev, "streaming_text", now, { afterTurnEnd: boundary });
			}
			return nextState(prev, prev.phase, now, {
				afterTurnEnd: boundary,
				toolName: phaseKeepsToolName(prev.phase) ? prev.toolName : undefined,
			});
		}
		case "text_delta":
		case "text_end":
			return nextState(prev, "streaming_text", now, { afterTurnEnd: boundary });
		case "message_end":
			if (phaseKeepsToolName(prev.phase)) {
				return nextState(prev, prev.phase, now, { afterTurnEnd: boundary, toolName: prev.toolName });
			}
			return nextState(prev, "idle", now, { afterTurnEnd: boundary });
		case "tool_execution_start":
			return nextState(prev, "tool_running", now, {
				afterTurnEnd: boundary,
				toolName: stringField(record, "toolName"),
			});
		case "tool_execution_update":
			return nextState(prev, "tool_streaming", now, {
				afterTurnEnd: boundary,
				toolName: prev.toolName ?? stringField(record, "toolName"),
			});
		case "tool_execution_end":
			return nextState(prev, "idle", now, { afterTurnEnd: boundary });
		case "auto_retry_start":
			return nextState(prev, "retrying", now, { afterTurnEnd: boundary });
		case "auto_retry_end":
			return nextState(prev, "idle", now, { afterTurnEnd: boundary });
		case "queue_update":
			if ((prev as InternalRunPhaseState).afterTurnEnd === true && hasFollowUp(record)) {
				return nextState(prev, "queued_follow_up", now, { afterTurnEnd: true });
			}
			return nextState(prev, prev.phase, now, {
				afterTurnEnd: boundary,
				toolName: phaseKeepsToolName(prev.phase) ? prev.toolName : undefined,
			});
		case "turn_end":
			return nextState(prev, prev.phase, now, {
				afterTurnEnd: true,
				toolName: phaseKeepsToolName(prev.phase) ? prev.toolName : undefined,
			});
		case "agent_end":
			return nextState(prev, "idle", now, { afterTurnEnd: false });
		default:
			return nextState(prev, prev.phase, now, {
				afterTurnEnd: boundary,
				toolName: phaseKeepsToolName(prev.phase) ? prev.toolName : undefined,
			});
	}
}

/**
 * Explicitly latch a run into the paused phase for interrupt/abort handling.
 */
export function setPaused(prev: RunPhaseState, now: number): RunPhaseState {
	return nextState(prev, "paused", now, { afterTurnEnd: false });
}

function nextState(
	prev: RunPhaseState,
	phase: RunPhase,
	now: number,
	options: { afterTurnEnd: boolean; toolName?: string; resetPhaseStartedAt?: boolean },
): RunPhaseState {
	const phaseChanged = phase !== prev.phase;
	const next: InternalRunPhaseState = {
		phase,
		phaseStartedAt: phaseChanged || options.resetPhaseStartedAt === true ? now : prev.phaseStartedAt,
		lastPhaseTickAt: now,
	};
	if (phaseKeepsToolName(phase) && options.toolName !== undefined) {
		next.toolName = options.toolName;
	}
	if (phaseChanged) {
		next.previousPhase = prev.phase;
	}
	if (options.afterTurnEnd) {
		next.afterTurnEnd = true;
	}
	return next;
}

function nextAfterTurnEnd(prev: RunPhaseState, eventType: string | undefined): boolean {
	if (eventType === "turn_end") return true;
	if (eventType === "agent_start" || eventType === "agent_end" || eventType === "turn_start") return false;
	return (prev as InternalRunPhaseState).afterTurnEnd === true;
}

function phaseKeepsToolName(phase: RunPhase): boolean {
	return phase === "tool_running" || phase === "tool_streaming";
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" ? value : undefined;
}

function messageRole(record: Record<string, unknown>): string | undefined {
	const message = record.message;
	return message && typeof message === "object" ? stringField(message as Record<string, unknown>, "role") : undefined;
}

function assistantMessageEventType(record: Record<string, unknown>): string | undefined {
	const assistantMessageEvent = record.assistantMessageEvent;
	return assistantMessageEvent && typeof assistantMessageEvent === "object"
		? stringField(assistantMessageEvent as Record<string, unknown>, "type")
		: undefined;
}

function hasFollowUp(record: Record<string, unknown>): boolean {
	return Array.isArray(record.followUp) && record.followUp.length > 0;
}

/**
 * Format a run phase into a short human-readable label for dashboard rendering.
 *
 * Returns strings like `"thinking 12s"`, `"tool: bash 45s"`, `"retrying 3s"`,
 * `"writing 7s"`, or `"queued 2s"` with no surrounding whitespace.
 *
 * When `phase` is undefined, `"idle"`, or unrecognised, returns an empty string so
 * callers can fall back to legacy rendering (e.g. the `!` lost glyph or
 * `currentTool` indicator).
 *
 * `phaseStartedAt` is optional; when absent the duration suffix is omitted.
 */
export function formatPhase(
	phase: RunPhase | undefined,
	phaseStartedAt: number | undefined,
	now: number,
	toolName?: string,
): string {
	if (phase === undefined || phase === "idle") return "";

	const dur = phaseStartedAt !== undefined ? ` ${formatDuration(Math.max(0, now - phaseStartedAt))}` : "";

	switch (phase) {
		case "waiting_model":
			return `waiting${dur}`;
		case "thinking":
			return `thinking${dur}`;
		case "streaming_text":
			return `writing${dur}`;
		case "finishing":
			return `finishing${dur}`;
		case "tool_running":
		case "tool_streaming":
			return `tool: ${toolName ?? "tool"}${dur}`;
		case "retrying":
			return `retrying${dur}`;
		case "queued_follow_up":
			return `queued${dur}`;
		case "paused":
			return `paused${dur}`;
		default:
			return "";
	}
}
