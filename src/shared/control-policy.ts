import type { ActivityState, ControlEventType, ControlNotificationChannel, ResolvedControlConfig } from "../protocol/types.ts";

export const CONTROL_EVENT_TYPES: ControlEventType[] = ["needs_attention"];
export const CONTROL_NOTIFICATION_CHANNELS: ControlNotificationChannel[] = ["event", "async", "intercom"];
export const DEFAULT_NOTIFY_ON: ControlEventType[] = ["needs_attention"];
export const ENGAGED_PHASES = new Set<string>(["waiting_model", "thinking", "streaming_text", "retrying"]);
export const DEFAULT_NEEDS_ATTENTION_AFTER_MS = 15 * 60 * 1000;

export const DEFAULT_CONTROL_CONFIG: ResolvedControlConfig = {
	enabled: true,
	needsAttentionAfterMs: DEFAULT_NEEDS_ATTENTION_AFTER_MS,
	notifyOn: DEFAULT_NOTIFY_ON,
	notifyChannels: CONTROL_NOTIFICATION_CHANNELS,
};

export function deriveActivityState(input: {
	config: ResolvedControlConfig;
	startedAt: number;
	lastActivityAt?: number;
	phase?: string;
	now?: number;
}): ActivityState | undefined {
	if (!input.config.enabled) return undefined;
	if (input.phase && ENGAGED_PHASES.has(input.phase)) return undefined;
	const now = input.now ?? Date.now();
	const lastActivity = input.lastActivityAt ?? input.startedAt;
	const ageMs = Math.max(0, now - lastActivity);
	return ageMs > input.config.needsAttentionAfterMs ? "needs_attention" : undefined;
}
