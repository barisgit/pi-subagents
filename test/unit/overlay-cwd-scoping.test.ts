// Regression: listRunsFromRegistryForOverlay used to slice top-N globally before
// the cwd filter, so a scoped overlay (session bound to a specific cwd) could
// report "0 total" even when runs-index.jsonl had matching completed entries —
// because the top-N most-recent completed runs across every project drowned the
// current session's history out. The fix is to filter by sessionCwd BEFORE the
// recent-limit slice.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { listRunsFromRegistryForOverlay } from "../../src/state/async-status.ts";
import { appendRunEntry, setRegistryPathForTests, type RunsRegistryEntry } from "../../src/state/runs-registry.ts";

const tmpRoots: string[] = [];

function tmpRegistry(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "overlay-cwd-scope-test-"));
	tmpRoots.push(root);
	const registryPath = path.join(root, "registry", "runs-index.jsonl");
	setRegistryPathForTests(registryPath);
	return root;
}

function makeRun(
	root: string,
	runId: string,
	cwd: string,
	runState: "complete" | "running",
	startedAt: number,
	lineage: { parentSessionId?: string; rootSessionId?: string } = {},
): RunsRegistryEntry {
	const runRecordDir = path.join(root, "runs", runId);
	fs.mkdirSync(runRecordDir, { recursive: true });
	const statusJson = {
		runId,
		mode: "single",
		state: runState,
		startedAt,
		lastUpdate: startedAt,
		cwd,
		currentStep: 0,
		steps: [{ agent: "fixer", status: runState, startedAt, lastActivityAt: startedAt }],
		lastActivityAt: startedAt,
	};
	fs.writeFileSync(path.join(runRecordDir, "status.json"), JSON.stringify(statusJson));
	const entry: RunsRegistryEntry = {
		runId,
		runRecordDir,
		mode: "single",
		source: "async",
		agentName: "fixer",
		cwd,
		startedAt,
		...(lineage.parentSessionId ? { parentSessionId: lineage.parentSessionId } : {}),
		...(lineage.rootSessionId ? { rootSessionId: lineage.rootSessionId } : {}),
	};
	appendRunEntry(entry);
	return entry;
}

afterEach(() => {
	setRegistryPathForTests(null);
	for (const root of tmpRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("listRunsFromRegistryForOverlay sessionCwd scoping", () => {
	it("filters by sessionCwd BEFORE recent-limit slice (regression for empty scoped overlay)", () => {
		const root = tmpRegistry();
		// 20 newer completed runs in /other/proj that would otherwise saturate
		// the recent-limit slice.
		for (let i = 0; i < 20; i++) {
			makeRun(root, `other-${i}`, "/other/proj", "complete", 10_000 + i);
		}
		// 3 older completed runs in /scoped/proj — they would be evicted if the
		// slice happened globally before scoping.
		makeRun(root, "scoped-a", "/scoped/proj", "complete", 100);
		makeRun(root, "scoped-b", "/scoped/proj", "complete", 200);
		makeRun(root, "scoped-c", "/scoped/proj", "complete", 300);

		const scoped = listRunsFromRegistryForOverlay(20, { sessionCwd: "/scoped/proj" });
		assert.equal(scoped.recent.length, 3);
		assert.deepEqual(scoped.recent.map((r) => r.id).sort(), ["scoped-a", "scoped-b", "scoped-c"].sort());
		assert.equal(scoped.active.length, 0);
	});

	it("without sessionCwd, returns the top-N most recent across all cwds", () => {
		const root = tmpRegistry();
		for (let i = 0; i < 25; i++) {
			makeRun(root, `run-${i}`, i % 2 === 0 ? "/a" : "/b", "complete", i);
		}
		const all = listRunsFromRegistryForOverlay(5);
		assert.equal(all.recent.length, 5);
		// Newest by startedAt.
		assert.deepEqual(
			all.recent.map((r) => r.id),
			["run-24", "run-23", "run-22", "run-21", "run-20"],
		);
	});

	it("includes active runs (running) in scoped result; never sliced by recent-limit", () => {
		const root = tmpRegistry();
		makeRun(root, "live-1", "/scoped/proj", "running", 1);
		makeRun(root, "live-2", "/other/proj", "running", 2);
		makeRun(root, "done-1", "/scoped/proj", "complete", 3);

		const scoped = listRunsFromRegistryForOverlay(5, { sessionCwd: "/scoped/proj" });
		assert.equal(scoped.active.length, 1);
		assert.equal(scoped.active[0]!.id, "live-1");
		assert.equal(scoped.recent.length, 1);
		assert.equal(scoped.recent[0]!.id, "done-1");
	});

	it("scopes by sessionId via rootSessionId (catches nested subagent runs)", () => {
		const root = tmpRegistry();
		// Top-level run dispatched from the current session.
		makeRun(root, "top", "/scoped/proj", "complete", 100, {
			parentSessionId: "sess-current",
			rootSessionId: "sess-current",
		});
		// Nested run: dispatched FROM a child subagent (so parentSessionId is the
		// child's session id), but rootSessionId still points at the user session.
		makeRun(root, "nested", "/scoped/proj", "complete", 200, {
			parentSessionId: "sess-child-subagent",
			rootSessionId: "sess-current",
		});
		// Run from a totally different user session in the same project.
		makeRun(root, "other-session", "/scoped/proj", "complete", 300, {
			parentSessionId: "sess-other",
			rootSessionId: "sess-other",
		});

		const scoped = listRunsFromRegistryForOverlay(10, { sessionId: "sess-current" });
		assert.deepEqual(scoped.recent.map((r) => r.id).sort(), ["nested", "top"].sort());
	});

	it("falls back to parentSessionId when rootSessionId is missing (legacy entries)", () => {
		const root = tmpRegistry();
		makeRun(root, "legacy-match", "/scoped/proj", "complete", 100, {
			parentSessionId: "sess-current",
		});
		makeRun(root, "legacy-other", "/scoped/proj", "complete", 200, {
			parentSessionId: "sess-other",
		});

		const scoped = listRunsFromRegistryForOverlay(10, { sessionId: "sess-current" });
		assert.deepEqual(
			scoped.recent.map((r) => r.id),
			["legacy-match"],
		);
	});

	it("sessionId takes precedence over sessionCwd when both are passed", () => {
		const root = tmpRegistry();
		makeRun(root, "same-session-other-cwd", "/different/proj", "complete", 100, {
			rootSessionId: "sess-current",
		});
		makeRun(root, "same-cwd-other-session", "/scoped/proj", "complete", 200, {
			rootSessionId: "sess-other",
		});

		const scoped = listRunsFromRegistryForOverlay(10, {
			sessionId: "sess-current",
			sessionCwd: "/scoped/proj",
		});
		// sessionId wins: keep same-session entries regardless of cwd, exclude
		// other-session entries even when their cwd matches.
		assert.deepEqual(
			scoped.recent.map((r) => r.id),
			["same-session-other-cwd"],
		);
	});

	it("treats unknown cwd permissively (kept in scoped result)", () => {
		const root = tmpRegistry();
		// Legacy entry where the status.json has no cwd field.
		const runRecordDir = path.join(root, "runs", "legacy-1");
		fs.mkdirSync(runRecordDir, { recursive: true });
		fs.writeFileSync(
			path.join(runRecordDir, "status.json"),
			JSON.stringify({
				runId: "legacy-1",
				mode: "single",
				state: "complete",
				startedAt: 1,
				lastUpdate: 1,
				currentStep: 0,
				steps: [{ agent: "fixer", status: "complete", startedAt: 1, lastActivityAt: 1 }],
				lastActivityAt: 1,
			}),
		);
		appendRunEntry({
			runId: "legacy-1",
			runRecordDir,
			mode: "single",
			source: "async",
			agentName: "fixer",
			// Legacy entries can have empty cwd; the type requires the field, so we
			// pass an empty string. The summary derived from the (cwd-less) status
			// will then have cwd=undefined and exercise the permissive branch.
			cwd: "",
			startedAt: 1,
		});

		const scoped = listRunsFromRegistryForOverlay(5, { sessionCwd: "/scoped/proj" });
		// Permissive: keep entries with unknown cwd so legacy history doesn't vanish.
		assert.equal(scoped.recent.length, 1);
		assert.equal(scoped.recent[0]!.id, "legacy-1");
	});
});
