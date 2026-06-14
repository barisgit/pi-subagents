import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { SubagentsStatusComponent } from "../../src/surfaces/subagents-status.ts";
import { countAgentRows, deriveDisplayRows, filterRunsToSessionTree } from "../../src/surfaces/dashboard-row-model.ts";
import type { LiveRun } from "../../src/surfaces/subagents-status.ts";
import type { AsyncRunSummary } from "../../src/state/async-status.ts";
import { appendRunEntry, setRegistryPathForTests, type RunsRegistryEntry } from "../../src/state/runs-registry.ts";

const tmpRoots: string[] = [];

interface AsyncSeed {
	id: string;
	agent: string;
	label?: string;
	mode?: "single" | "parallel";
	parentRunId?: string;
	rootSessionId?: string;
	parentSessionId?: string;
	cwd?: string;
	state?: AsyncRunSummary["state"];
	startedAt: number;
}

function asyncRun(seed: AsyncSeed): LiveRun {
	const state = seed.state ?? "complete";
	return {
		source: "async",
		run: {
			id: seed.id,
			asyncDir: `/tmp/${seed.id}`,
			mode: seed.mode ?? "single",
			state,
			startedAt: seed.startedAt,
			lastUpdate: seed.startedAt + 1,
			steps: [{ index: 0, agent: seed.agent, status: state, startedAt: seed.startedAt }],
			...(seed.label ? { label: seed.label } : {}),
			...(seed.parentRunId ? { parentRunId: seed.parentRunId } : {}),
			...(seed.rootSessionId ? { rootSessionId: seed.rootSessionId } : {}),
			...(seed.parentSessionId ? { parentSessionId: seed.parentSessionId } : {}),
			...(seed.cwd ? { cwd: seed.cwd } : {}),
		} as unknown as AsyncRunSummary,
	};
}

describe("dashboard tree rows", () => {
	it("session-scoped filter keeps nested descendants from the host session shard", () => {
		const runs: LiveRun[] = [
			asyncRun({ id: "parent-visible", agent: "fixer", label: "visible parent", rootSessionId: "sess-host", parentSessionId: "sess-host", startedAt: 100 }),
			// Child has stale lineage (parentSessionId sess-child) but its root session
			// is the host: it must still flow in as a descendant of the visible parent.
			asyncRun({ id: "child-stale-lineage", agent: "review", label: "stale child", parentRunId: "parent-visible", rootSessionId: "sess-host", parentSessionId: "sess-child", startedAt: 200 }),
			asyncRun({ id: "unrelated-other-session", agent: "qa", label: "other session", rootSessionId: "sess-other", parentSessionId: "sess-other", startedAt: 300 }),
		];

		const scoped = filterRunsToSessionTree(runs, { sessionId: "sess-host" });
		const ids = scoped.map((run) => run.run.id);
		assert.deepEqual(ids.sort(), ["child-stale-lineage", "parent-visible"]);

		const rows = deriveDisplayRows(scoped, new Set());
		const parentIndex = rows.findIndex((row) => row.kind === "run" && row.run.run.id === "parent-visible");
		const childIndex = rows.findIndex((row) => row.kind === "run" && row.run.run.id === "child-stale-lineage");
		assert.notEqual(parentIndex, -1);
		assert.equal(childIndex, parentIndex + 1, "descendant renders immediately after its parent");
		const childRow = rows[childIndex]!;
		assert.equal(childRow.kind === "run" && childRow.depth, 1, "descendant is rendered one level deep");
		assert.equal(countAgentRows(scoped), 2);
	});

	it("parallel dispatch flattens children to top-level rows and the container is not tallied", () => {
		const runs: LiveRun[] = [
			asyncRun({ id: "group-parallel", agent: "group", mode: "parallel", state: "running", label: "parallel group", startedAt: 1 }),
		];
		for (let i = 0; i < 20; i++) {
			runs.push(asyncRun({ id: `unrelated-${i}`, agent: "other", label: `unrelated ${i}`, startedAt: 10 + i }));
		}
		const agents = ["fixer", "review", "qa", "oracle"];
		agents.forEach((agent, index) => {
			runs.push(asyncRun({ id: `child-${agent}`, agent, label: `child ${agent}`, parentRunId: "group-parallel", startedAt: 100 + index }));
		});

		const rows = deriveDisplayRows(runs, new Set());

		// The parallel group CONTAINER is never emitted.
		assert.equal(rows.some((row) => row.kind === "run" && row.run.run.id === "group-parallel"), false);

		// Each child renders flat (depth 0) with the parallel batch marker.
		for (const agent of agents) {
			const row = rows.find((r) => r.kind === "run" && r.run.run.id === `child-${agent}`);
			assert.ok(row && row.kind === "run", `expected row for child ${agent}`);
			assert.equal(row.depth, 0);
			assert.equal(row.parallelMarker, true);
		}

		// The container is NOT an agent: 20 unrelated singles + 4 children = 24.
		assert.equal(countAgentRows(runs), 24);
	});

	it("d/u move the left-pane selection by a half-page", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-tree-rows-"));
		tmpRoots.push(root);
		setRegistryPathForTests(path.join(root, "registry", "runs-index.jsonl"));
		// More runs than one viewport page so a page jump is observable.
		for (let i = 0; i < 60; i++) {
			const runId = `run-${String(i).padStart(2, "0")}`;
			const runRecordDir = path.join(root, "runs", runId);
			fs.mkdirSync(runRecordDir, { recursive: true });
			const startedAt = 1000 - i; // descending so run-00 sorts first (newest)
			fs.writeFileSync(path.join(runRecordDir, "status.json"), JSON.stringify({
				runId,
				mode: "single",
				state: "complete",
				startedAt,
				lastUpdate: startedAt + 1,
				endedAt: startedAt + 1,
				cwd: root,
				currentStep: 0,
				label: `run ${String(i).padStart(2, "0")}`,
				steps: [{ agent: "fixer", status: "complete", startedAt, endedAt: startedAt + 1 }],
			}), "utf8");
			appendRunEntry({
				runId,
				runRecordDir,
				mode: "single",
				source: "async",
				agentName: "fixer",
				label: `run ${String(i).padStart(2, "0")}`,
				rootRunId: runId,
				cwd: root,
				startedAt,
			} as RunsRegistryEntry);
		}
		const component = new SubagentsStatusComponent(
			{ requestRender: () => {}, terminal: { rows: 48 } } as ConstructorParameters<typeof SubagentsStatusComponent>[0],
			{ fg: (_t: string, text: string) => text, bg: (_t: string, text: string) => text } as ConstructorParameters<typeof SubagentsStatusComponent>[1],
			() => {},
			{ refreshMs: 1000, sessionCwd: root },
		);
		try {
			// Establish lastLeftListHeight via a first render; selection starts at top.
			component.render(180);
			const counterIndex = (): number => {
				const m = component.render(180).join("\n").match(/(\d+)\/60/);
				return m ? Number(m[1]) : -1;
			};
			const start = counterIndex();
			assert.equal(start, 1, "selection should start at row 1");

			component.handleInput("d");
			const afterDown = counterIndex();
			assert.ok(afterDown > start + 1, `d should jump a half-page, got ${start} -> ${afterDown}`);

			component.handleInput("u");
			const afterUp = counterIndex();
			assert.equal(afterUp, start, `u should return to the top, got ${afterUp}`);
		} finally {
			component.dispose();
		}
	});
});

afterEach(() => {
	setRegistryPathForTests(null);
	for (const root of tmpRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
