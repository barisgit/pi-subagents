/**
 * Per-session idle tracker.
 *
 * "Idle" means: the main agent is not mid-turn AND no async subagents are in
 * flight. Sync subagent calls are naturally subsumed by the turn cycle (the
 * tool runs between turn_start and turn_end). We fire SUBAGENT_ALL_IDLE_EVENT
 * on the busy → idle transition, but only when at least one busy period has
 * elapsed since the last idle emit. That avoids spam on startup before
 * anything has happened.
 *
 * Each AgentSession (host + each child) creates its own tracker on its own
 * pi.events. A child's idle event is local to the child's runtime.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SUBAGENT_ALL_IDLE_EVENT } from "./types.ts";

export interface IdleTracker {
	onAsyncStarted(id: string): void;
	onAsyncFinished(id: string): void;
	isIdle(): boolean;
}

export function createIdleTracker(pi: ExtensionAPI): IdleTracker {
	const liveAsyncIds = new Set<string>();
	let turnInFlight = false;
	let hadActivity = false;

	const isIdle = () => !turnInFlight && liveAsyncIds.size === 0;

	const emitIfIdle = () => {
		if (!isIdle() || !hadActivity) return;
		hadActivity = false;
		try {
			pi.events.emit(SUBAGENT_ALL_IDLE_EVENT, { ts: Date.now() });
		} catch {
			// Best effort: bus may be mid-replacement during reload.
		}
	};

	pi.on("turn_start", () => {
		turnInFlight = true;
		hadActivity = true;
	});

	pi.on("turn_end", () => {
		turnInFlight = false;
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
