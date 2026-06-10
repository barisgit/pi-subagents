/**
 * Per-session idle tracker.
 *
 * "Idle" means: the main agent loop has ended AND no async subagents are in
 * flight. We use agent_start / agent_end as the busy boundaries — turn_start
 * / turn_end fire between every tool round-trip and would falsely report idle
 * mid-loop. Sync subagent calls are naturally subsumed because they run as
 * tools inside the host's agent loop and complete before agent_end.
 *
 * SUBAGENT_ALL_IDLE_EVENT fires on busy → idle transitions only after at
 * least one busy period since the last idle emit, so we don't spam on
 * startup before anything has happened.
 *
 * Each AgentSession (host + each child) creates its own tracker on its own
 * pi.events. A child's idle event is local to the child's runtime.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SUBAGENT_ALL_IDLE_EVENT } from "../protocol/types.ts";

export interface IdleTracker {
	onAsyncStarted(id: string): void;
	onAsyncFinished(id: string): void;
	isIdle(): boolean;
}

export function createIdleTracker(pi: ExtensionAPI): IdleTracker {
	const liveAsyncIds = new Set<string>();
	let agentInFlight = false;
	let hadActivity = false;

	const isIdle = () => !agentInFlight && liveAsyncIds.size === 0;

	const emitIfIdle = () => {
		if (!isIdle() || !hadActivity) return;
		hadActivity = false;
		try {
			pi.events.emit(SUBAGENT_ALL_IDLE_EVENT, { ts: Date.now() });
		} catch {
			// Best effort: bus may be mid-replacement during reload.
		}
	};

	pi.on("agent_start", () => {
		agentInFlight = true;
		hadActivity = true;
	});

	pi.on("agent_end", () => {
		agentInFlight = false;
		emitIfIdle();
	});

	return {
		onAsyncStarted: (id: string) => {
			liveAsyncIds.add(id);
			hadActivity = true;
		},
		onAsyncFinished: (id: string) => {
			liveAsyncIds.delete(id);
			emitIfIdle();
		},
		isIdle,
	};
}
