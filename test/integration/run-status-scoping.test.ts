// Regression: `subagent({ action: "status" })` with no id used to dump every
// entry in runs-index.jsonl across every project ever spawned — including
// thousands of long-dead test temp-dir runs whose status.json no longer
// exists, because readRunViewForEntry synthesizes a fake `queued` stub for
// them and they match the `queued/running/lost` filter.
//
// Two fixes covered here:
//   1. Orphan stubs (no status.json, entry older than ~1m) are dropped.
//   2. The no-id list is scoped to the current session/cwd and capped.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { inspectSubagentStatus } from "../../src/state/run-status.ts";
import { appendRunEntry, setRegistryPathForTests, type RunsRegistryEntry } from "../../src/state/runs-registry.ts";

const tmpRoots: string[] = [];

function tmpRegistry(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "run-status-scope-"));
	tmpRoots.push(root);
	setRegistryPathForTests(path.join(root, "runs-index.jsonl"));
	return root;
}

function writeStatus(
	runRecordDir: string,
	runId: string,
	state: "queued" | "running" | "lost" | "complete",
	startedAt: number,
	cwd?: string,
): void {
	fs.mkdirSync(runRecordDir, { recursive: true });
	const status: Record<string, unknown> = {
		runId,
		mode: "single",
		state,
		startedAt,
		lastUpdate: startedAt,
		currentStep: 0,
		steps: [{ agent: "fixer", status: state }],
	};
	if (cwd) status.cwd = cwd;
	fs.writeFileSync(path.join(runRecordDir, "status.json"), JSON.stringify(status));
}

function makeEntry(
	root: string,
	runId: string,
	opts: Partial<RunsRegistryEntry> & {
		withStatus?: { state: "queued" | "running" | "lost" | "complete" };
		cwd?: string;
		startedAt?: number;
	},
): void {
	const runRecordDir = path.join(root, "runs", runId);
	const startedAt = opts.startedAt ?? Date.now();
	if (opts.withStatus) writeStatus(runRecordDir, runId, opts.withStatus.state, startedAt, opts.cwd);
	const entry: RunsRegistryEntry = {
		runId,
		runRecordDir,
		mode: "single",
		source: "async",
		agentName: "fixer",
		cwd: opts.cwd ?? "/some/cwd",
		startedAt,
		...(opts.parentSessionId ? { parentSessionId: opts.parentSessionId } : {}),
		...(opts.rootSessionId ? { rootSessionId: opts.rootSessionId } : {}),
	};
	appendRunEntry(entry);
}

afterEach(() => {
	setRegistryPathForTests(null);
	for (const root of tmpRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("inspectSubagentStatus no-id list scoping", () => {
	it("drops orphan registry entries whose status.json is gone and which are older than the stub window", () => {
		const root = tmpRegistry();
		// Long-dead entry: no status.json, started a day ago. Used to render as a
		// fake `queued` row.
		makeEntry(root, "orphan-old", { startedAt: Date.now() - 86_400_000 });
		// Fresh entry: no status.json, just dispatched. Still legit to surface.
		makeEntry(root, "queued-fresh", { startedAt: Date.now() });
		// Real running entry.
		makeEntry(root, "running-1", { withStatus: { state: "running" }, startedAt: Date.now() });

		const result = inspectSubagentStatus({});
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		assert.doesNotMatch(text, /orphan-old/);
		assert.match(text, /queued-fresh/);
		assert.match(text, /running-1/);
	});

	it("scopes by sessionId via rootSessionId for the no-id list", () => {
		const root = tmpRegistry();
		const now = Date.now();
		makeEntry(root, "mine", { withStatus: { state: "running" }, rootSessionId: "sess-current", startedAt: now });
		makeEntry(root, "nested-mine", {
			withStatus: { state: "running" },
			parentSessionId: "sess-child",
			rootSessionId: "sess-current",
			startedAt: now,
		});
		makeEntry(root, "theirs", { withStatus: { state: "running" }, rootSessionId: "sess-other", startedAt: now });

		const result = inspectSubagentStatus({ sessionId: "sess-current" });
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		assert.match(text, /mine/);
		assert.match(text, /nested-mine/);
		assert.doesNotMatch(text, /theirs/);
	});

	it("falls back to sessionCwd when no sessionId is supplied", () => {
		const root = tmpRegistry();
		const now = Date.now();
		makeEntry(root, "here-1", { withStatus: { state: "running" }, cwd: "/scoped/proj", startedAt: now });
		makeEntry(root, "elsewhere-1", { withStatus: { state: "running" }, cwd: "/other/proj", startedAt: now });

		const result = inspectSubagentStatus({ sessionCwd: "/scoped/proj" });
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		assert.match(text, /here-1/);
		assert.doesNotMatch(text, /elsewhere-1/);
	});

	it("emits an empty/no-runs message instead of a wall when nothing matches", () => {
		const root = tmpRegistry();
		const now = Date.now();
		// Plenty of entries but none in this session.
		for (let i = 0; i < 50; i++) {
			makeEntry(root, `noise-${i}`, {
				withStatus: { state: "running" },
				rootSessionId: "sess-other",
				startedAt: now,
			});
		}
		const result = inspectSubagentStatus({ sessionId: "sess-current", sessionCwd: "/scoped/proj" });
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		assert.match(text, /No subagent runs\./);
		assert.doesNotMatch(text, /noise-/);
	});
});

describe("inspectSubagentStatus ID lookup", () => {
	it("prefers an exact ID over a newer prefix match", () => {
		const root = tmpRegistry();
		const now = Date.now();
		makeEntry(root, "lookup-exact", { withStatus: { state: "complete" }, startedAt: now });
		makeEntry(root, "lookup-exact-longer", { withStatus: { state: "complete" }, startedAt: now + 1 });

		const result = inspectSubagentStatus({ id: "lookup-exact" });
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		assert.equal(result.isError, undefined);
		assert.match(text, /^Run: lookup-exact$/m);
	});

	it("rejects an ambiguous ID prefix", () => {
		const root = tmpRegistry();
		const now = Date.now();
		makeEntry(root, "lookup-shared-alpha", { withStatus: { state: "complete" }, startedAt: now });
		makeEntry(root, "lookup-shared-beta", { withStatus: { state: "complete" }, startedAt: now + 1 });

		const result = inspectSubagentStatus({ id: "lookup-shared" });
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		assert.equal(result.isError, true);
		assert.match(text, /ambiguous/i);
		assert.match(text, /lookup-shared-alpha/);
		assert.match(text, /lookup-shared-beta/);
	});

	it("deduplicates and caps ambiguous ID prefix matches", () => {
		const root = tmpRegistry();
		const now = Date.now();
		const runIds = Array.from({ length: 12 }, (_, index) => `lookup-many-${String(index).padStart(2, "0")}`);
		for (const [index, runId] of runIds.entries()) makeEntry(root, runId, { startedAt: now + index });
		makeEntry(root, runIds[0]!, { startedAt: now + runIds.length });

		const result = inspectSubagentStatus({ id: "lookup-many" });
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		assert.equal(result.isError, true);
		assert.equal(
			text,
			'Run ID prefix "lookup-many" is ambiguous (12 matches). Matches: lookup-many-00, lookup-many-01, lookup-many-02, lookup-many-03, lookup-many-04, lookup-many-05, lookup-many-06, lookup-many-07, lookup-many-08, lookup-many-09. 2 additional matches omitted. Provide a longer ID.',
		);
	});
});
