import { type ConcurrencyPermit, ConcurrencySemaphore } from "./concurrency-semaphore.ts";
import { __resetProcessGlobalForTest, processGlobal } from "../shared/process-global.ts";

/**
 * Per-process bound on concurrently executing LEAF agents.
 *
 * Every child agent — sync single, sync parallel, async single, async parallel,
 * and workflow agent()/parallel() — funnels through `startChildAgent`, which
 * acquires one permit here before its leaf session prompts and releases it when
 * the session settles. This is the process-global active-session limit. Each
 * workflow also uses the same configured value to bound direct children before
 * their run records are created.
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
	/** Active permits keyed by the holder's runId, so a nested dispatch can find
	 * its ancestor's permit to park it while awaiting descendants. */
	permitsByRunId: Map<string, ConcurrencyPermit>;
}

const REGISTRY_KEY = "pi.subagents.leafConcurrency";

/** Clamp to a positive integer; fall back to the default when absent/invalid. */
function normalizeMaxPermits(value: number | undefined, fallback: number): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1) return fallback;
	return value;
}

/**
 * Read the process-wide registry, creating it at the default size if it does not
 * yet exist. Does NOT resize an existing pool — acquire/park must observe the
 * capacity that activation configured, never reset it. The pool is keyed on
 * globalThis so it survives reloads and is shared across child module instances.
 */
function getRegistry(): LeafConcurrencyRegistry {
	return processGlobal<LeafConcurrencyRegistry>(REGISTRY_KEY, () => ({
		semaphore: new ConcurrencySemaphore(DEFAULT_MAX_CONCURRENT_AGENTS),
		permitsByRunId: new Map(),
	}));
}

/**
 * Create or RESIZE the pool to `maxPermits`. This is the only path that changes
 * capacity, so a changed `maxConcurrentAgents` takes effect on the next
 * activation without recreating the pool or revoking in-flight permits.
 */
function ensureRegistrySized(maxPermits: number): LeafConcurrencyRegistry {
	const reg = getRegistry();
	if (reg.semaphore.limit !== maxPermits) reg.semaphore.resize(maxPermits);
	return reg;
}

/** Default pool size when config does not set `maxConcurrentAgents`. */
export const DEFAULT_MAX_CONCURRENT_AGENTS = 4;

/**
 * Apply (and return) the per-process leaf-concurrency limit. Called at
 * activation with the configured value; resizes the live pool so reloads take
 * effect. Safe to call for display/diagnostics too.
 */
export function leafConcurrencyLimit(maxConcurrentAgents?: number): number {
	return ensureRegistrySized(normalizeMaxPermits(maxConcurrentAgents, DEFAULT_MAX_CONCURRENT_AGENTS)).semaphore.limit;
}

/**
 * Acquire a leaf permit for `runId`. Resolves when a slot is free (immediately
 * if under the limit). The returned release function frees the slot and clears
 * the run's permit entry; it is safe to call exactly once.
 */
export function acquireLeafPermit(runId: string): Promise<() => void>;
export function acquireLeafPermit(runId: string, signal: AbortSignal): Promise<(() => void) | undefined>;
export async function acquireLeafPermit(runId: string, signal?: AbortSignal): Promise<(() => void) | undefined> {
	const reg = getRegistry();
	const permit = signal ? await reg.semaphore.acquire(signal) : await reg.semaphore.acquire();
	if (!permit) return undefined;
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
	signal?: AbortSignal,
): Promise<T> {
	if (!parentRunId) return await fn();
	const reg = getRegistry();
	const permit = reg.permitsByRunId.get(parentRunId);
	if (!permit) return await fn();
	return await permit.runWhileParked(fn, signal);
}

/** Test-only: clear the process registry so each test starts from a fresh pool. */
export function __resetLeafConcurrencyForTest(): void {
	__resetProcessGlobalForTest(REGISTRY_KEY);
}
