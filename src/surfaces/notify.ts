/**
 * Subagent completion notifications.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { enqueueNestedCompletionReprompt } from "../dispatch/nested-async-coordinator.ts";
import { buildCompletionKey, getGlobalSeenMap, markSeenWithTtl } from "../state/completion-dedupe.ts";
import { getCurrentPi } from "../shared/current-pi.ts";
import { logger } from "../shared/logger.ts";
import { isInsideChildSession } from "../shared/child-session-context.ts";
import {
	SUBAGENT_ASYNC_COMPLETE_EVENT,
	SUBAGENT_ASYNC_RUN_COMPLETE_EVENT,
	SUBAGENT_NOTIFY_DELIVERED_EVENT,
} from "../protocol/types.ts";

interface ChildStepResult {
	agent: string;
	label?: string;
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

function dedupeChildrenByRunIdKeepLatest(children: ChildStepResult[]): ChildStepResult[] {
	const byRunId = new Map<string, ChildStepResult>();
	const passthrough: ChildStepResult[] = [];
	for (const child of children) {
		const runId = child.runId ?? child.id;
		if (!runId) {
			passthrough.push(child);
			continue;
		}
		byRunId.set(runId, child);
	}
	return [...passthrough, ...byRunId.values()];
}

export interface SubagentNotifyDetails {
	kind?: "single";
	agent: string;
	status: "completed" | "failed" | "paused" | "interrupted";
	taskInfo?: string;
	resultPreview: string;
	durationMs?: number;
	sessionLabel?: string;
	sessionValue?: string;
}

export interface SubagentBatchNotifyDetails {
	kind: "batch";
	completed: number;
	total: number;
	children: Array<{ label?: string; agent: string; state: string; runId: string; resultPreview: string }>;
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
	label?: string;
	timestamp: number;
	durationMs?: number;
	sessionFile?: string;
	shareUrl?: string;
	gistUrl?: string;
	shareError?: string;
	results?: ChildStepResult[];
	children?: ChildStepResult[];
	batch?: boolean;
	batchId?: string;
	kind?: string;
	notifyPolicy?: NotifyPolicy;
	total?: number;
	completed?: number;
	taskIndex?: number;
	totalTasks?: number;
}

function statusFor(
	result: Pick<SubagentResult, "success" | "exitCode" | "state" | "summary">,
): "completed" | "failed" | "paused" | "interrupted" {
	const summary = typeof result.summary === "string" ? result.summary : "";
	const paused =
		!result.success &&
		(result.exitCode === 0 || result.state === "paused" || summary.startsWith("Paused after interrupt."));
	if (paused) return "paused";
	// Interruption is a deliberate user/parent action, not a failure.
	if (!result.success && result.state === "interrupted") return "interrupted";
	return result.success ? "completed" : "failed";
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

const BATCH_CHILD_OUTPUT_MAX_CHARS = 2000;

function batchNotificationContent(result: SubagentResult, children: ChildStepResult[]): string {
	const total = result.total ?? children.length;
	const completed =
		result.completed ?? children.filter((child) => child.state === "complete" || child.success).length;
	const lines = children.flatMap((child) => {
		const childRunId = child.runId ?? child.id ?? "unknown";
		const state = child.state ?? (child.success ? "complete" : "failed");
		const agent = child.agent || "unknown";
		const name = child.label?.trim() || agent || shortRunId(childRunId);
		const output = batchChildDisplayOutput(child);
		return [
			`- ${stateGlyph(state)} ${name} (${agent}): ${state}`,
			...output.split("\n").map((line) => `  ${line}`),
		];
	});
	return [`Background batch completed: **${completed}/${total} tasks complete**`, "", ...lines].join("\n");
}

function batchChildDisplayOutput(child: ChildStepResult): string {
	return truncateBatchChildOutput((child.summary ?? child.output ?? "").trim() || "(no output)");
}

function truncateBatchChildOutput(output: string): string {
	return output.length > BATCH_CHILD_OUTPUT_MAX_CHARS
		? `${output.slice(0, BATCH_CHILD_OUTPUT_MAX_CHARS - 1)}…`
		: output;
}

function shortRunId(runId: string): string {
	return runId.length > 8 ? runId.slice(0, 8) : runId;
}

function stateGlyph(state: string): string {
	if (state === "complete" || state === "completed") return "✓";
	if (state === "paused" || state === "interrupted") return "■";
	return "✗";
}

function batchNotificationDetails(result: SubagentResult, children: ChildStepResult[]): SubagentBatchNotifyDetails {
	const total = result.total ?? children.length;
	const completed =
		result.completed ?? children.filter((child) => child.state === "complete" || child.success).length;
	return {
		kind: "batch",
		completed,
		total,
		children: children.map((child) => {
			const runId = child.runId ?? child.id ?? "unknown";
			const state = child.state ?? (child.success ? "complete" : "failed");
			return {
				...(child.label ? { label: child.label } : {}),
				agent: child.agent || "unknown",
				state,
				runId,
				resultPreview: batchChildDisplayOutput(child),
			};
		}),
	};
}

function notifyPolicyFor(result: SubagentResult): NotifyPolicy {
	if (result.notifyPolicy === "rollup" || result.notifyPolicy === "each" || result.notifyPolicy === "silent")
		return result.notifyPolicy;
	return result.batch === true ? "rollup" : "each";
}

function childResultFrom(result: SubagentResult, child: ChildStepResult, index: number, total: number): SubagentResult {
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
		label: child.label,
		taskIndex: child.stepIndex ?? index,
		totalTasks: total,
	};
}

export default function registerSubagentNotify(
	pi: ExtensionAPI,
	getParentRunId: () => string | null = () => null,
): void {
	const unsubscribeStoreKey = "__pi_subagents_notify_unsubscribe__";
	const globalStore = globalThis as Record<string, unknown>;
	const isChildSession = isInsideChildSession();

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
	const notificationPi = () => (isChildSession ? pi : getCurrentPi());

	// Tell the widget which runs a notification covered (or would have covered,
	// for deduped/silent results) so it can retire their rows. Resolve the
	// current pi at call time for the same reload-safety reason as below.
	const emitDelivered = (runIds: Array<string | undefined>) => {
		const ids = runIds.filter((id): id is string => typeof id === "string" && id.length > 0);
		if (ids.length === 0) return;
		try {
			notificationPi().events.emit(SUBAGENT_NOTIFY_DELIVERED_EVENT, { runIds: ids });
		} catch (err) {
			logger.warn("notify.emitDelivered: threw", { err: err instanceof Error ? err.message : String(err) });
		}
	};

	// Interrupt-drop safety net. When the host agent is streaming, sendMessage
	// queues the notification on the agent's steering queue; a user interrupt
	// clears that queue (clearAllQueues) and the notification is permanently
	// dropped. Track sends made while streaming as unconfirmed, confirm them
	// when their custom message is consumed (message_end), and on an aborted
	// agent_end resend the survivors as deliverAs:'nextTurn' so they arrive
	// with the user's next prompt instead of vanishing.
	let agentStreaming = false;
	interface UnconfirmedSend {
		idLabel: string;
		content: string;
		details?: SubagentNotifyDetails | SubagentBatchNotifyDetails;
	}
	const unconfirmedSends: UnconfirmedSend[] = [];
	const UNCONFIRMED_CAP = 20;

	const sendNotification = (
		idLabel: string,
		content: string,
		details?: SubagentNotifyDetails | SubagentBatchNotifyDetails,
	) => {
		// Cannot use the captured `pi` from registration time: the activate that
		// registered this handler may have been replaced by ctx.reload()/fork()/
		// newSession()/switchSession(), invalidating that pi. We must resolve the
		// CURRENT pi at call time.
		const send = () => {
			try {
				const currentPi = notificationPi();
				logger.info("notify.handleComplete: calling sendMessage", { id: idLabel, hasPi: !!currentPi });
				currentPi.sendMessage(
					{
						customType: "subagent-notify",
						content,
						display: true,
						...(details ? { details } : {}),
					},
					{ triggerTurn: true },
				);
				if (agentStreaming) {
					unconfirmedSends.push({ idLabel, content, details });
					if (unconfirmedSends.length > UNCONFIRMED_CAP)
						unconfirmedSends.splice(0, unconfirmedSends.length - UNCONFIRMED_CAP);
				}
				logger.info("notify.handleComplete: sendMessage returned", { id: idLabel });
				return true;
			} catch (err) {
				logger.error(
					"notify.handleComplete: sendMessage threw",
					err instanceof Error ? err : new Error(String(err)),
					{ id: idLabel },
				);
				return false;
			}
		};
		const parentRunId = isChildSession ? getParentRunId() : null;
		if (parentRunId) enqueueNestedCompletionReprompt(parentRunId, send);
		else send();
	};

	const sendOnce = (result: SubagentResult, now: number) => {
		const key = buildCompletionKey(result, "notify");
		if (markSeenWithTtl(seen, key, now, ttlMs)) {
			logger.info("notify.handleComplete: DEDUPED", { id: result.id ?? "<null>", key });
			emitDelivered([result.runId ?? result.id ?? undefined]);
			return;
		}
		sendNotification(result.id ?? "<null>", singleNotificationContent(result));
		emitDelivered([result.runId ?? result.id ?? undefined]);
	};

	const notifyChildren = (result: SubagentResult, children: ChildStepResult[], now: number) => {
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
		if (policy === "silent") {
			emitDelivered([result.runId ?? result.id ?? undefined]);
			return;
		}
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
		logger.info("notify.handleComplete: FIRED", {
			id: idLabel,
			agent: result.agent ?? undefined,
			success: result.success,
		});
		const now = Date.now();
		const children = Array.isArray(result.children) && result.children.length > 0 ? result.children : undefined;
		const policy = notifyPolicyFor(result);
		const groupRunId = result.runId ?? result.id ?? undefined;
		const accumulated = groupRunId ? groupedRuns.get(groupRunId) : undefined;
		if (groupRunId) groupedRuns.delete(groupRunId);
		const coveredRunIds = [
			groupRunId,
			...(accumulated ?? []).map((child) => child.runId ?? child.id ?? undefined),
			...(Array.isArray(result.children)
				? result.children.map((child) => child.runId ?? child.id ?? undefined)
				: []),
		];

		if (policy === "silent") {
			emitDelivered(coveredRunIds);
			return;
		}

		// A workflow is ONE entity: exactly one notification carrying the script's
		// return value as the summary. Its children are emitted silent and must
		// never fan out through the back-compat children+each path below.
		if (result.kind === "workflow") {
			const key = buildCompletionKey(result, "notify");
			if (markSeenWithTtl(seen, key, now, ttlMs)) {
				logger.info("notify.handleComplete: DEDUPED", { id: idLabel, key });
				emitDelivered(coveredRunIds);
				return;
			}
			sendNotification(idLabel, singleNotificationContent(result));
			emitDelivered(coveredRunIds);
			return;
		}

		if (accumulated && accumulated.length > 0) {
			if (policy === "rollup") {
				const rollupChildren = dedupeChildrenByRunIdKeepLatest(
					accumulated.map((child, index) => ({
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
						label: child.label,
					})),
				);
				const rollup: SubagentResult = {
					...result,
					total: result.total ?? rollupChildren.length,
					completed:
						result.completed ??
						rollupChildren.filter((child) => child.state === "complete" || child.success).length,
				};
				const key = buildCompletionKey(rollup, "notify");
				if (markSeenWithTtl(seen, key, now, ttlMs)) {
					logger.info("notify.handleComplete: DEDUPED", { id: idLabel, key });
					emitDelivered(coveredRunIds);
					return;
				}
				sendNotification(
					idLabel,
					batchNotificationContent(rollup, rollupChildren),
					batchNotificationDetails(rollup, rollupChildren),
				);
			}
			emitDelivered(coveredRunIds);
			return;
		}

		// Back-compat: older emitters and single paths only send the group
		// completion event with children[]. Preserve the previous behavior when no
		// time-separated per-run events were accumulated for this group.
		if (children && policy === "each") {
			notifyChildren(result, children, now);
			emitDelivered([groupRunId]);
			return;
		}

		const key = buildCompletionKey(result, "notify");
		if (markSeenWithTtl(seen, key, now, ttlMs)) {
			logger.info("notify.handleComplete: DEDUPED", { id: idLabel, key });
			emitDelivered(coveredRunIds);
			return;
		}

		const rollupChildren = children && policy === "rollup" ? dedupeChildrenByRunIdKeepLatest(children) : undefined;
		const content = rollupChildren
			? batchNotificationContent(result, rollupChildren)
			: singleNotificationContent(result);
		sendNotification(
			idLabel,
			content,
			rollupChildren ? batchNotificationDetails(result, rollupChildren) : undefined,
		);
		emitDelivered(coveredRunIds);
	};

	// Subscribe on this session's pi.events bus. The subscription is re-attached
	// on every host activate (the unsubscribeStoreKey block tears down the
	// previous one above), so host listeners stay bound to the latest live bus.
	// Child sessions subscribe on their own ephemeral bus and let their bus
	// disposal clean up the listener; they must not write the host's slot.
	logger.info("registerSubagentNotify: subscribing to async-complete", { isChildSession });
	// Lifecycle listeners for the interrupt-drop safety net. pi.on handlers are
	// bound to this activation's ExtensionRunner and die with it on reload, so
	// no manual teardown slot is needed (unlike the pi.events bus below).
	pi.on("agent_start", () => {
		agentStreaming = true;
	});
	pi.on("message_end", (event) => {
		const message = (event as { message?: { role?: string; customType?: string; content?: unknown } }).message;
		if (message?.role !== "custom" || message.customType !== "subagent-notify") return;
		const index = unconfirmedSends.findIndex((entry) => entry.content === message.content);
		if (index >= 0) unconfirmedSends.splice(index, 1);
	});
	pi.on("agent_end", (event) => {
		agentStreaming = false;
		const messages = (event as { messages?: Array<{ stopReason?: string }> }).messages;
		const aborted = Array.isArray(messages) && messages.some((message) => message?.stopReason === "aborted");
		// Non-aborted ends keep unconfirmed entries: their steered messages are
		// still queued and get consumed at the start of the next prompt.
		if (!aborted || unconfirmedSends.length === 0) return;
		const resend = unconfirmedSends.splice(0, unconfirmedSends.length);
		for (const entry of resend) {
			try {
				logger.info("notify: resending interrupt-dropped notification as nextTurn", { id: entry.idLabel });
				notificationPi().sendMessage(
					{
						customType: "subagent-notify",
						content: entry.content,
						display: true,
						...(entry.details ? { details: entry.details } : {}),
					},
					{ deliverAs: "nextTurn" },
				);
			} catch (err) {
				logger.error("notify: nextTurn resend threw", err instanceof Error ? err : new Error(String(err)), {
					id: entry.idLabel,
				});
			}
		}
	});
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
