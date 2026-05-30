import type { TokenUsage } from "./types.ts";

export type UsageTokenFields = {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
};

function tokenField(value: number | undefined): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Display-token total used by subagent progress/status UI.
 *
 * Pi model usage exposes uncached input/output separately from prompt-cache reads
 * and writes. The compact "N token" stat is meant to answer "how many tokens did
 * this run move?", so it includes all four token buckets.
 */
export function totalUsageTokens(usage: UsageTokenFields | undefined): number {
	if (!usage) return 0;
	return tokenField(usage.input)
		+ tokenField(usage.output)
		+ tokenField(usage.cacheRead)
		+ tokenField(usage.cacheWrite);
}

/** Build the persisted TokenUsage shape from a richer Usage aggregate. */
export function tokenUsageFromUsage(usage: UsageTokenFields | undefined): TokenUsage | undefined {
	const input = tokenField(usage?.input);
	const output = tokenField(usage?.output);
	const cacheRead = tokenField(usage?.cacheRead);
	const cacheWrite = tokenField(usage?.cacheWrite);
	const total = input + output + cacheRead + cacheWrite;
	return total > 0 ? {
		input,
		output,
		...(cacheRead > 0 ? { cacheRead } : {}),
		...(cacheWrite > 0 ? { cacheWrite } : {}),
		total,
	} : undefined;
}
