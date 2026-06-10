import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { buildWidgetLines } from "../../render.ts";
import { SubagentsStatusComponent } from "../../subagents-status.ts";
import { appendRunEntry, setRegistryPathForTests, type RunsRegistryEntry } from "../../runs-registry.ts";

type StatusTui = ConstructorParameters<typeof SubagentsStatusComponent>[0];
type StatusTheme = ConstructorParameters<typeof SubagentsStatusComponent>[1];

const tmpRoots: string[] = [];

function tmpRegistry(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-parallel-flat-"));
	tmpRoots.push(root);
	setRegistryPathForTests(path.join(root, "registry", "runs-index.jsonl"));
	return root;
}

function createTestTui(): StatusTui {
	return { requestRender: () => {}, terminal: { rows: 48 } } as StatusTui;
}

function createTaggingTheme(): StatusTheme {
	return {
		fg: (token: string, text: string) => `<${token}>${text}</${token}>`,
		bg: (_token: string, text: string) => text,
	} as StatusTheme;
}

function stripBorders(line: string): string {
	return line.replace(/^│/, "").replace(/│$/, "").trim();
}

function leftRows(component: SubagentsStatusComponent): string[] {
	return component.render(180).map((line) => {
		const normalized = line.replace(/<dim>│<\/dim>/g, "│");
		const unbordered = normalized.replace(/^│/, "").replace(/│$/, "").trim();
		return unbordered.split("│")[0] ?? unbordered;
	});
}

interface SeedRun {
	runId: string;
	agentName?: string;
	mode?: "single" | "chain" | "parallel";
	state?: "running" | "complete";
	label?: string;
	parentRunId?: string;
	rootRunId?: string;
	startedAt: number;
}

function seedRun(root: string, entry: SeedRun): void {
	const runRecordDir = path.join(root, "runs", entry.runId);
	fs.mkdirSync(runRecordDir, { recursive: true });
	const state = entry.state ?? "running";
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
		cwd: root,
		startedAt: entry.startedAt,
	} as RunsRegistryEntry);
}

afterEach(() => {
	setRegistryPathForTests(null);
	for (const root of tmpRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("dashboard parallel flat presentation", () => {
	it("hides parallel containers while rendering children flat with batch markers and pending delivery", () => {
		const root = tmpRegistry();
		seedRun(root, { runId: "batch", mode: "parallel", label: "parallel group", rootRunId: "batch", startedAt: 1000 });
		seedRun(root, { runId: "done", agentName: "explorer", parentRunId: "batch", rootRunId: "batch", state: "complete", startedAt: 1100 });
		seedRun(root, { runId: "live", agentName: "qa", parentRunId: "batch", rootRunId: "batch", state: "running", startedAt: 1200 });

		const component = new SubagentsStatusComponent(createTestTui(), createTaggingTheme(), () => {}, { refreshMs: 0 });
		try {
			const rows = leftRows(component);
			const body = rows.join("\n");
			assert.doesNotMatch(body, /parallel group/);
			assert.doesNotMatch(body, /▾ parallel/);
			const done = rows.find((line) => line.includes("explorer") && line.includes("∥")) ?? "";
			const live = rows.find((line) => line.includes("qa") && line.includes("∥")) ?? "";
			assert.ok(done, "expected complete child row");
			assert.ok(live, "expected running child row");
			assert.doesNotMatch(done, /└─/);
			assert.doesNotMatch(live, /└─/);
			assert.match(done, /∥ /);
			assert.match(live, /∥ /);
			assert.match(done, /<accent>✓<\/accent>/);
		} finally {
			component.dispose();
		}
	});

	it("hides parallel containers in the widget while keeping children at top-level depth", () => {
		const theme = createTaggingTheme();
		const lines = buildWidgetLines([
			{ asyncId: "batch", status: "running", mode: "parallel", agents: ["explorer", "qa"], currentAgent: "qa", startedAt: Date.now() - 1000 },
			{ asyncId: "child-a", parentRunId: "batch", status: "running", mode: "single", agents: ["explorer"], currentAgent: "explorer", startedAt: Date.now() - 500 },
			{ asyncId: "child-b", parentRunId: "batch", status: "running", mode: "single", agents: ["qa"], currentAgent: "qa", startedAt: Date.now() - 400 },
		] as any, theme, 120);

		const body = lines.join("\n");
		assert.doesNotMatch(body, /parallel/);
		assert.match(body, /explorer/);
		assert.match(body, /qa/);
		for (const line of lines.filter((line) => /explorer|qa/.test(line))) {
			assert.doesNotMatch(line, /  [├└]─/);
		}
	});
});
