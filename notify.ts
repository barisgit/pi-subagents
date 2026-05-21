/**
 * Subagent completion notifications.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildCompletionKey, getGlobalSeenMap, markSeenWithTtl } from "./completion-dedupe.ts";
import { getCurrentPi } from "./current-pi.ts";
import { logger } from "./logger.ts";
import { SUBAGENT_ASYNC_COMPLETE_EVENT } from "./types.ts";

interface ChainStepResult {
	agent: string;
	output: string;
	success: boolean;
}

export interface SubagentNotifyDetails {
	agent: string;
	status: "completed" | "failed" | "paused";
	taskInfo?: string;
	resultPreview: string;
	durationMs?: number;
	sessionLabel?: string;
	sessionValue?: string;
}

interface SubagentResult {
	id: string | null;
	agent: string | null;
	success: boolean;
	summary: string;
	exitCode?: number;
	state?: string;
	timestamp: number;
	durationMs?: number;
	sessionFile?: string;
	shareUrl?: string;
	gistUrl?: string;
	shareError?: string;
	results?: ChainStepResult[];
	taskIndex?: number;
	totalTasks?: number;
}

export default function registerSubagentNotify(pi: ExtensionAPI): void {
	const unsubscribeStoreKey = "__pi_subagents_notify_unsubscribe__";
	const childSessionFlagKey = "__piSubagentInsideChildSession";
	const globalStore = globalThis as Record<string, unknown>;
	const isChildSession = globalStore[childSessionFlagKey] === true;

	// CHILD sessions must NEVER touch the host's notify slot. The host owns the
	// reload-resilient subscription on the user's pi.events bus; a child's
	// pi.events is a different (ephemeral) bus and its subscription dies with
	// its own ExtensionRunner. Calling the host's previousUnsubscribe from a
	// child would remove the host's notify handler and the user never gets the
	// completion message.
	if (!isChildSession) {
		const previousUnsubscribe = globalStore[unsubscribeStoreKey];
		if (typeof previousUnsubscribe === "function") {
			try {
				previousUnsubscribe();
			} catch {
				// Best effort cleanup for stale handlers from an older reload.
			}
		}
	}

	const seen = getGlobalSeenMap("__pi_subagents_notify_seen__");
	const ttlMs = 10 * 60 * 1000;

	const handleComplete = (data: unknown) => {
		const result = data as SubagentResult;
		const idLabel = result.id ?? "<null>";
		logger.info("notify.handleComplete: FIRED", { id: idLabel, agent: result.agent ?? undefined, success: result.success });
		const now = Date.now();
		const key = buildCompletionKey(result, "notify");
		if (markSeenWithTtl(seen, key, now, ttlMs)) {
			logger.info("notify.handleComplete: DEDUPED", { id: idLabel, key });
			return;
		}

		const agent = result.agent ?? "unknown";
		const summary = typeof result.summary === "string" ? result.summary : "";
		const paused = !result.success && (
			result.exitCode === 0
			|| result.state === "paused"
			|| summary.startsWith("Paused after interrupt.")
		);
		const status = paused ? "paused" : result.success ? "completed" : "failed";

		const taskInfo =
			result.taskIndex !== undefined && result.totalTasks !== undefined
				? ` (${result.taskIndex + 1}/${result.totalTasks})`
				: "";

		const sessionLine = result.shareUrl
			? `Session: ${result.shareUrl}`
			: result.shareError
				? `Session share error: ${result.shareError}`
				: result.sessionFile
					? `Session file: ${result.sessionFile}`
					: undefined;

		const displaySummary = summary.trim() ? summary : "(no output)";
		const content = [
			`Background task ${status}: **${agent}**${taskInfo}`,
			"",
			displaySummary,
			sessionLine ? "" : undefined,
			sessionLine,
		]
			.filter((line) => line !== undefined)
			.join("\n");

		// Cannot use the captured `pi` from registration time: the activate that
		// registered this handler may have been replaced by ctx.reload()/fork()/
		// newSession()/switchSession(), invalidating that pi. We must resolve the
		// CURRENT pi at call time.
		try {
			const currentPi = getCurrentPi();
			logger.info("notify.handleComplete: calling sendMessage", { id: idLabel, hasPi: !!currentPi });
			currentPi.sendMessage(
				{
					customType: "subagent-notify",
					content,
					display: true,
				},
				{ triggerTurn: true },
			);
			logger.info("notify.handleComplete: sendMessage returned", { id: idLabel });
		} catch (err) {
			logger.error("notify.handleComplete: sendMessage threw", err instanceof Error ? err : new Error(String(err)), { id: idLabel });
		}
	};

	// Subscribe on this session's pi.events bus. The subscription is re-attached
	// on every host activate (the unsubscribeStoreKey block tears down the
	// previous one above), so host listeners stay bound to the latest live bus.
	// Child sessions subscribe on their own ephemeral bus and let their bus
	// disposal clean up the listener; they must not write the host's slot.
	logger.info("registerSubagentNotify: subscribing to async-complete", { isChildSession });
	const unsubscribe = pi.events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, handleComplete);
	if (!isChildSession) {
		globalStore[unsubscribeStoreKey] = unsubscribe;
	}
}
