import type { TokenUsage } from "../protocol/types.ts";

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
	return (
		tokenField(usage.input) + tokenField(usage.output) + tokenField(usage.cacheRead) + tokenField(usage.cacheWrite)
	);
}

/**
 * Build a persisted TokenUsage from a pre-summed display total (AgentProgress.tokens).
 * The foreground sync path only carries the rolled-up number on live progress, not the
 * per-bucket breakdown; the renderer reads only `.total`, so input/output stay 0 here.
 */
export function tokenUsageFromTotal(total: number | undefined): TokenUsage | undefined {
	const value = tokenField(total);
	return value > 0 ? { input: 0, output: 0, total: value } : undefined;
}

export function sumTokenUsages(...usages: Array<TokenUsage | undefined>): TokenUsage | undefined {
	const input = usages.reduce((sum, usage) => sum + tokenField(usage?.input), 0);
	const output = usages.reduce((sum, usage) => sum + tokenField(usage?.output), 0);
	const cacheRead = usages.reduce((sum, usage) => sum + tokenField(usage?.cacheRead), 0);
	const cacheWrite = usages.reduce((sum, usage) => sum + tokenField(usage?.cacheWrite), 0);
	const total = usages.reduce((sum, usage) => sum + tokenField(usage?.total), 0);
	return total > 0
		? {
				input,
				output,
				...(cacheRead > 0 ? { cacheRead } : {}),
				...(cacheWrite > 0 ? { cacheWrite } : {}),
				total,
			}
		: undefined;
}

/** Build the persisted TokenUsage shape from a richer Usage aggregate. */
export function tokenUsageFromUsage(usage: UsageTokenFields | undefined): TokenUsage | undefined {
	const input = tokenField(usage?.input);
	const output = tokenField(usage?.output);
	const cacheRead = tokenField(usage?.cacheRead);
	const cacheWrite = tokenField(usage?.cacheWrite);
	const total = input + output + cacheRead + cacheWrite;
	return total > 0
		? {
				input,
				output,
				...(cacheRead > 0 ? { cacheRead } : {}),
				...(cacheWrite > 0 ? { cacheWrite } : {}),
				total,
			}
		: undefined;
}
