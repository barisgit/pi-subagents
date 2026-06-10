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
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-phase-tree-"));
	tmpRoots.push(root);
	setRegistryPathForTests(path.join(root, "registry", "runs-index.jsonl"));
	return root;
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
	mode?: "single" | "chain" | "parallel";
	state?: "running" | "complete";
	label?: string;
	parentRunId?: string;
	rootRunId?: string;
	workflow?: boolean;
	phaseIndex?: number;
	phaseTitle?: string;
	parallelGroupId?: string;
	startedAt: number;
}

function seedRun(root: string, entry: SeedRun): void {
	const runRecordDir = path.join(root, "runs", entry.runId);
	fs.mkdirSync(runRecordDir, { recursive: true });
	const state = entry.state ?? "complete";
	const terminal = state !== "running";
	if (entry.agentName) {
		fs.writeFileSync(path.join(runRecordDir, "status.json"), JSON.stringify({
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
			steps: [{ agent: entry.agentName, status: state, startedAt: entry.startedAt, ...(terminal ? { endedAt: entry.startedAt + 1 } : {}) }],
		}), "utf8");
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
	it("renders phases as selectable tree rows with child runs nested below", () => {
		const root = tmpRegistry();
		seedRun(root, { runId: "wf", mode: "parallel", workflow: true, label: "workflow", rootRunId: "wf", startedAt: 1000 });
		seedRun(root, { runId: "p1-a", agentName: "explorer", parentRunId: "wf", rootRunId: "wf", phaseIndex: 1, phaseTitle: "Phase 1: recon", parallelGroupId: "pg-1", startedAt: 1100 });
		seedRun(root, { runId: "p1-b", agentName: "review", parentRunId: "wf", rootRunId: "wf", phaseIndex: 1, phaseTitle: "Phase 1: recon", parallelGroupId: "pg-1", startedAt: 1200 });
		seedRun(root, { runId: "p2-a", agentName: "qa", parentRunId: "wf", rootRunId: "wf", phaseIndex: 2, phaseTitle: "Phase 2: verify", startedAt: 1300 });

		const component = new SubagentsStatusComponent(createTestTui(), createTestTheme(), () => {}, { refreshMs: 0 });
		try {
			const rows = leftRows(component);
			const body = rows.join("\n");
			assert.match(body, /▾ workflow · complete · 3\/3/);
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
			assert.match(collapsedWorkflow, /▸ workflow · complete · 3\/3/);
			assert.doesNotMatch(collapsedWorkflow, /Phase 1: recon/);
			assert.doesNotMatch(collapsedWorkflow, /Phase 2: verify/);
		} finally {
			component.dispose();
		}
	});

	it("renders phaseless workflow children directly under the workflow before phase groups", () => {
		const root = tmpRegistry();
		seedRun(root, { runId: "wf", mode: "parallel", workflow: true, rootRunId: "wf", startedAt: 1000 });
		seedRun(root, { runId: "phase", agentName: "qa", parentRunId: "wf", rootRunId: "wf", phaseIndex: 1, phaseTitle: "verify", startedAt: 1100 });
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
});
