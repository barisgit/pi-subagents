import { type ConcurrencyPermit, ConcurrencySemaphore } from "./concurrency-semaphore.ts";

/**
 * Per-process bound on concurrently executing LEAF agents.
 *
 * Every child agent — sync single, sync parallel, async single, async parallel,
 * and workflow agent()/parallel() — funnels through `startChildAgent`, which
 * acquires one permit here before its leaf session prompts and releases it when
 * the session settles. That makes this the single concurrency limit for the
 * whole runtime; there are no per-invocation or per-batch knobs.
 *
 * "Leaf" semantics: a permit represents an agent actively prompting. A parent
 * that dispatches its own children RELEASES its permit while awaiting them
 * (parkLeafPermit -> ConcurrencyPermit.runWhileParked) and re-acquires before
 * resuming. Because every permit holder is a leaf that finishes without waiting
 * on another permit, the pool cannot deadlock no matter how deep/wide the tree.
 *
 * State lives on globalThis under a Symbol.for key, NOT in module scope: each
 * in-process child session loads a FRESH module instance of this extension, and
 * the host reloads across activations. A module-level singleton would be
 * per-instance (one pool per subtree) and would not bound the process. The
 * Symbol.for registry is shared by every module instance, so one pool governs
 * all of them. This mirrors the workflow unhandled-rejection registry pattern.
 */

interface LeafConcurrencyRegistry {
	semaphore: ConcurrencySemaphore;
	maxPermits: number;
	/** Active permits keyed by the holder's runId, so a nested dispatch can find
	 * its ancestor's permit to park it while awaiting descendants. */
	permitsByRunId: Map<string, ConcurrencyPermit>;
}

const REGISTRY_KEY = Symbol.for("pi.subagents.leafConcurrency");

/** Clamp to a positive integer; fall back to the default when absent/invalid. */
function normalizeMaxPermits(value: number | undefined, fallback: number): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1) return fallback;
	return value;
}

/**
 * Resolve the process-wide registry, creating it on first use. The first caller
 * sizes the pool from `maxPermits`; later calls do NOT resize it (the pool is a
 * process resource, and reloads/child runtimes must not silently change a live
 * bound). Sizing is therefore first-win for the process lifetime.
 */
function registry(maxPermits: number): LeafConcurrencyRegistry {
	const globals = globalThis as unknown as Record<symbol, LeafConcurrencyRegistry | undefined>;
	let reg = globals[REGISTRY_KEY];
	if (!reg) {
		reg = {
			semaphore: new ConcurrencySemaphore(maxPermits),
			maxPermits,
			permitsByRunId: new Map(),
		};
		globals[REGISTRY_KEY] = reg;
	}
	return reg;
}

/** Default pool size when config does not set `maxConcurrentAgents`. */
export const DEFAULT_MAX_CONCURRENT_AGENTS = 4;

/** The resolved per-process limit (for display/diagnostics). */
export function leafConcurrencyLimit(maxConcurrentAgents?: number): number {
	const fallback = DEFAULT_MAX_CONCURRENT_AGENTS;
	return registry(normalizeMaxPermits(maxConcurrentAgents, fallback)).maxPermits;
}

/**
 * Acquire a leaf permit for `runId`. Resolves when a slot is free (immediately
 * if under the limit). The returned release function frees the slot and clears
 * the run's permit entry; it is safe to call exactly once.
 */
export async function acquireLeafPermit(runId: string, maxConcurrentAgents?: number): Promise<() => void> {
	const reg = registry(normalizeMaxPermits(maxConcurrentAgents, DEFAULT_MAX_CONCURRENT_AGENTS));
	const permit = await reg.semaphore.acquire();
	reg.permitsByRunId.set(runId, permit);
	let released = false;
	return () => {
		if (released) return;
		released = true;
		reg.permitsByRunId.delete(runId);
		permit.release();
	};
}

/**
 * Run `fn` while the permit held by `parentRunId` is parked (released back to
 * the pool, then re-acquired before `fn`'s result is returned). Use this around
 * the span where a parent awaits its own descendants so the parent does not
 * occupy a leaf slot while blocked. If `parentRunId` holds no permit (e.g. a
 * top-level dispatch from the host), `fn` simply runs without parking.
 */
export async function parkLeafPermit<T>(
	parentRunId: string | undefined,
	fn: () => Promise<T> | T,
	maxConcurrentAgents?: number,
): Promise<T> {
	if (!parentRunId) return await fn();
	const reg = registry(normalizeMaxPermits(maxConcurrentAgents, DEFAULT_MAX_CONCURRENT_AGENTS));
	const permit = reg.permitsByRunId.get(parentRunId);
	if (!permit) return await fn();
	return await permit.runWhileParked(fn);
}

/** Test-only: clear the process registry so each test starts from a fresh pool. */
export function __resetLeafConcurrencyForTest(): void {
	const globals = globalThis as unknown as Record<symbol, LeafConcurrencyRegistry | undefined>;
	globals[REGISTRY_KEY] = undefined;
}
