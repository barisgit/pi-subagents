import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { SubagentsStatusComponent } from "../../src/surfaces/subagents-status.ts";
import { filterRunsToSessionTree } from "../../src/surfaces/dashboard-row-model.ts";
import type { LiveRun } from "../../src/surfaces/subagents-status.ts";
import type { AsyncRunSummary } from "../../src/state/async-status.ts";
import { appendRunEntry, setRegistryPathForTests, type RunsRegistryEntry } from "../../src/state/runs-registry.ts";

// Production provider logic (mirrors slash-commands.ts openSubagentsStatus):
// collect the run ids anchored by 'subagent_run' custom entries on the CURRENT
// branch (leaf->root). A /tree revert moves the leaf, so anchors below it drop.
function branchAnchorRunIdsOf(sm: SessionManager): Set<string> {
	const ids = new Set<string>();
	for (const entry of sm.getBranch()) {
		if (!entry || typeof entry !== "object") continue;
		const candidate = entry as { type?: string; customType?: string; data?: { runId?: unknown } };
		if (candidate.type !== "custom" || candidate.customType !== "subagent_run") continue;
		if (typeof candidate.data?.runId === "string") ids.add(candidate.data.runId);
	}
	return ids;
}

type StatusTui = ConstructorParameters<typeof SubagentsStatusComponent>[0];
type StatusTheme = ConstructorParameters<typeof SubagentsStatusComponent>[1];

const tmpRoots: string[] = [];

function tmpRegistry(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "overlay-tree-membership-"));
	tmpRoots.push(root);
	setRegistryPathForTests(path.join(root, "registry", "runs-index.jsonl"));
	return root;
}

function createTestTui(): StatusTui {
	return { requestRender: () => {}, terminal: { rows: 48 } } as StatusTui;
}

function createTestTheme(): StatusTheme {
	return { fg: (_t: string, text: string) => text, bg: (_t: string, text: string) => text } as StatusTheme;
}

function stripBorders(line: string): string {
	return line.replace(/^│/, "").replace(/│$/, "").trim();
}

interface AsyncSeed {
	id: string;
	agent: string;
	label: string;
	parentRunId?: string;
	startedAt: number;
}

// All seeded runs live in the SAME session shard (sess-host). Membership is
// decided purely by the branch anchor set, not by session tagging.
function asyncRun(seed: AsyncSeed): LiveRun {
	return {
		ownership: "foreign",
		run: {
			id: seed.id,
			asyncDir: `/tmp/${seed.id}`,
			mode: "single",
			state: "complete",
			startedAt: seed.startedAt,
			lastUpdate: seed.startedAt + 1,
			label: seed.label,
			rootSessionId: "sess-host",
			parentSessionId: "sess-host",
			steps: [{ index: 0, agent: seed.agent, status: "complete", startedAt: seed.startedAt }],
			...(seed.parentRunId ? { parentRunId: seed.parentRunId } : {}),
		} as unknown as AsyncRunSummary,
	};
}

// One anchored top-level run (`current-branch`) plus its nested child, and one
// run (`reverted-branch`) whose anchor was dropped by a /tree revert.
function twoBranches(): LiveRun[] {
	return [
		asyncRun({ id: "current-branch", agent: "fixer", label: "current branch run", startedAt: 100 }),
		asyncRun({
			id: "current-child",
			agent: "review",
			label: "current child",
			parentRunId: "current-branch",
			startedAt: 150,
		}),
		asyncRun({ id: "reverted-branch", agent: "qa", label: "reverted branch run", startedAt: 200 }),
	];
}

function appendCompleteRun(
	root: string,
	entry: Omit<RunsRegistryEntry, "runRecordDir" | "mode" | "source" | "cwd"> & {
		agentName: string;
		mode?: "single" | "parallel";
		cwd?: string;
	},
): void {
	const runRecordDir = path.join(root, "runs", entry.runId);
	fs.mkdirSync(runRecordDir, { recursive: true });
	fs.writeFileSync(
		path.join(runRecordDir, "status.json"),
		JSON.stringify({
			runId: entry.runId,
			mode: entry.mode ?? "single",
			state: "complete",
			startedAt: entry.startedAt,
			lastUpdate: entry.startedAt + 1,
			endedAt: entry.startedAt + 1,
			cwd: entry.cwd ?? root,
			currentStep: 0,
			...(entry.label ? { label: entry.label } : {}),
			...(entry.parentRunId ? { parentRunId: entry.parentRunId } : {}),
			steps: [
				{
					agent: entry.agentName,
					status: "complete",
					startedAt: entry.startedAt,
					endedAt: entry.startedAt + 1,
				},
			],
		}),
		"utf8",
	);
	appendRunEntry({
		runId: entry.runId,
		runRecordDir,
		mode: entry.mode ?? "single",
		source: "async",
		agentName: entry.agentName,
		...(entry.label ? { label: entry.label } : {}),
		...(entry.parentRunId ? { parentRunId: entry.parentRunId } : {}),
		...(entry.rootRunId ? { rootRunId: entry.rootRunId } : {}),
		...(entry.parentSessionId ? { parentSessionId: entry.parentSessionId } : {}),
		...(entry.rootSessionId ? { rootSessionId: entry.rootSessionId } : {}),
		cwd: entry.cwd ?? root,
		startedAt: entry.startedAt,
	});
}

function seedTwoBranches(root: string): void {
	appendCompleteRun(root, {
		runId: "current-branch",
		agentName: "fixer",
		label: "current branch run",
		rootRunId: "current-branch",
		parentSessionId: "sess-host",
		rootSessionId: "sess-host",
		startedAt: 100,
	});
	appendCompleteRun(root, {
		runId: "current-child",
		agentName: "review",
		label: "current child",
		parentRunId: "current-branch",
		rootRunId: "current-branch",
		parentSessionId: "sess-host",
		rootSessionId: "sess-host",
		startedAt: 150,
	});
	appendCompleteRun(root, {
		runId: "reverted-branch",
		agentName: "qa",
		label: "reverted branch run",
		rootRunId: "reverted-branch",
		parentSessionId: "sess-host",
		rootSessionId: "sess-host",
		startedAt: 200,
	});
}

afterEach(() => {
	setRegistryPathForTests(null);
	for (const root of tmpRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("overlay branch-aware membership (VAL-TREE-MEMBERSHIP)", () => {
	it("keeps only runs whose branch anchor is on the current branch, with descendants", () => {
		const scoped = filterRunsToSessionTree(twoBranches(), { sessionId: "sess-host" }, new Set(["current-branch"]));
		const ids = scoped.map((run) => run.run.id).sort();
		// Anchored top-level run + its descendant survive; the reverted run is gone.
		// The child is NOT itself anchored: descendants of an included root flow in.
		assert.deepEqual(ids, ["current-branch", "current-child"]);
	});

	it("drops every top-level run when no anchors are on the current branch", () => {
		const scoped = filterRunsToSessionTree(twoBranches(), { sessionId: "sess-host" }, new Set<string>());
		assert.deepEqual(scoped, []);
	});

	it("ignores anchors under showAllSessions (mutant F: filter applied in all-sessions view)", () => {
		const root = tmpRegistry();
		seedTwoBranches(root);
		const component = new SubagentsStatusComponent(createTestTui(), createTestTheme(), () => {}, {
			refreshMs: 1000,
			sessionId: "sess-host",
			sessionCwd: root,
			getBranchAnchorRunIds: () => new Set(["current-branch"]),
		});
		try {
			component.setShowAllSessions(true);
			const text = component.render(180).map(stripBorders).join("\n");
			// All-sessions view bypasses session/branch scoping entirely, so even the
			// reverted-branch run is visible.
			assert.match(text, /current branch run/);
			assert.match(text, /reverted branch run/);
		} finally {
			component.dispose();
		}
	});

	// Capstone: drive a REAL SessionManager through a /tree revert and feed its
	// live getBranch() into the overlay via the SAME provider logic production
	// uses. Proves the end-to-end membership path, not just a fabricated Set.
	it("hides a run after a real /tree revert drops its branch anchor", () => {
		const root = tmpRegistry();
		seedTwoBranches(root);
		const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "overlay-tree-session-"));
		tmpRoots.push(sessionDir);
		const sm = SessionManager.create(root, sessionDir);

		// Dispatch 1: anchor `current-branch`. Its entry id is the fork point we
		// will revert back to (it stays on the branch after the revert).
		const forkPoint = sm.appendCustomEntry("subagent_run", {
			runId: "current-branch",
			rootRunId: "current-branch",
			mode: "single",
			source: "async",
		});
		assert.ok(forkPoint, "need a leaf id to revert back to");

		// Dispatch 2 on the SAME branch: anchor `reverted-branch` (a later turn).
		sm.appendCustomEntry("subagent_run", {
			runId: "reverted-branch",
			rootRunId: "reverted-branch",
			mode: "single",
			source: "async",
		});

		// Before the revert, both anchors are on the branch.
		assert.deepEqual([...branchAnchorRunIdsOf(sm)].sort(), ["current-branch", "reverted-branch"]);

		// /tree revert: move the leaf back to the first dispatch.
		sm.branch(forkPoint);
		assert.deepEqual(
			[...branchAnchorRunIdsOf(sm)],
			["current-branch"],
			"reverted anchor must leave the current branch",
		);

		const component = new SubagentsStatusComponent(createTestTui(), createTestTheme(), () => {}, {
			refreshMs: 1000,
			sessionId: "sess-host",
			sessionCwd: root,
			// Live provider: re-reads the real session manager's current branch.
			getBranchAnchorRunIds: () => branchAnchorRunIdsOf(sm),
		});
		try {
			const text = component.render(180).map(stripBorders).join("\n");
			assert.match(text, /current branch run/, "run still on the branch must show");
			assert.doesNotMatch(text, /reverted branch run/, "run whose anchor was reverted away must be hidden");
		} finally {
			component.dispose();
		}
	});
});
