import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { formatAsyncRunList, readRunViewForEntry } from "../../src/state/async-status.ts";
import { buildRightLines, buildWorkflowRightLines } from "../../src/surfaces/dashboard-detail-renderer.ts";
import { deriveDisplayRows } from "../../src/surfaces/dashboard-row-model.ts";
import {
	SubagentsStatusComponent,
	runViewFromRegistryEntry,
	type LiveRun,
} from "../../src/surfaces/subagents-status.ts";
import {
	writeWorkflowGroupPhase,
	writeWorkflowMeta,
	writeWorkflowScript,
} from "../../src/workflow/workflow-group-state.ts";
import {
	appendRunEntry,
	readAllEntries,
	setRegistryPathForTests,
	type RunsRegistryEntry,
} from "../../src/state/runs-registry.ts";

type StatusTui = ConstructorParameters<typeof SubagentsStatusComponent>[0];
type StatusTheme = ConstructorParameters<typeof SubagentsStatusComponent>[1];

const tmpRoots: string[] = [];

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function persistWorkflowMeta(group: RunsRegistryEntry): void {
	writeWorkflowScript(group.runRecordDir, "phase('inspect');");
	writeWorkflowMeta(group.runRecordDir, {
		name: "Parity audit",
		description: "Compare behavior",
		phases: [{ title: "inspect" }, { title: "patch" }, { title: "report" }],
	});
}

function tmpRegistry(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-dashboard-"));
	tmpRoots.push(root);
	setRegistryPathForTests(path.join(root, "registry", "runs-index.jsonl"));
	return root;
}

function appendWorkflowGroup(root: string): RunsRegistryEntry {
	const runId = "workflow-group";
	const runRecordDir = path.join(root, "runs", runId);
	fs.mkdirSync(runRecordDir, { recursive: true });
	const entry: RunsRegistryEntry = {
		runId,
		runRecordDir,
		mode: "parallel",
		source: "sync",
		kind: "workflow",
		rootRunId: runId,
		cwd: root,
		startedAt: 1000,
	};
	appendRunEntry(entry);
	return entry;
}

function appendNonWorkflowParent(root: string): RunsRegistryEntry {
	const runId = "parallel-parent";
	const runRecordDir = path.join(root, "runs", runId);
	fs.mkdirSync(runRecordDir, { recursive: true });
	const entry: RunsRegistryEntry = {
		runId,
		runRecordDir,
		mode: "parallel",
		source: "sync",
		rootRunId: runId,
		cwd: root,
		startedAt: 1000,
	};
	appendRunEntry(entry);
	return entry;
}

function appendWorkflowChild(
	root: string,
	entry: {
		runId: string;
		parentRunId: string;
		agentName: string;
		startedAt: number;
		phaseIndex: number;
		phaseTitle: string;
		parallelGroupId?: string;
	},
): RunsRegistryEntry {
	const runRecordDir = path.join(root, "runs", entry.runId);
	fs.mkdirSync(runRecordDir, { recursive: true });
	fs.writeFileSync(
		path.join(runRecordDir, "status.json"),
		JSON.stringify({
			runId: entry.runId,
			mode: "single",
			state: "complete",
			startedAt: entry.startedAt,
			lastUpdate: entry.startedAt + 10,
			endedAt: entry.startedAt + 10,
			cwd: root,
			currentStep: 0,
			parentRunId: entry.parentRunId,
			steps: [
				{
					agent: entry.agentName,
					status: "complete",
					startedAt: entry.startedAt,
					endedAt: entry.startedAt + 10,
				},
			],
		}),
		"utf8",
	);
	const registryEntry: RunsRegistryEntry = {
		runId: entry.runId,
		runRecordDir,
		mode: "single",
		source: "async",
		agentName: entry.agentName,
		parentRunId: entry.parentRunId,
		rootRunId: entry.parentRunId,
		cwd: root,
		startedAt: entry.startedAt,
		phaseIndex: entry.phaseIndex,
		phaseTitle: entry.phaseTitle,
		...(entry.parallelGroupId ? { parallelGroupId: entry.parallelGroupId } : {}),
	};
	appendRunEntry(registryEntry);
	return registryEntry;
}

function setupWorkflowRegistry(): {
	group: RunsRegistryEntry;
	children: RunsRegistryEntry[];
	entries: RunsRegistryEntry[];
} {
	const root = tmpRegistry();
	const group = appendWorkflowGroup(root);
	const children = [
		appendWorkflowChild(root, {
			runId: "phase-1-a",
			parentRunId: group.runId,
			agentName: "explorer",
			startedAt: 2000,
			phaseIndex: 1,
			phaseTitle: "inspect",
			parallelGroupId: "phase-1-parallel",
		}),
		appendWorkflowChild(root, {
			runId: "phase-1-b",
			parentRunId: group.runId,
			agentName: "review",
			startedAt: 2100,
			phaseIndex: 1,
			phaseTitle: "inspect",
			parallelGroupId: "phase-1-parallel",
		}),
		appendWorkflowChild(root, {
			runId: "phase-2-a",
			parentRunId: group.runId,
			agentName: "fixer",
			startedAt: 3000,
			phaseIndex: 2,
			phaseTitle: "patch",
		}),
	];
	return { group, children, entries: readAllEntries() };
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

function assertWorkflowChildren(
	actual: Array<{ id: string; phaseIndex?: number; phaseTitle?: string; parallelGroupId?: string }>,
): void {
	const byId = new Map(actual.map((summary) => [summary.id, summary]));
	assert.deepEqual(
		["phase-1-a", "phase-1-b", "phase-2-a"].map(
			(id) =>
				byId.get(id) && {
					id,
					phaseIndex: byId.get(id)?.phaseIndex,
					phaseTitle: byId.get(id)?.phaseTitle,
					parallelGroupId: byId.get(id)?.parallelGroupId,
				},
		),
		[
			{ id: "phase-1-a", phaseIndex: 1, phaseTitle: "inspect", parallelGroupId: "phase-1-parallel" },
			{ id: "phase-1-b", phaseIndex: 1, phaseTitle: "inspect", parallelGroupId: "phase-1-parallel" },
			{ id: "phase-2-a", phaseIndex: 2, phaseTitle: "patch", parallelGroupId: undefined },
		],
	);
}

afterEach(() => {
	setRegistryPathForTests(null);
	for (const root of tmpRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("workflow dashboard reader overlays", () => {
	it("subagents-status marks workflow groups and copies registry phase tags onto child summaries", () => {
		const { group, children, entries } = setupWorkflowRegistry();
		persistWorkflowMeta(group);

		const groupSummary = runViewFromRegistryEntry(group, entries);
		assert.equal(groupSummary.workflow, true);
		assert.equal(groupSummary.workflowMeta?.name, "Parity audit");

		const childSummaries = children.map((child) => runViewFromRegistryEntry(child, entries));
		assertWorkflowChildren(childSummaries);
	});

	it("async-status marks workflow groups and copies registry phase tags onto child summaries", () => {
		const { group, children, entries } = setupWorkflowRegistry();
		persistWorkflowMeta(group);

		const groupSummary = readRunViewForEntry(group, entries);
		assert.equal(groupSummary?.workflow, true);
		assert.equal(groupSummary?.workflowMeta?.name, "Parity audit");

		const childSummaries = children
			.map((child) => readRunViewForEntry(child, entries))
			.filter((child): child is NonNullable<typeof child> => Boolean(child));
		assertWorkflowChildren(childSummaries);
	});

	it("async-status renders workflow groups by phase with bracketed parallel siblings", () => {
		const { entries } = setupWorkflowRegistry();
		const summaries = entries
			.map((entry) => readRunViewForEntry(entry, entries))
			.filter((summary): summary is NonNullable<typeof summary> => Boolean(summary));

		const text = formatAsyncRunList(summaries);
		assert.match(text, /workflow-group \| complete \| workflow \| tasks 3\/3 complete/);
		assert.doesNotMatch(text, /workflow-group \| complete \| parallel \|/);
		const phase1Index = text.indexOf("  Phase 1: inspect");
		const bracketBIndex = text.indexOf("  - [phase-1-parallel] phase-1-b");
		const bracketAIndex = text.indexOf("  - [phase-1-parallel] phase-1-a");
		const phase2Index = text.indexOf("  Phase 2: patch");
		const phase2ChildIndex = text.indexOf("  - phase-2-a");
		assert.ok(phase1Index !== -1);
		assert.ok(bracketAIndex > phase1Index);
		assert.ok(bracketBIndex > phase1Index);
		assert.ok(phase2Index > bracketAIndex);
		assert.ok(phase2Index > bracketBIndex);
		assert.ok(phase2ChildIndex > phase2Index);
	});

	it("subagents-status renders workflow groups with phase rows without relabeling them parallel", () => {
		const { group, entries } = setupWorkflowRegistry();
		persistWorkflowMeta(group);
		const component = new SubagentsStatusComponent(
			createTestTui(() => {}),
			createTestTheme(),
			() => {},
			{ refreshMs: 1000, sessionCwd: entries[0]!.cwd },
		);

		try {
			const rendered = component.render(180).map(stripBorders).map(stripAnsi);
			const text = rendered.join("\n");
			const leftText = rendered.map((line) => line.split("│")[0]).join("\n");
			assert.match(text, /┬─ Parity audit /);
			// Container row: state-tinted collapse marker + done/total child progress.
			assert.match(text, /▾ Parity audit · 3\/3/);
			assert.doesNotMatch(text, /┬─ parallel /);
			assert.doesNotMatch(text, /▾ parallel · complete/);
			// Phase labels are tree rows; children no longer carry P1/P2 chips.
			const phase1RowIndex = leftText.indexOf("Phase 1: inspect · 2/2");
			const phase2RowIndex = leftText.indexOf("Phase 2: patch · 1/1");
			const phase1Index = leftText.indexOf("explorer");
			const phase2Index = leftText.indexOf("fixer");
			assert.ok(phase1RowIndex !== -1, "expected phase-1 row in status output");
			assert.ok(phase2RowIndex !== -1, "expected phase-2 row in status output");
			assert.ok(phase1Index !== -1, "expected phase-1 child in status output");
			assert.ok(phase2Index !== -1, "expected phase-2 child in status output");
			assert.ok(phase1RowIndex < phase1Index, "phase-1 children render below phase row");
			assert.ok(phase1Index < phase2RowIndex, "phase 2 renders after phase 1 children");
			assert.ok(phase2RowIndex < phase2Index, "phase-2 child renders below phase row");
			assert.match(leftText, /explorer/);
			assert.match(leftText, /review/);
			assert.match(leftText, /fixer/);
			assert.doesNotMatch(text, /P1 inspect/);
			assert.doesNotMatch(text, /P2 patch/);
		} finally {
			component.dispose();
		}
	});

	it("subagents-status preserves existing child ordering for non-workflow parents", () => {
		const root = tmpRegistry();
		const parent = appendNonWorkflowParent(root);
		appendWorkflowChild(root, {
			runId: "parallel-phase-1",
			parentRunId: parent.runId,
			agentName: "explorer",
			startedAt: 2000,
			phaseIndex: 1,
			phaseTitle: "inspect",
		});
		appendWorkflowChild(root, {
			runId: "parallel-phase-2",
			parentRunId: parent.runId,
			agentName: "fixer",
			startedAt: 3000,
			phaseIndex: 2,
			phaseTitle: "patch",
		});
		const entries = readAllEntries();
		const component = new SubagentsStatusComponent(
			createTestTui(() => {}),
			createTestTheme(),
			() => {},
			{ refreshMs: 1000, sessionCwd: root },
		);

		try {
			void entries;
			const text = component.render(180).map(stripBorders).map(stripAnsi).join("\n");
			// Leaf rows drop the redundant state word; the ✓ glyph conveys completion.
			const phase2Index = text.indexOf("fixer · P2 patch");
			const phase1Index = text.indexOf("explorer · P1 inspect");
			assert.ok(phase2Index !== -1, "expected newer non-workflow child in status output");
			assert.ok(phase1Index !== -1, "expected older non-workflow child in status output");
			assert.ok(phase2Index < phase1Index, "non-workflow children keep the global display order");
		} finally {
			component.dispose();
		}
	});

	it("workflow right pane shows the script and a phase-grouped step outline", () => {
		const { group, entries } = setupWorkflowRegistry();
		writeWorkflowScript(group.runRecordDir, 'const a = await agent("explorer", "inspect");\nreturn a.summary;');
		writeWorkflowMeta(group.runRecordDir, {
			name: "Parity audit",
			description: "Compare behavior",
			phases: [{ title: "inspect", detail: "Discover areas" }, { title: "patch" }, { title: "report" }],
		});
		writeWorkflowGroupPhase(group.runRecordDir, 3, "report");

		const groupSummary = runViewFromRegistryEntry(group, entries);
		const runs: LiveRun[] = entries.map((entry) => ({
			ownership: "foreign",
			run: runViewFromRegistryEntry(entry, entries),
		}));
		const theme = createTestTheme();
		const lines = buildWorkflowRightLines(theme, groupSummary, 120, runs).join("\n");

		assert.match(lines, /Parity audit/);
		assert.match(lines, /Compare behavior/);
		assert.match(lines, /1\. inspect · completed — Discover areas/);
		assert.match(lines, /2\. patch · completed/);
		assert.match(lines, /3\. report · completed/);
		assert.match(lines, /─ Script ─/);
		assert.match(lines, /const a = await agent\("explorer", "inspect"\);/);
		assert.match(lines, /return a\.summary;/);
		assert.match(lines, /─ Steps ─/);
		// Phase headers appear once per phase, children grouped beneath.
		assert.match(lines, /Phase 1: inspect/);
		assert.match(lines, /Phase 2: patch/);
		const scriptIdx = lines.indexOf("─ Script ─");
		const stepsIdx = lines.indexOf("─ Steps ─");
		assert.ok(scriptIdx !== -1 && stepsIdx !== -1 && scriptIdx < stepsIdx, "script section renders before steps");
		const p1 = lines.indexOf("Phase 1: inspect");
		const p2 = lines.indexOf("Phase 2: patch");
		assert.ok(p1 < p2, "phases render in order");
		// Children render with agent + state under their phase.
		assert.match(lines, /explorer/);
		assert.match(lines, /fixer/);
		assert.match(lines, /complete/);
		// Parallel children carry the compact parallel marker; the solo phase-2 child does not.
		assert.match(lines, /∥ .*explorer/);
		assert.doesNotMatch(lines, /∥ .*fixer/);
	});

	it("buildRightLines routes a workflow group to the workflow pane", () => {
		const { group, entries } = setupWorkflowRegistry();
		writeWorkflowScript(group.runRecordDir, 'await agent("explorer", "x");');
		const groupSummary = runViewFromRegistryEntry(group, entries);
		const runs: LiveRun[] = entries.map((entry) => ({
			ownership: "foreign",
			run: runViewFromRegistryEntry(entry, entries),
		}));
		const lines = buildRightLines(createTestTheme(), { ownership: "foreign", run: groupSummary }, 120, runs).join(
			"\n",
		);
		assert.match(lines, /─ Script ─/, "mutant: buildRightLines must route workflow groups to the workflow pane");
		assert.match(lines, /─ Steps ─/);
	});

	it("workflow right pane renders the whole script without truncation", () => {
		const { group, entries } = setupWorkflowRegistry();
		const longScript = Array.from({ length: 40 }, (_, i) => `phase("step ${i}");`).join("\n");
		writeWorkflowScript(group.runRecordDir, longScript);

		const groupSummary = runViewFromRegistryEntry(group, entries);
		const lines = buildWorkflowRightLines(createTestTheme(), groupSummary, 120, []).join("\n");
		// No line cap: every phase line renders, including past the former 24-line limit.
		assert.match(lines, /phase\("step 0"\);/);
		assert.match(lines, /phase\("step 24"\);/);
		assert.match(lines, /phase\("step 39"\);/);
		assert.doesNotMatch(lines, /more lines\)/);
	});

	it("workflow group with no script still outlines steps (no transcript fallback noise)", () => {
		const { group, entries } = setupWorkflowRegistry();
		const groupSummary = runViewFromRegistryEntry(group, entries);
		const runs: LiveRun[] = entries.map((entry) => ({
			ownership: "foreign",
			run: runViewFromRegistryEntry(entry, entries),
		}));
		const lines = buildWorkflowRightLines(createTestTheme(), groupSummary, 120, runs).join("\n");
		assert.doesNotMatch(lines, /─ Script ─/);
		assert.match(lines, /─ Steps ─/);
		assert.match(lines, /Phase 1: inspect/);
	});
});

describe("workflow dashboard pipeline rows", () => {
	it("groups pipeline children under item rows", () => {
		const workflow: LiveRun = {
			ownership: "foreign",
			run: { id: "wf", workflow: true, mode: "parallel", state: "running", startedAt: 1, steps: [] },
		};
		const child = (id: string, itemIndex: number, stageIndex: number, itemLabel?: string): LiveRun => ({
			ownership: "foreign",
			run: {
				id,
				parentRunId: "wf",
				mode: "single",
				state: "complete",
				startedAt: 10 + itemIndex * 10 + stageIndex,
				phaseIndex: 1,
				phaseTitle: "process",
				pipeline: { id: "pipe", itemIndex, stageIndex, ...(itemLabel ? { itemLabel } : {}) },
				steps: [{ index: 0, agent: `agent-${stageIndex}`, status: "complete" }],
			},
		});

		const rows = deriveDisplayRows(
			[workflow, child("a", 0, 0, "sync widget"), child("b", 0, 1, "sync widget"), child("c", 1, 0)],
			new Set(),
		);
		assert.deepEqual(
			rows.map((row) =>
				row.kind === "pipelineItem"
					? `item:${row.label ?? row.itemIndex}:${row.total}`
					: row.kind === "run"
						? `run:${row.run.run.id}`
						: row.kind,
			),
			["run:wf", "phase", "item:sync widget:2", "run:a", "run:b", "item:1:1", "run:c"],
		);
	});
});
