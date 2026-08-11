import { processGlobal } from "./process-global.ts";

export const RUNNER_STALE_GRACE_MS = 15_000;

interface StaleObservation {
	fingerprint: string;
	observedAt: number;
}

const OBSERVATIONS_KEY = "pi.subagents.runnerStaleObservations";
let nowForTest: (() => number) | undefined;

function observations(): Map<string, StaleObservation> {
	return processGlobal(OBSERVATIONS_KEY, () => new Map<string, StaleObservation>());
}

export function isWithinRunnerStaleGrace(input: {
	key: string | undefined;
	fingerprint: string;
	stale: boolean;
	currentRunner: boolean;
	now?: number;
}): boolean {
	if (!input.key || !input.currentRunner) return false;
	const entries = observations();
	if (!input.stale) {
		entries.delete(input.key);
		return false;
	}
	const now = input.now ?? nowForTest?.() ?? Date.now();
	const existing = entries.get(input.key);
	if (!existing || existing.fingerprint !== input.fingerprint) {
		entries.set(input.key, { fingerprint: input.fingerprint, observedAt: now });
		return true;
	}
	return now - existing.observedAt <= RUNNER_STALE_GRACE_MS;
}

export function __resetRunnerStaleGraceForTest(): void {
	observations().clear();
	nowForTest = undefined;
}

export function __setRunnerStaleGraceNowForTest(now: () => number): () => void {
	const previous = nowForTest;
	nowForTest = now;
	return () => {
		nowForTest = previous;
	};
}
