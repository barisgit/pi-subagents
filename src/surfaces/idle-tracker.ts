/**
 * Session-local busy-to-idle tracking; see SUBAGENT_ALL_IDLE_EVENT for the contract.
 * agent_end is not a boundary: Pi may still retry, compact, recover from overflow,
 * or drain queued follow-ups before agent_settled.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SUBAGENT_ALL_IDLE_EVENT } from "../protocol/types.ts";

export interface IdleTracker {
	onAsyncStarted(id: string): void;
	onAsyncFinished(id: string): void;
	hasActiveAsyncRuns(): boolean;
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

	pi.on("agent_settled", () => {
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
		hasActiveAsyncRuns: () => liveAsyncIds.size > 0,
		isIdle,
	};
}
