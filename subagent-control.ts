import {
	type ActivityState,
	type ControlConfig,
	type ControlEvent,
	type ControlEventType,
	type ResolvedControlConfig,
} from "./types.ts";

export const DEFAULT_CONTROL_CONFIG: ResolvedControlConfig = {
	enabled: true,
	quietAfterMs: 15_000,
	stalledAfterMs: 60_000,
	parentMode: "transitions",
};

function parsePositiveInt(value: unknown): number | undefined {
	if (typeof value !== "number") return undefined;
	if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) return undefined;
	return value;
}

export function resolveControlConfig(
	globalConfig?: ControlConfig,
	override?: ControlConfig,
): ResolvedControlConfig {
	const enabled = override?.enabled ?? globalConfig?.enabled ?? DEFAULT_CONTROL_CONFIG.enabled;
	const quietAfterMs = parsePositiveInt(override?.quietAfterMs)
		?? parsePositiveInt(globalConfig?.quietAfterMs)
		?? DEFAULT_CONTROL_CONFIG.quietAfterMs;
	const stalledAfterRaw = parsePositiveInt(override?.stalledAfterMs)
		?? parsePositiveInt(globalConfig?.stalledAfterMs)
		?? DEFAULT_CONTROL_CONFIG.stalledAfterMs;
	const parentMode = override?.parentMode ?? globalConfig?.parentMode ?? DEFAULT_CONTROL_CONFIG.parentMode;
	const stalledAfterMs = Math.max(stalledAfterRaw, quietAfterMs + 1);
	return {
		enabled,
		quietAfterMs,
		stalledAfterMs,
		parentMode: parentMode === "verbose" ? "verbose" : "transitions",
	};
}

export function deriveActivityState(input: {
	config: ResolvedControlConfig;
	startedAt: number;
	lastActivityAt?: number;
	hasSeenActivity: boolean;
	paused: boolean;
	now?: number;
}): ActivityState | undefined {
	if (!input.config.enabled) return undefined;
	if (input.paused) return "paused";
	if (!input.hasSeenActivity) return "starting";
	const now = input.now ?? Date.now();
	const lastActivity = input.lastActivityAt ?? input.startedAt;
	const ageMs = Math.max(0, now - lastActivity);
	if (ageMs <= input.config.quietAfterMs) return "active";
	if (ageMs <= input.config.stalledAfterMs) return "quiet";
	return "stalled";
}

function controlEventType(from: ActivityState | undefined, to: ActivityState): ControlEventType {
	if (to === "stalled") return "stalled";
	if (to === "paused") return "paused";
	if (from === "stalled" && to !== "stalled") return "recovered";
	if (from === "paused" && to !== "paused") return "resumed";
	return "activity";
}

export function shouldEmitControlEvent(
	config: ResolvedControlConfig,
	from: ActivityState | undefined,
	to: ActivityState,
): boolean {
	if (!config.enabled || from === to) return false;
	if (config.parentMode === "verbose") return true;
	if (to === "stalled" || to === "paused") return true;
	if (from === "stalled" && to !== "stalled") return true;
	if (from === "paused" && to !== "paused") return true;
	return false;
}

export function buildControlEvent(input: {
	from: ActivityState | undefined;
	to: ActivityState;
	runId: string;
	agent: string;
	index?: number;
	ts?: number;
}): ControlEvent {
	const ts = input.ts ?? Date.now();
	const type = controlEventType(input.from, input.to);
	const message = input.from
		? `${input.agent} ${type} (${input.from} -> ${input.to})`
		: `${input.agent} ${type} (${input.to})`;
	return {
		type,
		from: input.from,
		to: input.to,
		ts,
		runId: input.runId,
		agent: input.agent,
		index: input.index,
		message,
	};
}
