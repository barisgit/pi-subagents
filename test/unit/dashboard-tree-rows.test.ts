import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { SubagentsStatusComponent } from "../../subagents-status.ts";
import { appendRunEntry, setRegistryPathForTests, type RunsRegistryEntry } from "../../runs-registry.ts";

type StatusTui = ConstructorParameters<typeof SubagentsStatusComponent>[0];
type StatusTheme = ConstructorParameters<typeof SubagentsStatusComponent>[1];

const tmpRoots: string[] = [];

function tmpRegistry(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-tree-rows-"));
	tmpRoots.push(root);
	setRegistryPathForTests(path.join(root, "registry", "runs-index.jsonl"));
	return root;
}

function createTestTui(requestRender: () => void): StatusTui {
	return { requestRender, terminal: { rows: 48 } } as StatusTui;
}

function createTestTheme(): StatusTheme {
	return {
		fg: (_token: string, text: string) => text,
		bg: (_token: string, text: string) => text,
	} as StatusTheme;
}

function stripBorders(line: string): string {
	return line.replace(/^│/, "").replace(/│$/, "").trim();
}

function appendCompleteRun(root: string, entry: Omit<RunsRegistryEntry, "runRecordDir" | "mode" | "source" | "cwd"> & { agentName: string; mode?: "single" | "chain" | "parallel"; cwd?: string }): void {
	const runRecordDir = path.join(root, "runs", entry.runId);
	fs.mkdirSync(runRecordDir, { recursive: true });
	fs.writeFileSync(path.join(runRecordDir, "status.json"), JSON.stringify({
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
		steps: [{ agent: entry.agentName, status: "complete", startedAt: entry.startedAt, endedAt: entry.startedAt + 1 }],
	}), "utf8");
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

afterEach(() => {
	setRegistryPathForTests(null);
	for (const root of tmpRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("dashboard tree rows", () => {
	it("session-scoped dashboard keeps nested descendants from the host session shard", () => {
		const root = tmpRegistry();
		appendCompleteRun(root, {
			runId: "parent-visible",
			agentName: "fixer",
			label: "visible parent",
			rootRunId: "parent-visible",
			parentSessionId: "sess-host",
			rootSessionId: "sess-host",
			startedAt: 100,
		});
		appendCompleteRun(root, {
			runId: "child-stale-lineage",
			agentName: "review",
			label: "stale child",
			parentRunId: "parent-visible",
			rootRunId: "parent-visible",
			parentSessionId: "sess-child",
			rootSessionId: "sess-host",
			startedAt: 200,
		});
		appendCompleteRun(root, {
			runId: "unrelated-other-session",
			agentName: "qa",
			label: "other session",
			rootRunId: "unrelated-other-session",
			parentSessionId: "sess-other",
			rootSessionId: "sess-other",
			startedAt: 300,
		});

		const component = new SubagentsStatusComponent(
			createTestTui(() => {}),
			createTestTheme(),
			() => {},
			{ refreshMs: 1000, sessionId: "sess-host", sessionCwd: root },
		);

		try {
			const rows = component.render(180).map(stripBorders);
			const parentIndex = rows.findIndex((line) => line.includes("fixer") && line.includes("visible parent"));
			const childIndex = rows.findIndex((line) => line.includes("review") && line.includes("stale child"));
			assert.notEqual(parentIndex, -1);
			assert.notEqual(childIndex, -1);
			assert.equal(childIndex, parentIndex + 1);
			assert.match(rows[childIndex]!, /└─/);
			assert.doesNotMatch(rows.join("\n"), /other session/);
			assert.match(rows.join("\n"), /Subagent runs · 2 total/);
		} finally {
			component.dispose();
		}
	});

	it("parallel dispatch renders N rows nested under their group node", () => {
		const root = tmpRegistry();
		const groupId = "group-parallel";
		const groupDir = path.join(root, "runs", groupId);
		fs.mkdirSync(groupDir, { recursive: true });
		appendRunEntry({
			runId: groupId,
			runRecordDir: groupDir,
			mode: "parallel",
			source: "sync",
			label: "parallel group",
			rootRunId: groupId,
			cwd: root,
			startedAt: 1,
		});

		for (let i = 0; i < 20; i++) {
			appendCompleteRun(root, {
				runId: `unrelated-${i}`,
				agentName: "other",
				label: `unrelated ${i}`,
				rootRunId: `unrelated-${i}`,
				startedAt: 10 + i,
			});
		}

		const agents = ["fixer", "review", "qa", "oracle"];
		agents.forEach((agent, index) => {
			appendCompleteRun(root, {
				runId: `child-${agent}`,
				agentName: agent,
				label: `child ${agent}`,
				parentRunId: groupId,
				rootRunId: groupId,
				startedAt: 100 + index,
			});
		});

		const component = new SubagentsStatusComponent(
			createTestTui(() => {}),
			createTestTheme(),
			() => {},
			{ refreshMs: 1000, sessionCwd: root },
		);

		try {
			const firstRender = component.render(180).map(stripBorders);
			const groupIndex = firstRender.findIndex((line) => line.includes("parallel group"));
			assert.notEqual(groupIndex, -1);
			for (let i = 0; i < groupIndex - 1; i++) component.handleInput("j");

			const rows = component.render(180).map(stripBorders);
			const selectedGroupIndex = rows.findIndex((line) => /▾ parallel .*parallel group/.test(line));
			assert.notEqual(selectedGroupIndex, -1);
			const visibleAgents = [...agents].reverse();
			const childIndexes = visibleAgents.map((agent) => rows.findIndex((line) => line.includes(`child ${agent}`)));
			childIndexes.forEach((index) => assert.notEqual(index, -1));
			assert.deepEqual(childIndexes, visibleAgents.map((_, index) => selectedGroupIndex + index + 1));
			for (const index of childIndexes) assert.match(rows[index]!, /└─/);

			const unrelatedIndex = rows.findIndex((line) => line.includes("unrelated 19"));
			assert.notEqual(unrelatedIndex, -1);
			assert.doesNotMatch(rows[unrelatedIndex]!, /└─/);
			assert.match(rows.join("\n"), /4 agents: oracle, qa, review, fixer/);
			// The parallel group is a CONTAINER, not an agent: its row must not be
			// tallied in the header when its 4 leaf children are present as their own
			// rows. 20 unrelated singles + 4 children = 24 agents (NOT 25 with the group).
			assert.match(rows.join("\n"), /Subagent runs · 24 total/);
		} finally {
			component.dispose();
		}
	});

	it("PageDown/PageUp move the left-pane selection by a viewport page", () => {
		const root = tmpRegistry();
		// More runs than one viewport page so a page jump is observable.
		for (let i = 0; i < 60; i++) {
			appendCompleteRun(root, {
				runId: `run-${String(i).padStart(2, "0")}`,
				agentName: "fixer",
				label: `run ${String(i).padStart(2, "0")}`,
				rootRunId: `run-${String(i).padStart(2, "0")}`,
				startedAt: 1000 - i, // descending so run-00 sorts first (newest)
			});
		}
		const component = new SubagentsStatusComponent(
			createTestTui(() => {}),
			createTestTheme(),
			() => {},
			{ refreshMs: 1000, sessionCwd: root },
		);
		try {
			// Establish lastLeftListHeight via a first render; selection starts at top.
			component.render(180);
			const counterIndex = (): number => {
				// The selection counter "N/60" lives in the bottom border (├─ N/60 ─┤).
				const m = component.render(180).join("\n").match(/(\d+)\/60/);
				return m ? Number(m[1]) : -1;
			};
			const start = counterIndex();
			assert.equal(start, 1, "selection should start at row 1");

			// One PageDown must advance by a full page (>1), not a single row.
			component.handleInput("\x1b[6~"); // PgDn (CSI 6~)
			const afterPgDn = counterIndex();
			assert.ok(afterPgDn > start + 1, `PageDown should jump a page, got ${start} -> ${afterPgDn}`);

			// PageUp returns toward the top by the same page size.
			component.handleInput("\x1b[5~"); // PgUp (CSI 5~)
			const afterPgUp = counterIndex();
			assert.equal(afterPgUp, start, `PageUp should return to the top, got ${afterPgUp}`);
		} finally {
			component.dispose();
		}
	});
});
