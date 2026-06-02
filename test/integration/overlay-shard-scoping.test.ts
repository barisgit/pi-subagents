import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { listRunsFromRegistryForOverlay } from "../../async-status.ts";
import { appendRunEntry, setRegistryPathForTests, type RunsRegistryEntry } from "../../runs-registry.ts";

const tmpRoots: string[] = [];

function tmpRegistry(): { root: string; registryPath: string } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "overlay-shard-scope-test-"));
	tmpRoots.push(root);
	const registryPath = path.join(root, "registry", "runs-index.jsonl");
	setRegistryPathForTests(registryPath);
	return { root, registryPath };
}

function makeRun(root: string, runId: string, startedAt: number, state: "complete" | "running" = "complete"): RunsRegistryEntry {
	const runRecordDir = path.join(root, "runs", runId);
	fs.mkdirSync(runRecordDir, { recursive: true });
	fs.writeFileSync(
		path.join(runRecordDir, "status.json"),
		JSON.stringify({
			runId,
			mode: "single",
			state,
			startedAt,
			lastUpdate: startedAt,
			cwd: "/host/repo",
			currentStep: 0,
			steps: [{ agent: "fixer", status: state, startedAt, lastActivityAt: startedAt }],
			lastActivityAt: startedAt,
		}),
	);
	const entry: RunsRegistryEntry = {
		runId,
		runRecordDir,
		mode: "single",
		source: "async",
		agentName: "fixer",
		cwd: "/host/repo",
		startedAt,
		rootSessionId: "host",
	};
	appendRunEntry(entry);
	return entry;
}

afterEach(() => {
	setRegistryPathForTests(null);
	for (const root of tmpRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("overlay session shard scoping", () => {
	// Mutant note: making the overlay read the global registry instead of the shard
	// makes the corrupted-global case return empty; restoring the 200 slice truncates
	// the 205-run case.
	it("returns all terminal runs for a session when recentLimit is undefined", () => {
		const { root } = tmpRegistry();
		for (let i = 0; i < 205; i++) makeRun(root, `terminal-${i}`, i);
		makeRun(root, "active-a", 10_000, "running");
		makeRun(root, "active-b", 10_001, "running");

		const scoped = listRunsFromRegistryForOverlay(undefined, { sessionId: "host" });

		assert.equal(scoped.recent.length, 205);
		assert.equal(scoped.active.length, 2);
	});

	it("reads the session shard on the hot path when the global registry is corrupted", () => {
		const { root, registryPath } = tmpRegistry();
		for (let i = 0; i < 205; i++) makeRun(root, `terminal-${i}`, i);
		fs.writeFileSync(registryPath, "not-json\n", "utf8");

		const scoped = listRunsFromRegistryForOverlay(undefined, { sessionId: "host" });

		assert.equal(scoped.recent.length, 205);
	});
});
