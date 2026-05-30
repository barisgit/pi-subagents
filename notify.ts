/**
 * Subagent completion notifications.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildCompletionKey, getGlobalSeenMap, markSeenWithTtl } from "./completion-dedupe.ts";
import { getCurrentPi } from "./current-pi.ts";
import { logger } from "./logger.ts";
import { SUBAGENT_ASYNC_COMPLETE_EVENT, SUBAGENT_ASYNC_RUN_COMPLETE_EVENT } from "./types.ts";

interface ChainStepResult {
	agent: string;
	output?: string;
	summary?: string;
	success: boolean;
	id?: string;
	runId?: string;
	dispatchRunId?: string;
	batchId?: string;
	stepIndex?: number;
	state?: string;
	exitCode?: number;
	durationMs?: number;
	sessionFile?: string;
	shareUrl?: string;
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

type NotifyPolicy = "rollup" | "each" | "silent";

interface SubagentResult {
	id: string | null;
	runId?: string;
	parentRunId?: string;
	rootRunId?: string;
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
	children?: ChainStepResult[];
	batch?: boolean;
	batchId?: string;
	notifyPolicy?: NotifyPolicy;
	total?: number;
	completed?: number;
	taskIndex?: number;
	totalTasks?: number;
}

function statusFor(result: Pick<SubagentResult, "success" | "exitCode" | "state" | "summary">): "completed" | "failed" | "paused" {
	const summary = typeof result.summary === "string" ? result.summary : "";
	const paused = !result.success && (
		result.exitCode === 0
		|| result.state === "paused"
		|| summary.startsWith("Paused after interrupt.")
	);
	return paused ? "paused" : result.success ? "completed" : "failed";
}

function singleNotificationContent(result: SubagentResult): string {
	const agent = result.agent ?? "unknown";
	const summary = typeof result.summary === "string" ? result.summary : "";
	const status = statusFor(result);

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
	return [
		`Background task ${status}: **${agent}**${taskInfo}`,
		"",
		displaySummary,
		sessionLine ? "" : undefined,
		sessionLine,
	]
		.filter((line) => line !== undefined)
		.join("\n");
}

function batchNotificationContent(result: SubagentResult, children: ChainStepResult[]): string {
	const total = result.total ?? children.length;
	const completed = result.completed ?? children.filter((child) => child.state === "complete" || child.success).length;
	const lines = children.map((child) => {
		const childRunId = child.runId ?? child.id ?? "unknown";
		const state = child.state ?? (child.success ? "complete" : "failed");
		const agent = child.agent || "unknown";
		return `- ${childRunId} (${agent}): ${state}`;
	});
	return [
		`Background batch completed: **${completed}/${total} tasks complete**`,
		"",
		...lines,
	].join("\n");
}

function notifyPolicyFor(result: SubagentResult): NotifyPolicy {
	if (result.notifyPolicy === "rollup" || result.notifyPolicy === "each" || result.notifyPolicy === "silent") return result.notifyPolicy;
	return result.batch === true ? "rollup" : "each";
}

function childResultFrom(result: SubagentResult, child: ChainStepResult, index: number, total: number): SubagentResult {
	return {
		...result,
		id: child.id ?? child.runId ?? `${result.id ?? "subagent"}:${index}`,
		runId: child.runId,
		agent: child.agent ?? null,
		success: child.success,
		summary: child.summary ?? child.output ?? "",
		exitCode: child.exitCode,
		state: child.state,
		durationMs: child.durationMs,
		sessionFile: child.sessionFile,
		shareUrl: child.shareUrl,
		taskIndex: child.stepIndex ?? index,
		totalTasks: total,
	};
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
	const groupedRuns = new Map<string, SubagentResult[]>();

	const sendNotification = (idLabel: string, content: string) => {
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

	const sendOnce = (result: SubagentResult, now: number) => {
		const key = buildCompletionKey(result, "notify");
		if (markSeenWithTtl(seen, key, now, ttlMs)) {
			logger.info("notify.handleComplete: DEDUPED", { id: result.id ?? "<null>", key });
			return;
		}
		sendNotification(result.id ?? "<null>", singleNotificationContent(result));
	};

	const notifyChildren = (result: SubagentResult, children: ChainStepResult[], now: number) => {
		const total = result.total ?? children.length;
		for (const [index, child] of children.entries()) {
			sendOnce(childResultFrom(result, child, index, total), now);
		}
	};

	const handleRunComplete = (data: unknown) => {
		const result = data as SubagentResult;
		const parentRunId = result.parentRunId;
		if (!parentRunId) return;
		const policy = notifyPolicyFor(result);
		if (policy === "silent") return;
		const now = Date.now();
		if (policy === "each") {
			sendOnce(result, now);
			return;
		}
		const bucket = groupedRuns.get(parentRunId) ?? [];
		bucket.push(result);
		groupedRuns.set(parentRunId, bucket);
	};

	const handleComplete = (data: unknown) => {
		const result = data as SubagentResult;
		const idLabel = result.id ?? "<null>";
		logger.info("notify.handleComplete: FIRED", { id: idLabel, agent: result.agent ?? undefined, success: result.success });
		const now = Date.now();
		const children = Array.isArray(result.children) && result.children.length > 0 ? result.children : undefined;
		const policy = notifyPolicyFor(result);
		const groupRunId = result.runId ?? result.id ?? undefined;
		const accumulated = groupRunId ? groupedRuns.get(groupRunId) : undefined;
		if (groupRunId) groupedRuns.delete(groupRunId);

		if (policy === "silent") return;

		if (accumulated && accumulated.length > 0) {
			if (policy === "rollup") {
				const rollupChildren = accumulated.map((child, index) => ({
					id: child.id ?? child.runId ?? `${groupRunId}:${index}`,
					runId: child.runId,
					dispatchRunId: child.parentRunId,
					stepIndex: child.taskIndex ?? index,
					agent: child.agent ?? "unknown",
					state: child.state,
					success: child.success,
					exitCode: child.exitCode,
					summary: child.summary,
					durationMs: child.durationMs,
					sessionFile: child.sessionFile,
					shareUrl: child.shareUrl,
				}));
				const rollup: SubagentResult = {
					...result,
					total: result.total ?? rollupChildren.length,
					completed: result.completed ?? rollupChildren.filter((child) => child.state === "complete" || child.success).length,
				};
				const key = buildCompletionKey(rollup, "notify");
				if (markSeenWithTtl(seen, key, now, ttlMs)) {
					logger.info("notify.handleComplete: DEDUPED", { id: idLabel, key });
					return;
				}
				sendNotification(idLabel, batchNotificationContent(rollup, rollupChildren));
			}
			return;
		}

		// Back-compat: older emitters and chain/single paths only send the group
		// completion event with children[]. Preserve the previous behavior when no
		// time-separated per-run events were accumulated for this group.
		if (children && policy === "each") {
			notifyChildren(result, children, now);
			return;
		}

		const key = buildCompletionKey(result, "notify");
		if (markSeenWithTtl(seen, key, now, ttlMs)) {
			logger.info("notify.handleComplete: DEDUPED", { id: idLabel, key });
			return;
		}

		const content = children && policy === "rollup"
			? batchNotificationContent(result, children)
			: singleNotificationContent(result);
		sendNotification(idLabel, content);
	};

	// Subscribe on this session's pi.events bus. The subscription is re-attached
	// on every host activate (the unsubscribeStoreKey block tears down the
	// previous one above), so host listeners stay bound to the latest live bus.
	// Child sessions subscribe on their own ephemeral bus and let their bus
	// disposal clean up the listener; they must not write the host's slot.
	logger.info("registerSubagentNotify: subscribing to async-complete", { isChildSession });
	const unsubscribeComplete = pi.events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, handleComplete);
	const unsubscribeRunComplete = pi.events.on(SUBAGENT_ASYNC_RUN_COMPLETE_EVENT, handleRunComplete);
	const unsubscribe = () => {
		unsubscribeComplete();
		unsubscribeRunComplete();
	};
	if (!isChildSession) {
		globalStore[unsubscribeStoreKey] = unsubscribe;
	}
}
