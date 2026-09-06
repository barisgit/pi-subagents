import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { runViewFromRegistryEntry, SubagentsStatusComponent } from "../../src/surfaces/subagents-status.ts";
import { containerRowInfo, deriveDisplayRows } from "../../src/surfaces/dashboard-row-model.ts";
import {
	appendRunEntry,
	readAllEntries,
	setRegistryPathForTests,
	type RunsRegistryEntry,
} from "../../src/state/runs-registry.ts";
import {
	writeWorkflowGroupPhase,
	writeWorkflowGroupState,
	writeWorkflowMeta,
	writeWorkflowScript,
} from "../../src/workflow/workflow-group-state.ts";

type StatusTui = ConstructorParameters<typeof SubagentsStatusComponent>[0];
type StatusTheme = ConstructorParameters<typeof SubagentsStatusComponent>[1];

const tmpRoots: string[] = [];

function tmpRegistry(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-phase-tree-"));
	tmpRoots.push(root);
	setRegistryPathForTests(path.join(root, "registry", "runs-index.jsonl"));
	return root;
}

function seedWorkflowPlan(
	root: string,
	phases: string[],
	state: "running" | "complete",
	current?: { index: number; title: string },
): void {
	const runRecordDir = path.join(root, "runs", "wf");
	writeWorkflowScript(runRecordDir, "return 'done';");
	writeWorkflowMeta(runRecordDir, {
		name: "Parity audit",
		description: "Compare behavior",
		phases: phases.map((title) => ({ title })),
	});

	writeWorkflowGroupState(runRecordDir, state);
	if (current) writeWorkflowGroupPhase(runRecordDir, current.index, current.title);
}

function createTestTui(): StatusTui {
	return { requestRender: () => {}, terminal: { rows: 48 } } as StatusTui;
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

interface SeedRun {
	runId: string;
	agentName?: string;
	mode?: "single" | "parallel";
	state?: "running" | "complete";
	label?: string;
	parentRunId?: string;
	rootRunId?: string;
	workflow?: boolean;
	phaseIndex?: number;
	phaseTitle?: string;
	parallelGroupId?: string;
	pipeline?: {
		id: string;
		name?: string;
		itemIndex: number;
		stageIndex: number;
		itemLabel?: string;
		stageTitle?: string;
		stageCount?: number;
		itemCount?: number;
	};
	startedAt: number;
}

function seedRun(root: string, entry: SeedRun): void {
	const runRecordDir = path.join(root, "runs", entry.runId);
	fs.mkdirSync(runRecordDir, { recursive: true });
	const state = entry.state ?? "complete";
	const terminal = state !== "running";
	if (entry.agentName) {
		fs.writeFileSync(
			path.join(runRecordDir, "status.json"),
			JSON.stringify({
				runId: entry.runId,
				mode: entry.mode ?? "single",
				state,
				startedAt: entry.startedAt,
				lastUpdate: terminal ? entry.startedAt + 1 : Date.now(),
				runnerHeartbeatAt: terminal ? entry.startedAt + 1 : Date.now(),
				...(terminal ? { endedAt: entry.startedAt + 1 } : {}),
				cwd: root,
				currentStep: 0,
				...(entry.label ? { label: entry.label } : {}),
				...(entry.parentRunId ? { parentRunId: entry.parentRunId } : {}),
				...(entry.pipeline ? { pipeline: entry.pipeline } : {}),
				steps: [
					{
						agent: entry.agentName,
						status: state,
						startedAt: entry.startedAt,
						...(terminal ? { endedAt: entry.startedAt + 1 } : {}),
					},
				],
			}),
			"utf8",
		);
	}
	appendRunEntry({
		runId: entry.runId,
		runRecordDir,
		mode: entry.mode ?? "single",
		source: "async",
		...(entry.agentName ? { agentName: entry.agentName } : {}),
		...(entry.label ? { label: entry.label } : {}),
		...(entry.parentRunId ? { parentRunId: entry.parentRunId } : {}),
		...(entry.rootRunId ? { rootRunId: entry.rootRunId } : {}),
		...(entry.workflow ? { kind: "workflow" as const } : {}),
		...(entry.phaseIndex !== undefined ? { phaseIndex: entry.phaseIndex } : {}),
		...(entry.phaseTitle !== undefined ? { phaseTitle: entry.phaseTitle } : {}),
		...(entry.parallelGroupId !== undefined ? { parallelGroupId: entry.parallelGroupId } : {}),
		...(entry.pipeline
			? {
					pipelineId: entry.pipeline.id,
					pipelineItemIndex: entry.pipeline.itemIndex,
					pipelineStageIndex: entry.pipeline.stageIndex,
					...(entry.pipeline.itemLabel ? { pipelineItemLabel: entry.pipeline.itemLabel } : {}),
					...(entry.pipeline.name ? { pipelineName: entry.pipeline.name } : {}),
					...(entry.pipeline.stageTitle ? { pipelineStageTitle: entry.pipeline.stageTitle } : {}),
					...(entry.pipeline.stageCount !== undefined
						? { pipelineStageCount: entry.pipeline.stageCount }
						: {}),
					...(entry.pipeline.itemCount !== undefined ? { pipelineItemCount: entry.pipeline.itemCount } : {}),
				}
			: {}),
		cwd: root,
		startedAt: entry.startedAt,
	} as RunsRegistryEntry);
}

function renderRows(component: SubagentsStatusComponent): string[] {
	return component.render(180).map(stripBorders);
}

function leftRows(component: SubagentsStatusComponent): string[] {
	return renderRows(component).map((line) => line.split("│")[0] ?? line);
}

afterEach(() => {
	setRegistryPathForTests(null);
	for (const root of tmpRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("dashboard workflow phase tree", () => {
	it("renders upcoming declared phases without fake children or counts", () => {
		const root = tmpRegistry();
		seedRun(root, { runId: "wf", mode: "parallel", workflow: true, rootRunId: "wf", startedAt: 1000 });
		seedRun(root, {
			runId: "scope-child",
			agentName: "explorer",
			parentRunId: "wf",
			rootRunId: "wf",
			phaseIndex: 1,
			phaseTitle: "Scope",
			startedAt: 1100,
		});
		seedWorkflowPlan(root, ["Scope", "Review", "Report"], "running", { index: 1, title: "Scope" });

		const component = new SubagentsStatusComponent(createTestTui(), createTestTheme(), () => {}, { refreshMs: 0 });
		try {
			const body = leftRows(component).join("\n");
			assert.match(body, /Phase 1: Scope · 1\/1/);
			// Childless phase headers use the aggregate empty-state ○ glyph.
			assert.match(body, /○ Phase 2: Review · upcoming/);
			assert.match(body, /○ Phase 3: Report · upcoming/);
			assert.doesNotMatch(body, /Review · 0\/0|Report · 0\/0/);
		} finally {
			component.dispose();
		}
	});

	it("uses a durable childless current phase in the tree and parent chip", () => {
		const root = tmpRegistry();
		seedRun(root, { runId: "wf", mode: "parallel", workflow: true, rootRunId: "wf", startedAt: 1000 });
		seedRun(root, {
			runId: "scope-child",
			agentName: "explorer",
			parentRunId: "wf",
			rootRunId: "wf",
			phaseIndex: 1,
			phaseTitle: "Scope",
			startedAt: 1100,
		});
		seedWorkflowPlan(root, ["Scope", "Review", "Report"], "running", { index: 2, title: "Review" });

		const component = new SubagentsStatusComponent(createTestTui(), createTestTheme(), () => {}, { refreshMs: 0 });
		try {
			const body = leftRows(component).join("\n");
			assert.match(body, /Parity audit .*Phase 2\/3: Review/);
			// Plan labels remain badges; aggregate state is carried by the ○ glyph.
			assert.match(body, /○ Phase 2: Review · current/);
			assert.match(body, /○ Phase 3: Report · upcoming/);
		} finally {
			component.dispose();
		}
	});

	it("renders terminal declared phases that never ran as unreached", () => {
		const root = tmpRegistry();
		seedRun(root, { runId: "wf", mode: "parallel", workflow: true, rootRunId: "wf", startedAt: 1000 });
		seedRun(root, {
			runId: "scope-child",
			agentName: "explorer",
			parentRunId: "wf",
			rootRunId: "wf",
			phaseIndex: 1,
			phaseTitle: "Scope",
			startedAt: 1100,
		});
		seedWorkflowPlan(root, ["Scope", "Review", "Report"], "complete");

		const component = new SubagentsStatusComponent(createTestTui(), createTestTheme(), () => {}, { refreshMs: 0 });
		try {
			const body = leftRows(component).join("\n");
			// Unreached childless phases retain their badge after the aggregate ○ glyph.
			assert.match(body, /○ Phase 2: Review · unreached/);
			assert.match(body, /○ Phase 3: Report · unreached/);
		} finally {
			component.dispose();
		}
	});

	it("preserves ad-hoc runtime phase rows alongside declared phases", () => {
		const root = tmpRegistry();
		seedRun(root, { runId: "wf", mode: "parallel", workflow: true, rootRunId: "wf", startedAt: 1000 });
		seedRun(root, {
			runId: "scope-child",
			agentName: "explorer",
			parentRunId: "wf",
			rootRunId: "wf",
			phaseIndex: 1,
			phaseTitle: "Scope",
			startedAt: 1100,
		});
		seedRun(root, {
			runId: "adhoc-child",
			agentName: "review",
			state: "running",
			parentRunId: "wf",
			rootRunId: "wf",
			phaseIndex: 2,
			phaseTitle: "Ad hoc",
			startedAt: 1200,
		});
		seedWorkflowPlan(root, ["Scope", "Verify"], "running", { index: 2, title: "Ad hoc" });
		const entries = readAllEntries();
		const displayRows = deriveDisplayRows(
			entries.map((entry) => ({ ownership: "foreign", run: runViewFromRegistryEntry(entry, entries) })),
			new Set(),
		);
		const phaseRows = displayRows.filter((row) => row.kind === "phase");
		assert.equal(new Set(phaseRows.map((row) => row.title)).size, phaseRows.length);
		assert.equal(phaseRows.find((row) => row.title === "Scope")?.planState, "completed");
		assert.equal(phaseRows.find((row) => row.title === "Verify")?.planState, "upcoming");
		assert.equal(phaseRows.find((row) => row.title === "Ad hoc")?.running, true);

		const component = new SubagentsStatusComponent(createTestTui(), createTestTheme(), () => {}, { refreshMs: 0 });
		try {
			const body = leftRows(component).join("\n");
			assert.match(body, /Phase 1: Scope · 1\/1/);
			// Declared childless rows now use the shared queued glyph.
			assert.match(body, /○ Phase 2: Verify · upcoming/);
			assert.match(body, /Phase 2: Ad hoc · 0\/1/);
			assert.match(body, /review/);
		} finally {
			component.dispose();
		}
	});

	it("keeps no-metadata workflows on latest-child phase behavior", () => {
		const root = tmpRegistry();
		seedRun(root, { runId: "wf", mode: "parallel", workflow: true, rootRunId: "wf", startedAt: 1000 });
		seedRun(root, {
			runId: "legacy-child",
			agentName: "explorer",
			parentRunId: "wf",
			rootRunId: "wf",
			phaseIndex: 4,
			phaseTitle: "Legacy",
			startedAt: 1100,
		});
		writeWorkflowGroupState(path.join(root, "runs", "wf"), "running");

		const component = new SubagentsStatusComponent(createTestTui(), createTestTheme(), () => {}, { refreshMs: 0 });
		try {
			const body = leftRows(component).join("\n");
			assert.match(body, /workflow · Phase 4: Legacy/);
			assert.match(body, /Phase 4: Legacy · 1\/1/);
			assert.doesNotMatch(body, /upcoming|unreached/);
		} finally {
			component.dispose();
		}
	});

	it("renders phases as selectable tree rows with child runs nested below", () => {
		const root = tmpRegistry();
		seedRun(root, {
			runId: "wf",
			mode: "parallel",
			workflow: true,
			label: "workflow",
			rootRunId: "wf",
			startedAt: 1000,
		});
		seedRun(root, {
			runId: "p1-a",
			agentName: "explorer",
			parentRunId: "wf",
			rootRunId: "wf",
			phaseIndex: 1,
			phaseTitle: "Phase 1: recon",
			parallelGroupId: "pg-1",
			startedAt: 1100,
		});
		seedRun(root, {
			runId: "p1-b",
			agentName: "review",
			parentRunId: "wf",
			rootRunId: "wf",
			phaseIndex: 1,
			phaseTitle: "Phase 1: recon",
			parallelGroupId: "pg-1",
			startedAt: 1200,
		});
		seedRun(root, {
			runId: "p2-a",
			agentName: "qa",
			parentRunId: "wf",
			rootRunId: "wf",
			phaseIndex: 2,
			phaseTitle: "Phase 2: verify",
			startedAt: 1300,
		});

		const component = new SubagentsStatusComponent(createTestTui(), createTestTheme(), () => {}, { refreshMs: 0 });
		try {
			const rows = leftRows(component);
			const body = rows.join("\n");
			// Container state is encoded by the tinted marker, not a status word.
			assert.match(body, /▾ workflow · 3\/3/);
			const phase1 = rows.findIndex((line) => /▾ Phase 1: recon · 2\/2/.test(line));
			const explorer = rows.findIndex((line) => line.includes("explorer"));
			const review = rows.findIndex((line) => line.includes("review"));
			const phase2 = rows.findIndex((line) => /▾ Phase 2: verify · 1\/1/.test(line));
			const qa = rows.findIndex((line) => line.includes("qa"));
			assert.ok(phase1 !== -1 && explorer !== -1 && review !== -1 && phase2 !== -1 && qa !== -1);
			assert.ok(phase1 < explorer && phase1 < review, "phase 1 children render below phase row");
			assert.ok(explorer < phase2 && review < phase2, "phase 2 row renders after phase 1 children");
			assert.ok(phase2 < qa, "phase 2 child renders below phase row");
			assert.match(rows[explorer]!, /∥ .*explorer/);
			assert.match(rows[review]!, /∥ .*review/);
			assert.doesNotMatch(rows[qa]!, /∥/);
			assert.doesNotMatch(body, /P1/);
			assert.doesNotMatch(body, /P2/);

			component.handleInput("j");
			component.handleInput("\r");
			const collapsedPhase = leftRows(component).join("\n");
			assert.match(collapsedPhase, /▸ Phase 1: recon · 2\/2/);
			assert.doesNotMatch(collapsedPhase, /explorer/);
			assert.doesNotMatch(collapsedPhase, /review/);
			assert.match(collapsedPhase, /Phase 2: verify/);
			assert.match(collapsedPhase, /qa/);

			component.handleInput("k");
			component.handleInput("\r");
			const collapsedWorkflow = leftRows(component).join("\n");
			// Collapsing changes the marker, while state remains marker color only.
			assert.match(collapsedWorkflow, /▸ workflow · 3\/3/);
			assert.doesNotMatch(collapsedWorkflow, /Phase 1: recon/);
			assert.doesNotMatch(collapsedWorkflow, /Phase 2: verify/);
		} finally {
			component.dispose();
		}
	});

	it("renders phaseless workflow children directly under the workflow before phase groups", () => {
		const root = tmpRegistry();
		seedRun(root, { runId: "wf", mode: "parallel", workflow: true, rootRunId: "wf", startedAt: 1000 });
		seedRun(root, {
			runId: "phase",
			agentName: "qa",
			parentRunId: "wf",
			rootRunId: "wf",
			phaseIndex: 1,
			phaseTitle: "verify",
			startedAt: 1100,
		});
		seedRun(root, { runId: "plain", agentName: "fixer", parentRunId: "wf", rootRunId: "wf", startedAt: 1200 });

		const component = new SubagentsStatusComponent(createTestTui(), createTestTheme(), () => {}, { refreshMs: 0 });
		try {
			const rows = leftRows(component);
			const plain = rows.findIndex((line) => line.includes("fixer"));
			const phase = rows.findIndex((line) => /Phase 1: verify/.test(line));
			assert.ok(plain !== -1 && phase !== -1);
			assert.ok(plain < phase, "phaseless child renders before phase groups");
		} finally {
			component.dispose();
		}
	});
	it("merges prefixed declared and runtime titles into exactly one phase row", () => {
		const root = tmpRegistry();
		seedRun(root, { runId: "wf", mode: "parallel", workflow: true, rootRunId: "wf", startedAt: 1000 });
		seedRun(root, {
			runId: "recon-child",
			agentName: "explorer",
			parentRunId: "wf",
			rootRunId: "wf",
			phaseIndex: 1,
			phaseTitle: "Phase 1: Recon",
			startedAt: 1100,
		});
		seedWorkflowPlan(root, ["Phase 1: Recon", "Phase 2: Report"], "running", {
			index: 1,
			title: "Phase 1: Recon",
		});

		const entries = readAllEntries();
		const phaseRows = deriveDisplayRows(
			entries.map((entry) => ({ ownership: "foreign", run: runViewFromRegistryEntry(entry, entries) })),
			new Set(),
		).filter((row) => row.kind === "phase");
		assert.equal(phaseRows.filter((row) => row.title === "Recon").length, 1);
		assert.equal(phaseRows.length, 2);

		const component = new SubagentsStatusComponent(createTestTui(), createTestTheme(), () => {}, { refreshMs: 0 });
		try {
			const body = leftRows(component).join("\n");
			assert.doesNotMatch(body, /Phase 1(?:\/2)?: Phase 1:/);
		} finally {
			component.dispose();
		}
	});

	it("restores childless reached phases from durable history", () => {
		const root = tmpRegistry();
		seedRun(root, { runId: "wf", mode: "parallel", workflow: true, rootRunId: "wf", startedAt: 1000 });
		seedWorkflowPlan(root, ["Scope", "Review", "Report"], "running");
		const runRecordDir = path.join(root, "runs", "wf");
		writeWorkflowGroupPhase(runRecordDir, 1, "Scope");
		writeWorkflowGroupPhase(runRecordDir, 2, "Review");
		writeWorkflowGroupPhase(runRecordDir, 3, "Report");

		const component = new SubagentsStatusComponent(createTestTui(), createTestTheme(), () => {}, { refreshMs: 0 });
		try {
			const body = leftRows(component).join("\n");
			assert.match(body, /Phase 1: Scope · completed/);
			assert.match(body, /Phase 2: Review · completed/);
			assert.match(body, /Phase 3: Report · current/);
		} finally {
			component.dispose();
		}
	});

	it("uses the highest declared phase reached when durable phase writes arrive out of order", () => {
		const root = tmpRegistry();
		seedRun(root, { runId: "wf", mode: "parallel", workflow: true, rootRunId: "wf", startedAt: 1000 });
		seedRun(root, {
			runId: "verification-child",
			agentName: "reviewer",
			parentRunId: "wf",
			rootRunId: "wf",
			phaseIndex: 5,
			phaseTitle: "Preverjanje",
			startedAt: 1100,
		});
		seedWorkflowPlan(root, ["Zajem", "Načrt", "Izvedba", "Pregled", "Preverjanje"], "running");
		const runRecordDir = path.join(root, "runs", "wf");
		writeWorkflowGroupPhase(runRecordDir, 5, "Preverjanje");
		writeWorkflowGroupPhase(runRecordDir, 3, "Izvedba");

		const entries = readAllEntries();
		const runs = entries.map((entry) => ({
			ownership: "foreign" as const,
			run: runViewFromRegistryEntry(entry, entries),
		}));
		const workflow = runs.find((run) => run.run.id === "wf");
		assert.ok(workflow);
		const info = containerRowInfo(runs, new Set(), workflow);
		assert.equal(
			info?.phaseChip,
			"Phase 5/5: Preverjanje",
			"the root chip reflects the furthest declared phase reached",
		);
	});

	it("fails closed before unsafe metadata can inject a dashboard frame", () => {
		const root = tmpRegistry();
		seedRun(root, { runId: "wf", mode: "parallel", workflow: true, rootRunId: "wf", startedAt: 1000 });
		const runRecordDir = path.join(root, "runs", "wf");
		writeWorkflowScript(runRecordDir, "return 'done';");
		writeWorkflowMeta(runRecordDir, {
			name: "Safe\nforged row",
			description: "Compare behavior",
			phases: [],
		});
		writeWorkflowGroupState(runRecordDir, "running");

		const component = new SubagentsStatusComponent(createTestTui(), createTestTheme(), () => {}, { refreshMs: 0 });
		try {
			const body = renderRows(component).join("\n");
			assert.doesNotMatch(body, /forged row/);
			assert.match(body, /workflow/);
		} finally {
			component.dispose();
		}
	});

	it("groups each pipeline stage under its phase and counts every stage run in phase totals", () => {
		const root = tmpRegistry();
		seedRun(root, { runId: "wf", mode: "parallel", workflow: true, rootRunId: "wf", startedAt: 1000 });
		seedRun(root, {
			runId: "loose",
			agentName: "loose-run",
			parentRunId: "wf",
			rootRunId: "wf",
			phaseIndex: 1,
			phaseTitle: "Inspect",
			startedAt: 1100,
		});
		seedRun(root, {
			runId: "stage-one",
			agentName: "stage-one",
			state: "running",
			parentRunId: "wf",
			rootRunId: "wf",
			phaseIndex: 1,
			phaseTitle: "Inspect",
			pipeline: {
				id: "pipe",
				name: "Osnutki",
				itemIndex: 0,
				stageIndex: 0,
				itemLabel: "widget",
				stageTitle: "osnutek",
				stageCount: 2,
				itemCount: 2,
			},
			startedAt: 1200,
		});
		seedRun(root, {
			runId: "stage-one-b",
			agentName: "stage-one",
			parentRunId: "wf",
			rootRunId: "wf",
			phaseIndex: 1,
			phaseTitle: "Inspect",
			pipeline: {
				id: "pipe",
				name: "Osnutki",
				itemIndex: 1,
				stageIndex: 0,
				itemLabel: "gadget",
				stageTitle: "osnutek",
				stageCount: 2,
				itemCount: 2,
			},
			startedAt: 1250,
		});
		seedRun(root, {
			runId: "stage-two",
			agentName: "stage-two",
			parentRunId: "wf",
			rootRunId: "wf",
			phaseIndex: 2,
			phaseTitle: "Confirm",
			pipeline: {
				id: "pipe",
				name: "Osnutki",
				itemIndex: 1,
				stageIndex: 1,
				itemLabel: "gadget",
				stageTitle: "verifikacija",
				stageCount: 2,
				itemCount: 2,
			},
			startedAt: 1300,
		});

		const component = new SubagentsStatusComponent(createTestTui(), createTestTheme(), () => {}, { refreshMs: 0 });
		try {
			const lines = leftRows(component);
			const body = lines.join("\n");
			assert.match(body, /Phase 1: Inspect · 2\/3/);
			assert.match(body, /⋮ Osnutki · 1\/2 items/);
			assert.doesNotMatch(body, /⋮ Osnutki · (?:osnutek|verifikacija|stage) \d\/\d/);
			assert.match(body, /Phase 2: Confirm · 1\/1/);
			assert.match(body, /⋮ Osnutki · 1\/2 items · 1 waiting/);
			assert.equal(lines.filter((line) => /widget/.test(line)).length, 1);
			assert.equal(lines.filter((line) => /gadget/.test(line)).length, 2);
			assert.doesNotMatch(body, /\+\d+ pipeline stages|\[\d+\]|✓◈/);
		} finally {
			component.dispose();
		}
	});

	it("emits distinct pipeline groups with unique keys when two pipelines share a phase", () => {
		const root = tmpRegistry();
		seedRun(root, { runId: "wf", mode: "parallel", workflow: true, rootRunId: "wf", startedAt: 1000 });
		for (const [index, pipelineId] of ["alpha", "beta"].entries()) {
			seedRun(root, {
				runId: `${pipelineId}-run`,
				agentName: "review",
				parentRunId: "wf",
				rootRunId: "wf",
				phaseIndex: 1,
				phaseTitle: "Inspect",
				pipeline: { id: pipelineId, itemIndex: 0, stageIndex: 0, stageCount: 1, itemCount: 1 },
				startedAt: 1100 + index,
			});
		}
		const entries = readAllEntries();
		const rows = deriveDisplayRows(
			entries.map((entry) => ({ ownership: "foreign", run: runViewFromRegistryEntry(entry, entries) })),
			new Set(),
		);
		const groups = rows.filter((row) => row.kind === "pipelineGroup");
		assert.equal(groups.length, 2);
		assert.deepEqual(
			groups.map((group) => group.name),
			["pipeline 1", "pipeline 2"],
			"unnamed pipelines are numbered in first-seen order within the phase",
		);
		assert.equal(new Set(rows.map((row) => `${row.kind}:${JSON.stringify(row)}`)).size > 0, true);
		const keys = rows.map((row) =>
			row.kind === "run"
				? `run:${row.run.run.id}`
				: row.kind === "phase"
					? `wf:${row.workflowId}:phase:${row.phaseIndex}`
					: `wf:${row.workflowId}:phase:${row.phaseIndex}:pipe:${row.pipelineId}:stage:${row.stageIndex}`,
		);
		assert.equal(new Set(keys).size, keys.length, "every dashboard row key stays unique");
	});
});
