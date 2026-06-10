import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { clearLeafSummaryCacheForTests, readLeafSummaryCached } from "../../src/state/async-status.ts";

// VAL-TERMINAL-CACHE: the overlay's per-tick leaf builder caches IMMUTABLE
// terminal summaries (so a 1Hz reload reuses them instead of re-deriving every
// run every tick), while NEVER caching an ACTIVE run's summary (whose
// displayState is time-relative and must keep crossing the lost threshold even
// when a wedged runner's status.json mtime has frozen).
//
// The load-bearing observable is reference identity: on a cache hit
// readLeafSummaryCached returns the SAME object it stored (it skips
// statusToSummary entirely); a rebuild yields a deep-equal but distinct object.
// That distinguishes this leaf cache from the underlying readStatus parse-cache,
// which would still rebuild a fresh summary each call.

const tmpRoots: string[] = [];

function tmpRunDir(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "overlay-incremental-test-"));
	tmpRoots.push(root);
	const dir = path.join(root, "run");
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

function writeStatus(dir: string, status: Record<string, unknown>): void {
	fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify(status));
}

function terminalStatus(runId: string, startedAt: number): Record<string, unknown> {
	return {
		runId,
		mode: "single",
		state: "complete",
		startedAt,
		lastUpdate: startedAt,
		endedAt: startedAt,
		cwd: "/host/repo",
		currentStep: 0,
		steps: [{ agent: "fixer", status: "complete", startedAt, lastActivityAt: startedAt }],
		lastActivityAt: startedAt,
	};
}

beforeEach(() => clearLeafSummaryCacheForTests());

afterEach(() => {
	clearLeafSummaryCacheForTests();
	for (const root of tmpRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("overlay incremental leaf-summary cache", () => {
	// Mutant: make readLeafSummaryCached always rebuild (drop the cache lookup or
	// the CACHEABLE_TERMINAL_STATES store) -> the two reads return distinct
	// objects and this assertion fails.
	it("caches a terminal leaf summary by mtime+size and returns the same object on a hit", () => {
		const dir = tmpRunDir();
		writeStatus(dir, terminalStatus("done-1", 1000));

		const s1 = readLeafSummaryCached(dir);
		const s2 = readLeafSummaryCached(dir);

		assert.ok(s1, "expected a summary");
		assert.equal(s1.state, "complete");
		assert.equal(s1, s2, "terminal summary should be served from cache (same reference)");
	});

	// Mutant: cache active states too (remove the CACHEABLE_TERMINAL_STATES guard)
	// -> the running run is served from cache, the two reads share a reference,
	// and this assertion fails. That same mutant is what would freeze a wedged
	// runner as "working" past the 30s ceiling.
	it("never caches an active run, so a wedged runner still derives lost", () => {
		const dir = tmpRunDir();
		const now = Date.now();
		writeStatus(dir, {
			runId: "wedged-1",
			mode: "single",
			state: "running",
			startedAt: now - 60_000,
			lastUpdate: now - 31_000,
			// Heartbeat frozen 31s ago (> RUNNER_HARD_DEAD_MS=30000): a wedged runner
			// whose status.json stopped being written.
			runnerHeartbeatAt: now - 31_000,
			cwd: "/host/repo",
			currentStep: 0,
			steps: [{ agent: "fixer", status: "running", startedAt: now - 60_000, lastActivityAt: now - 31_000 }],
			lastActivityAt: now - 31_000,
		});

		const s1 = readLeafSummaryCached(dir);
		const s2 = readLeafSummaryCached(dir);

		assert.ok(s1 && s2, "expected summaries");
		assert.equal(s1.state, "running");
		assert.equal(s1.displayState, "lost", "wedged active run must derive lost live");
		assert.notEqual(s1, s2, "active run must be rebuilt every read, never cached");
	});

	// Mutant: drop "paused" from CACHEABLE_TERMINAL_STATES -> the paused run is
	// rebuilt every read, the two reads return distinct objects, and this fails.
	// paused is terminal-ish (recent bucket, frozen label); status.json is not
	// written while paused so caching is safe until a resume rewrites it.
	it("caches a paused leaf summary (terminal-ish) and returns the same object on a hit", () => {
		const dir = tmpRunDir();
		writeStatus(dir, {
			runId: "paused-1",
			mode: "single",
			state: "paused",
			startedAt: 1000,
			lastUpdate: 1000,
			cwd: "/host/repo",
			currentStep: 0,
			steps: [{ agent: "fixer", status: "running", startedAt: 1000, lastActivityAt: 1000 }],
			lastActivityAt: 1000,
		});

		const s1 = readLeafSummaryCached(dir);
		const s2 = readLeafSummaryCached(dir);

		assert.ok(s1, "expected a summary");
		assert.equal(s1.state, "paused");
		assert.equal(s1, s2, "paused summary should be served from cache (same reference)");
	});

	// Mutant: ignore mtime/size in the cache key (return any cached entry) -> the
	// post-rewrite read keeps the stale summary and this assertion fails.
	it("invalidates the terminal cache when status.json changes", () => {
		const dir = tmpRunDir();
		writeStatus(dir, terminalStatus("evolve-1", 1000));
		const s1 = readLeafSummaryCached(dir);
		assert.ok(s1);
		assert.equal(s1.state, "complete");

		// Rewrite to a failed terminal state with a later mtime + different size.
		const later = { ...terminalStatus("evolve-1", 2000), state: "failed", endedAt: 2000, extraPaddingField: "x".repeat(40) };
		writeStatus(dir, later);

		const s2 = readLeafSummaryCached(dir);
		assert.ok(s2);
		assert.equal(s2.state, "failed", "a changed status.json must invalidate the cache");
		assert.notEqual(s1, s2);
	});
});
