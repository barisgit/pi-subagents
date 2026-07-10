import type { ActivityState, ControlConfig, ControlEvent, ResolvedControlConfig } from "../protocol/types.ts";
import {
	CONTROL_EVENT_TYPES,
	CONTROL_NOTIFICATION_CHANNELS,
	DEFAULT_CONTROL_CONFIG,
	deriveActivityState,
} from "../shared/control-policy.ts";

export {
	DEFAULT_CONTROL_CONFIG,
	DEFAULT_NEEDS_ATTENTION_AFTER_MS,
	deriveActivityState,
} from "../shared/control-policy.ts";

function parsePositiveInt(value: unknown): number | undefined {
	if (typeof value !== "number") return undefined;
	if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) return undefined;
	return value;
}

function parseControlList<T extends string>(value: unknown, allowed: readonly T[]): T[] | undefined {
	if (!Array.isArray(value)) return undefined;
	if (value.length === 0) return [];
	const allowedSet = new Set(allowed);
	const parsed = value.filter((entry): entry is T => typeof entry === "string" && allowedSet.has(entry as T));
	return parsed.length > 0 ? Array.from(new Set(parsed)) : undefined;
}

export function resolveControlConfig(globalConfig?: ControlConfig, override?: ControlConfig): ResolvedControlConfig {
	const enabled = override?.enabled ?? globalConfig?.enabled ?? DEFAULT_CONTROL_CONFIG.enabled;
	const needsAttentionAfterMs =
		parsePositiveInt(override?.needsAttentionAfterMs) ??
		parsePositiveInt(globalConfig?.needsAttentionAfterMs) ??
		DEFAULT_CONTROL_CONFIG.needsAttentionAfterMs;
	const notifyOn =
		parseControlList(override?.notifyOn, CONTROL_EVENT_TYPES) ??
		parseControlList(globalConfig?.notifyOn, CONTROL_EVENT_TYPES) ??
		DEFAULT_CONTROL_CONFIG.notifyOn;
	const notifyChannels =
		parseControlList(override?.notifyChannels, CONTROL_NOTIFICATION_CHANNELS) ??
		parseControlList(globalConfig?.notifyChannels, CONTROL_NOTIFICATION_CHANNELS) ??
		DEFAULT_CONTROL_CONFIG.notifyChannels;
	return {
		enabled,
		needsAttentionAfterMs,
		notifyOn: [...notifyOn],
		notifyChannels: [...notifyChannels],
	};
}

export function shouldEmitControlEvent(
	config: ResolvedControlConfig,
	from: ActivityState | undefined,
	to: ActivityState | undefined,
): boolean {
	return config.enabled && from !== to && to === "needs_attention";
}

export interface ActivityTickerOptions {
	runId: string;
	agent: string;
	index?: number;
	config: ResolvedControlConfig;
	getStartedAt: () => number;
	getLastActivityAt: () => number | undefined;
	/** Execution-start instant (queued->running flip); anchors the stall window past queue-wait. */
	getExecutionStartedAt?: () => number | undefined;
	/** True while the run is dispatched but blocked on a leaf permit; suppresses stall checks. */
	getQueued?: () => boolean;
	getPhase?: () => string | undefined;
	onNeedsAttention?: (event: ControlEvent) => void;
	now?: () => number;
}

export interface ActivityTickerHandle {
	tick: () => ActivityState | undefined;
	stop: () => void;
}

/**
 * Edge detector for foreground/async activity checks.
 *
 * The caller owns the actual clock tick (foreground status updates or async
 * poll loop). This helper only derives the current activity state and emits on
 * the rising edge into needs_attention, so it does not add its own interval.
 */
export function createActivityTicker(options: ActivityTickerOptions): ActivityTickerHandle {
	let lastActivityState: ActivityState | undefined;
	let stopped = false;
	const now = options.now ?? (() => Date.now());

	return {
		tick() {
			if (stopped) return lastActivityState;
			const ts = now();
			const startedAt = options.getStartedAt();
			const lastActivityAt = options.getLastActivityAt();
			const executionStartedAt = options.getExecutionStartedAt?.();
			const current = deriveActivityState({
				config: options.config,
				startedAt,
				lastActivityAt,
				executionStartedAt,
				queued: options.getQueued?.(),
				phase: options.getPhase?.(),
				now: ts,
			});
			if (shouldEmitControlEvent(options.config, lastActivityState, current) && current) {
				const event = buildControlEvent({
					from: lastActivityState,
					to: current,
					runId: options.runId,
					agent: options.agent,
					index: options.index,
					ts,
					lastActivityAt,
					activityAt: lastActivityAt ?? executionStartedAt ?? startedAt,
				});
				lastActivityState = current;
				try {
					options.onNeedsAttention?.(event);
				} catch {
					// Control notifications must never crash or stop the child run.
				}
				return current;
			}
			lastActivityState = current;
			return current;
		},
		stop() {
			stopped = true;
			lastActivityState = undefined;
		},
	};
}

export function buildControlEvent(input: {
	from?: ActivityState;
	to: ActivityState;
	runId: string;
	agent: string;
	index?: number;
	ts?: number;
	lastActivityAt?: number;
	activityAt?: number;
}): ControlEvent {
	const ts = input.ts ?? Date.now();
	const elapsedMs = input.lastActivityAt !== undefined ? Math.max(0, ts - input.lastActivityAt) : undefined;
	const elapsedSeconds = elapsedMs !== undefined ? Math.floor(elapsedMs / 1000) : undefined;
	const message =
		elapsedSeconds !== undefined
			? `${input.agent} needs attention (no observed activity for ${elapsedSeconds}s)`
			: `${input.agent} needs attention`;
	return {
		type: "needs_attention",
		from: input.from,
		to: input.to,
		ts,
		activityAt: input.activityAt ?? input.lastActivityAt,
		runId: input.runId,
		agent: input.agent,
		index: input.index,
		message,
	};
}

export function shouldNotifyControlEvent(config: ResolvedControlConfig, event: ControlEvent): boolean {
	return config.enabled && config.notifyOn.includes(event.type);
}

/**
 * Suppress activity-stall events once a run has effectively finished.
 *
 * The activity-stall heuristic only updates `lastActivityAt` on parsed structured
 * events from the child. During a long final assistant message (no tool calls)
 * the child can be silent for >60s while still streaming tokens. Without this
 * gate, the timer fires `needs_attention` after the run has completed, which
 * surfaces a stale notice in the parent.
 */
export function isControlEventAllowed(input: { runFinalized: boolean }): boolean {
	return !input.runFinalized;
}

export interface ControlNotificationDedupeStore {
	version: 1;
	byRunId: Map<string, Map<string, number>>;
	legacyKeys: Set<string>;
}

function isControlNotificationDedupeStore(value: unknown): value is ControlNotificationDedupeStore {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<ControlNotificationDedupeStore>;
	if (candidate.version !== 1 || !(candidate.byRunId instanceof Map) || !(candidate.legacyKeys instanceof Set)) {
		return false;
	}
	for (const [runId, scopes] of candidate.byRunId) {
		if (typeof runId !== "string" || !(scopes instanceof Map)) return false;
		for (const [scope, activityAt] of scopes) {
			if (typeof scope !== "string" || typeof activityAt !== "number") return false;
		}
	}
	for (const key of candidate.legacyKeys) {
		if (typeof key !== "string") return false;
	}
	return true;
}

export function createControlNotificationDedupeStore(existing?: unknown): ControlNotificationDedupeStore {
	if (isControlNotificationDedupeStore(existing)) return existing;
	const legacyKeys = new Set<string>();
	if (existing instanceof Set) {
		for (const key of existing) {
			if (typeof key === "string") legacyKeys.add(key);
		}
	}
	return { version: 1, byRunId: new Map(), legacyKeys };
}

function controlNotificationScopeKey(event: ControlEvent, childIntercomTarget?: string): string {
	return JSON.stringify([event.index ?? null, childIntercomTarget ?? null, event.type]);
}

function consumeLegacyControlNotification(
	store: ControlNotificationDedupeStore,
	event: ControlEvent,
	childIntercomTarget?: string,
): number | undefined {
	const childKey = childIntercomTarget ?? (event.index !== undefined ? `${event.runId}:${event.index}` : event.runId);
	const legacyBase = `${childKey}:${event.type}`;
	const transitionAt = event.activityAt ?? event.ts;
	let matched = false;
	let untimestamped = false;
	let latestEventAt: number | undefined;
	for (const key of store.legacyKeys) {
		if (key === legacyBase) {
			matched = true;
			untimestamped = true;
			store.legacyKeys.delete(key);
			continue;
		}
		if (!key.startsWith(`${legacyBase}:`)) continue;
		matched = true;
		const eventAt = Number(key.slice(legacyBase.length + 1));
		if (Number.isFinite(eventAt)) latestEventAt = Math.max(latestEventAt ?? eventAt, eventAt);
		store.legacyKeys.delete(key);
	}
	if (!matched) return undefined;
	if (untimestamped || latestEventAt === undefined || event.activityAt === undefined) {
		return Math.max(latestEventAt ?? transitionAt, transitionAt);
	}
	return event.activityAt <= latestEventAt ? latestEventAt : undefined;
}

export function controlNotificationKey(event: ControlEvent, childIntercomTarget?: string): string {
	const childKey = childIntercomTarget ?? (event.index !== undefined ? `${event.runId}:${event.index}` : event.runId);
	return `${childKey}:${event.type}`;
}

export function claimControlNotificationKey(
	event: ControlEvent,
	store: ControlNotificationDedupeStore,
	childIntercomTarget?: string,
): boolean {
	const scope = controlNotificationScopeKey(event, childIntercomTarget);
	const transitionAt = event.activityAt ?? event.ts;
	const runScopes = store.byRunId.get(event.runId) ?? new Map<string, number>();
	const previousTransitionAt = runScopes.get(scope);
	if (previousTransitionAt !== undefined && transitionAt <= previousTransitionAt) return false;
	const legacyTransitionAt = consumeLegacyControlNotification(store, event, childIntercomTarget);
	runScopes.set(scope, legacyTransitionAt ?? transitionAt);
	store.byRunId.set(event.runId, runScopes);
	return legacyTransitionAt === undefined;
}

export function evictControlNotificationsForRunId(
	store: ControlNotificationDedupeStore,
	runId: string,
	additionalLegacyChildKeys: readonly string[] = [],
): void {
	store.byRunId.delete(runId);
	const additionalLegacyBases = additionalLegacyChildKeys.map((childKey) => `${childKey}:needs_attention`);
	for (const key of store.legacyKeys) {
		if (
			(key.startsWith(`${runId}:`) && key.includes(":needs_attention")) ||
			additionalLegacyBases.some((base) => key === base || key.startsWith(`${base}:`))
		) {
			store.legacyKeys.delete(key);
		}
	}
}

export function claimControlNotification(
	config: ResolvedControlConfig,
	event: ControlEvent,
	seenKeys: Set<string>,
	childIntercomTarget?: string,
): boolean {
	if (!shouldNotifyControlEvent(config, event)) return false;
	const key = controlNotificationKey(event, childIntercomTarget);
	if (seenKeys.has(key)) return false;
	seenKeys.add(key);
	return true;
}

export function formatControlInterruptReason(event: ControlEvent): string {
	return `needs_attention auto-interrupt: ${event.message}`;
}

export function formatControlNoticeMessage(event: ControlEvent, childIntercomTarget?: string): string {
	const runTarget = event.runId;
	const nudgeCommand = childIntercomTarget
		? `intercom({ action: "send", to: "${childIntercomTarget}", message: "What are you blocked on? Reply with the smallest next step or ask for a decision." })`
		: undefined;
	return [
		`Subagent needs attention: ${event.agent}`,
		`Run: ${runTarget}${event.index !== undefined ? ` step ${event.index + 1}` : ""}`,
		`Signal: ${event.message}`,
		"Hint: Inspect status first unless the run is clearly blocked.",
		childIntercomTarget ? `Nudge: ${nudgeCommand}` : "Nudge: no child message route registered",
		`Status: subagent({ action: "status", id: "${runTarget}" })`,
		`Interrupt: subagent({ action: "interrupt", id: "${runTarget}" })`,
	].join("\n");
}

export function formatControlIntercomMessage(event: ControlEvent, childIntercomTarget?: string): string {
	return [
		"subagent needs attention",
		"",
		`${event.agent} needs attention in run ${event.runId}.`,
		"",
		formatControlNoticeMessage(event, childIntercomTarget),
	].join("\n");
}
