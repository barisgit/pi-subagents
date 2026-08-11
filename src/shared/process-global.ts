import { randomUUID } from "node:crypto";

/**
 * Process-wide state shared across extension module instances.
 *
 * The host reloads extensions by RE-IMPORTING their modules in the SAME Node
 * process (and each in-process child session loads a fresh module instance of
 * this extension). Module-scope state therefore does NOT survive a reload and
 * is NOT shared with child-session module instances — but `globalThis` is.
 * Any live coordination state that must outlive a reload or span module
 * instances (abort controllers, concurrency pools, listener registries,
 * process identity tokens) must live here, keyed by `Symbol.for` so every
 * instance resolves the same slot.
 *
 * This helper is the single home for that invariant and for the `globalThis`
 * cast it requires; call sites stay cast-free.
 */
export function processGlobal<T>(key: string, create: () => T): T {
	const globals = globalThis as unknown as Record<symbol, T | undefined>;
	const slot = Symbol.for(key);
	let value = globals[slot];
	if (value === undefined) {
		value = create();
		globals[slot] = value;
	}
	return value;
}

/** Per-process identity that survives extension reloads but not process restarts. */
export function currentRunnerToken(): string {
	return processGlobal("pi.subagents.runnerToken", () => randomUUID());
}

/**
 * Test-only: clear a process-global slot so each test starts fresh.
 */
export function __resetProcessGlobalForTest(key: string): void {
	const globals = globalThis as unknown as Record<symbol, unknown>;
	globals[Symbol.for(key)] = undefined;
}
