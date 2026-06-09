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
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-collapse-"));
	tmpRoots.push(root);
	setRegistryPathForTests(path.join(root, "registry", "runs-index.jsonl"));
	return root;
}

function createTestTui(): StatusTui {
	return { requestRender: () => {}, terminal: { rows: 48 } } as StatusTui;
}

/** Passthrough theme: assertions read glyphs/text only. */
function createTestTheme(): StatusTheme {
	return {
		fg: (_token: string, text: string) => text,
		bg: (_token: string, text: string) => text,
	} as StatusTheme;
}

/** Token-tagging theme: assertions can distinguish color tokens. */
function createTaggingTheme(): StatusTheme {
	return {
		fg: (token: string, text: string) => `<${token}>${text}</${token}>`,
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

afterEach(() => {
	setRegistryPathForTests(null);
	for (const root of tmpRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("dashboard collapse and container rows", () => {
	it("enter collapses the selected container: children hide, inline agent summary appears", () => {
		const root = tmpRegistry();
		seedRun(root, { runId: "group-1", mode: "parallel", label: "batch", rootRunId: "group-1", startedAt: 1000 });
		seedRun(root, { runId: "child-a", agentName: "explorer", parentRunId: "group-1", rootRunId: "group-1", startedAt: 1100 });
		seedRun(root, { runId: "child-b", agentName: "qa", parentRunId: "group-1", rootRunId: "group-1", startedAt: 1200 });

		const component = new SubagentsStatusComponent(createTestTui(), createTestTheme(), () => {}, { refreshMs: 0 });
		try {
			const expanded = component.render(180).map(stripBorders).join("\n");
			assert.match(expanded, /▾ parallel · complete · 2\/2/);
			assert.match(expanded, /└─✓ .*explorer/);
			assert.match(expanded, /└─✓ .*qa/);

			// Selection starts on the newest row; move to the container row first.
			const rows = component.render(180).map(stripBorders);
			const groupRow = rows.findIndex((line) => /▾ parallel/.test(line));
			const selectedRow = rows.findIndex((line) => line.startsWith(">"));
			for (let i = 0; i < Math.abs(groupRow - selectedRow); i++) {
				component.handleInput(groupRow > selectedRow ? "j" : "k");
			}
			component.handleInput("\r");

			const collapsed = component.render(180).map(stripBorders).join("\n");
			assert.match(collapsed, /▸ parallel · complete · 2\/2/);
			assert.match(collapsed, /\(2 agents: qa, explorer\)/);
			assert.doesNotMatch(collapsed, /└─/);

			component.handleInput("\r");
			const reexpanded = component.render(180).map(stripBorders).join("\n");
			assert.match(reexpanded, /▾ parallel · complete · 2\/2/);
			assert.match(reexpanded, /└─✓ .*explorer/);
		} finally {
			component.dispose();
		}
	});

	it("running workflow container shows done/total and the current phase from its children", () => {
		const root = tmpRegistry();
		seedRun(root, { runId: "wf-1", mode: "parallel", workflow: true, label: "wf", rootRunId: "wf-1", startedAt: 1000 });
		seedRun(root, { runId: "wf-child-1", agentName: "explorer", parentRunId: "wf-1", rootRunId: "wf-1", phaseIndex: 1, phaseTitle: "recon", startedAt: 1100 });
		seedRun(root, { runId: "wf-child-2", agentName: "qa", parentRunId: "wf-1", rootRunId: "wf-1", phaseIndex: 2, phaseTitle: "verify", state: "running", startedAt: 1200 });

		const component = new SubagentsStatusComponent(createTestTui(), createTestTheme(), () => {}, { refreshMs: 0 });
		try {
			const text = component.render(180).map(stripBorders).join("\n");
			// Group state synthesized from children: one still running -> running.
			assert.match(text, /▾ workflow · Phase 2: verify · running · 1\/2/);
		} finally {
			component.dispose();
		}
	});

	it("a complete child under a still-open parallel group renders the pending-delivery accent glyph", () => {
		const root = tmpRegistry();
		seedRun(root, { runId: "pg-1", mode: "parallel", rootRunId: "pg-1", startedAt: 1000 });
		seedRun(root, { runId: "pg-done", agentName: "explorer", parentRunId: "pg-1", rootRunId: "pg-1", startedAt: 1100 });
		seedRun(root, { runId: "pg-live", agentName: "qa", parentRunId: "pg-1", rootRunId: "pg-1", state: "running", startedAt: 1200 });

		const component = new SubagentsStatusComponent(createTestTui(), createTaggingTheme(), () => {}, { refreshMs: 0 });
		try {
			const lines = component.render(220);
			// The finished child is done but its result has not been delivered to
			// the parent turn yet (rollup batching): accent ✓, not success ✓.
			// Assert on the left child row (└─) so the right-pane steps outline
			// (always success-toned) cannot mask the left-row glyph.
			const childRow = lines.find((line) => line.includes("└─") && line.includes("explorer"));
			assert.ok(childRow, "expected a └─ explorer child row");
			assert.match(childRow, /└─<\/dim><accent>✓<\/accent>/);
			assert.doesNotMatch(childRow, /└─<\/dim><success>✓<\/success>/);
		} finally {
			component.dispose();
		}
	});

	it("workflow children are never pending-delivery (script consumes results live)", () => {
		const root = tmpRegistry();
		seedRun(root, { runId: "wf-2", mode: "parallel", workflow: true, rootRunId: "wf-2", startedAt: 1000 });
		seedRun(root, { runId: "wf2-done", agentName: "explorer", parentRunId: "wf-2", rootRunId: "wf-2", phaseIndex: 1, startedAt: 1100 });
		seedRun(root, { runId: "wf2-live", agentName: "qa", parentRunId: "wf-2", rootRunId: "wf-2", phaseIndex: 2, state: "running", startedAt: 1200 });

		const component = new SubagentsStatusComponent(createTestTui(), createTaggingTheme(), () => {}, { refreshMs: 0 });
		try {
			const lines = component.render(220);
			const childRow = lines.find((line) => line.includes("└─") && line.includes("explorer"));
			assert.ok(childRow, "expected a └─ explorer child row");
			// Workflow scripts consume child results live; the left row must show
			// the terminal success ✓, never the pending-delivery accent ✓.
			assert.match(childRow, /└─<\/dim><success>✓<\/success>/);
			assert.doesNotMatch(childRow, /└─<\/dim><accent>✓<\/accent>/);
		} finally {
			component.dispose();
		}
	});
});
