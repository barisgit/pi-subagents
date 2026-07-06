import type {
	ActivityState,
	ControlEventType,
	ControlNotificationChannel,
	ResolvedControlConfig,
} from "../protocol/types.ts";

export const CONTROL_EVENT_TYPES: ControlEventType[] = ["needs_attention"];
export const CONTROL_NOTIFICATION_CHANNELS: ControlNotificationChannel[] = ["event", "async", "intercom"];
export const DEFAULT_NOTIFY_ON: ControlEventType[] = ["needs_attention"];
export const ENGAGED_PHASES = new Set<string>([
	"waiting_model",
	"thinking",
	"streaming_text",
	"tool_running",
	"tool_streaming",
	"retrying",
]);
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
	executionStartedAt?: number;
	queued?: boolean;
	phase?: string;
	now?: number;
}): ActivityState | undefined {
	if (!input.config.enabled) return undefined;
	// A queued run is blocked on a leaf-concurrency permit and has produced no
	// activity yet. Its baseline would fall back to dispatch time, so the stall
	// timer would fire purely for waiting in the pool. Suppress entirely until it
	// actually begins executing (the queued->running flip stamps executionStartedAt).
	if (input.queued) return undefined;
	if (input.phase && ENGAGED_PHASES.has(input.phase)) return undefined;
	const now = input.now ?? Date.now();
	// Anchor the stall window on real execution start, not dispatch/queue time:
	// lastActivityAt when present, else executionStartedAt, else startedAt.
	const lastActivity = input.lastActivityAt ?? input.executionStartedAt ?? input.startedAt;
	const ageMs = Math.max(0, now - lastActivity);
	return ageMs > input.config.needsAttentionAfterMs ? "needs_attention" : undefined;
}
