interface CompletionDataLike {
	id?: unknown;
	agent?: unknown;
	timestamp?: unknown;
	sessionId?: unknown;
	taskIndex?: unknown;
	totalTasks?: unknown;
	success?: unknown;
}

function asNonEmptyString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
	if (typeof value !== "number") return undefined;
	return Number.isFinite(value) ? value : undefined;
}

export function buildCompletionKey(data: CompletionDataLike, fallback: string): string {
	const id = asNonEmptyString(data.id);
	if (id) return `id:${id}`;
	const sessionId = asNonEmptyString(data.sessionId) ?? "no-session";
	const agent = asNonEmptyString(data.agent) ?? "unknown";
	const timestamp = asFiniteNumber(data.timestamp);
	const taskIndex = asFiniteNumber(data.taskIndex);
	const totalTasks = asFiniteNumber(data.totalTasks);
	const success = typeof data.success === "boolean" ? (data.success ? "1" : "0") : "?";
	return [
		"meta",
		sessionId,
		agent,
		timestamp !== undefined ? String(timestamp) : "no-ts",
		taskIndex !== undefined ? String(taskIndex) : "-",
		totalTasks !== undefined ? String(totalTasks) : "-",
		success,
		fallback,
	].join(":");
}

export function pruneSeenMap(seen: Map<string, number>, now: number, ttlMs: number): void {
	for (const [key, ts] of seen.entries()) {
		if (now - ts > ttlMs) seen.delete(key);
	}
}

export function markSeenWithTtl(seen: Map<string, number>, key: string, now: number, ttlMs: number): boolean {
	pruneSeenMap(seen, now, ttlMs);
	if (seen.has(key)) return true;
	seen.set(key, now);
	return false;
}

export function getGlobalSeenMap(storeKey: string): Map<string, number> {
	const globalStore = globalThis as Record<string, unknown>;
	const existing = globalStore[storeKey];
	if (existing instanceof Map) return existing as Map<string, number>;
	const map = new Map<string, number>();
	globalStore[storeKey] = map;
	return map;
}

/**
 * Pre-mark a run's completion notification as already delivered. The notify
 * handler then dedupes the eventual completion sendMessage but STILL emits the
 * notify-delivered event, so the async tracker clears pendingDelivery and
 * retires the widget row through the normal path. Callers that report a run's
 * final outcome inline (the synchronous interrupt wait) use this; on timeout
 * they must evict newly-marked keys again via evictCompletionDedupeForRunId so
 * the eventual notification is not lost. Returns true when the key was NOT
 * already present (i.e. this call created the mark), so timeout eviction never
 * un-dedupes a notification that was genuinely delivered earlier.
 */
export function markCompletionDedupeForRunId(runId: string, now = Date.now()): boolean {
	const seen = getGlobalSeenMap("__pi_subagents_notify_seen__");
	const key = `id:${runId}`;
	const newlyMarked = !seen.has(key);
	seen.set(key, now);
	return newlyMarked;
}

export function evictCompletionDedupeForRunId(runId: string): void {
	getGlobalSeenMap("__pi_subagents_notify_seen__").delete(`id:${runId}`);
}
