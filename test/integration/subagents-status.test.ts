import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderSubagentResult } from "../../src/surfaces/render-result.ts";
import {
	expandOverlayByRootRunId,
	foregroundRunsFromState,
	type ForegroundRunSummary,
	SubagentsStatusComponent,
} from "../../src/surfaces/subagents-status.ts";
import type { AsyncRunOverlayData, AsyncRunSummary } from "../../src/state/async-status.ts";
import { appendRunEntry, setRegistryPathForTests } from "../../src/state/runs-registry.ts";
import type { AgentProgress, SubagentState } from "../../src/protocol/types.ts";

type StatusTui = ConstructorParameters<typeof SubagentsStatusComponent>[0];
type StatusTheme = ConstructorParameters<typeof SubagentsStatusComponent>[1];

let testsRun = 0;
afterEach(() => {
	testsRun++;
});
after(() => {
	process.stdout.write(`# tests ${testsRun}\n`);
});

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function createRun(
	id: string,
	state: AsyncRunSummary["state"],
	overrides: Partial<AsyncRunSummary> = {},
): AsyncRunSummary {
	const base: AsyncRunSummary = {
		id,
		asyncDir: `/tmp/${id}`,
		state,
		lastActivityAt: Date.now() - 1500,
		currentTool: state === "running" ? "bash" : undefined,
		currentToolStartedAt: state === "running" ? Date.now() - 1000 : undefined,
		mode: "single",
		cwd: `/tmp/${id}`,
		startedAt: Date.now() - 5000,
		lastUpdate: state === "running" ? Date.now() - 500 : Date.now() - 1000,
		endedAt: state === "running" ? undefined : Date.now() - 1000,
		currentStep: 0,
		steps: [
			{
				index: 0,
				agent: "waiter",
				status: state === "running" ? "running" : "complete",
				currentTool: state === "running" ? "bash" : undefined,
				currentToolStartedAt: state === "running" ? Date.now() - 1000 : undefined,
				tokens: { input: 100, output: 50, total: 150 },
			},
		],
		totalTokens: { input: 100, output: 50, total: 150 },
		outputFile: `/tmp/${id}/output-0.log`,
		sessionFile: `/tmp/${id}/session.jsonl`,
	};
	return { ...base, ...overrides };
}

function createSyncRun(id = "sync-a", asyncDir?: string): ForegroundRunSummary {
	return {
		id,
		steps: [],
		...(asyncDir ? { asyncDir } : {}),
		state: "running",
		mode: "parallel",
		startedAt: Date.now() - 6000,
		lastUpdate: Date.now() - 250,
		currentAgent: "reviewer",
		currentIndex: 1,
		currentTool: "read",
		currentToolStartedAt: Date.now() - 1200,
		lastActivityAt: Date.now() - 800,
		recentTools: [{ tool: "read", args: "subagents-status.ts", endMs: Date.now() - 500 }],
		recentOutput: ["sync compact tail line"],
	};
}

function createTestTui(requestRender: () => void): StatusTui {
	return { requestRender } as StatusTui;
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

function makeEventsFile(dir: string, events: Array<Record<string, unknown>>): void {
	const stepStarts = events.filter((event) => event.type === "subagent.step.started");
	const steps: Array<{
		agent: string;
		status: string;
		startedAt?: number;
		endedAt?: number;
		durationMs?: number;
		tokens?: { input: number; output: number; total: number };
	}> =
		stepStarts.length > 0
			? stepStarts.map((event) => {
					const stepIndex = typeof event.stepIndex === "number" ? event.stepIndex : 0;
					const end = events.find(
						(candidate) =>
							(candidate.type === "subagent.step.completed" ||
								candidate.type === "subagent.step.failed") &&
							candidate.stepIndex === stepIndex,
					);
					const tokens = end?.tokens as { total?: unknown } | undefined;
					return {
						agent: typeof event.agent === "string" ? event.agent : "agent",
						status: typeof end?.status === "string" ? end.status : "running",
						startedAt: typeof event.ts === "number" ? event.ts : undefined,
						endedAt: typeof end?.ts === "number" ? end.ts : undefined,
						durationMs: typeof end?.durationMs === "number" ? end.durationMs : undefined,
						tokens:
							tokens && typeof tokens.total === "number"
								? { input: 0, output: tokens.total, total: tokens.total }
								: undefined,
					};
				})
			: [{ agent: "agent", status: "running" }];
	fs.writeFileSync(
		path.join(dir, "status.json"),
		JSON.stringify({
			runId: path.basename(dir),
			mode: "single",
			state: "running",
			startedAt: steps[0]?.startedAt ?? 1,
			lastUpdate: steps[0]?.endedAt ?? Date.now(),
			steps,
		}),
		"utf-8",
	);

	const toolNames = new Map<string, string>();
	const records: Array<Record<string, unknown>> = [
		{
			type: "session",
			version: 3,
			id: path.basename(dir),
			timestamp: new Date(steps[0]?.startedAt ?? 1).toISOString(),
			cwd: dir,
		},
	];
	for (const event of events) {
		if (event.type === "tool_execution_start") {
			const id =
				typeof event.toolCallId === "string"
					? event.toolCallId
					: `${event.toolName ?? "tool"}-${event.observedAt ?? Date.now()}`;
			if (typeof event.toolName === "string") toolNames.set(id, event.toolName);
			records.push({
				type: "message",
				timestamp: new Date(typeof event.observedAt === "number" ? event.observedAt : Date.now()).toISOString(),
				message: {
					role: "assistant",
					content: [{ type: "tool_use", id, name: event.toolName, input: event.args }],
				},
			});
			continue;
		}
		if (event.type === "tool_execution_end") {
			const id = typeof event.toolCallId === "string" ? event.toolCallId : "";
			if (id || toolNames.size > 0)
				records.push({
					type: "message",
					timestamp: new Date(
						typeof event.observedAt === "number" ? event.observedAt : Date.now(),
					).toISOString(),
					message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] },
				});
			continue;
		}
		if (event.type === "message_end") {
			const message = event.message as { content?: unknown } | undefined;
			records.push({
				type: "message",
				timestamp: new Date(typeof event.ts === "number" ? event.ts : Date.now()).toISOString(),
				message: { role: "assistant", content: message?.content ?? [] },
			});
		}
	}
	const runDir = path.join(dir, "run-0");
	fs.mkdirSync(runDir, { recursive: true });
	fs.writeFileSync(path.join(runDir, "session.jsonl"), records.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

describe("SubagentsStatusComponent", () => {
	it("shows 'No subagent runs' when nothing is active", () => {
		const component = new SubagentsStatusComponent(
			createTestTui(() => {}),
			createTestTheme(),
			() => {},
			{
				listRunsForOverlay: () => ({ active: [], recent: [] }),
				refreshMs: 1000,
			},
		);

		try {
			const output = component.render(120).join("\n");
			assert.match(output, /No subagent runs/);
			assert.match(output, /Subagent runs · 0 total/);
		} finally {
			component.dispose();
		}
	});

	it("renders header, a left-pane row, and right-pane event log for a single async run", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-status-"));
		try {
			makeEventsFile(dir, [
				{ type: "subagent.step.started", stepIndex: 0, agent: "waiter", ts: 1000 },
				{
					type: "tool_execution_start",
					subagentStepIndex: 0,
					toolName: "bash",
					toolCallId: "t1",
					args: { cmd: "ls" },
					observedAt: 1500,
				},
				{ type: "tool_execution_end", subagentStepIndex: 0, toolCallId: "t1", observedAt: 1900 },
				{
					type: "subagent.step.completed",
					stepIndex: 0,
					agent: "waiter",
					ts: 2000,
					durationMs: 1000,
					tokens: { total: 150 },
					status: "completed",
				},
			]);
			const run = createRun("run-a", "running", { asyncDir: dir });
			const component = new SubagentsStatusComponent(
				createTestTui(() => {}),
				createTestTheme(),
				() => {},
				{
					listRunsForOverlay: () => ({ active: [run], recent: [] }),
					refreshMs: 1000,
				},
			);

			try {
				const output = component.render(120).join("\n");
				assert.match(output, /Subagent runs · 1 total/);
				// The running glyph (◈) carries the state; the redundant "running" word is gone.
				assert.match(output, /> ◈ waiter/);
				assert.doesNotMatch(output, /─── Step 1: waiter ───/);
				assert.match(output, /waiter\s+running ·/);
				assert.match(output, /→ bash · 400ms/);
				assert.match(output, /│ {2}ls\s/);
				assert.doesNotMatch(output, /─── done · completed · 150t · 1000ms ───/);
				// paneOverlay owns standard action legend rows; custom dashboard actions are appended.
				assert.match(output, /tab\/←\/→\s+focus/);
				assert.match(output, /j\/k\s+select/);
				assert.match(output, /u\/d\s+half-page/);
				assert.doesNotMatch(output, /pgup\/pgdn\s+page/);
				assert.match(output, /y\s+copy id/);
				assert.match(output, /f\s+copy dir/);
				assert.match(output, /return\/o\s+collapse group/);
				assert.match(output, /a\s+all sessions/);
				assert.match(output, /s\s+sidebar/);
				assert.match(output, /q\/esc\s+close/);
			} finally {
				component.dispose();
			}
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("collapses the run list with 's' and gives the detail pane full width", () => {
		const running = createRun("run-collapse", "running", { startedAt: 2000 });
		const component = new SubagentsStatusComponent(
			createTestTui(() => {}),
			createTestTheme(),
			() => {},
			{
				listRunsForOverlay: () => ({ active: [running], recent: [] }),
				refreshMs: 1000,
			},
		);

		try {
			// Expanded: the run list row is visible in the left pane.
			const expanded = component.render(120).join("\n");
			assert.match(expanded, /◈ waiter/, "list row visible while expanded");
			assert.match(expanded, /Subagent runs · 1 total/, "primary title visible while expanded");

			// Collapse the sidebar.
			component.handleInput("s");
			const collapsed = component.render(120).join("\n");
			// The left list (its primary title) is gone; the detail pane remains.
			assert.doesNotMatch(collapsed, /Subagent runs · 1 total/, "primary title hidden when collapsed");
			// The detail pane still renders (its title carries the selected run's agent + state).
			assert.match(collapsed, /waiter/, "detail pane title still renders when collapsed");
			// The reopen hint surfaces in the always-visible detail footer (the primary
			// legend that normally carries it is gone while collapsed).
			assert.match(collapsed, /s sidebar/, "reopen hint shown in the bottom bar when collapsed");

			// Toggle back: the list returns.
			component.handleInput("s");
			const reexpanded = component.render(120).join("\n");
			assert.match(reexpanded, /Subagent runs · 1 total/, "primary title returns after re-expand");
		} finally {
			component.dispose();
		}
	});

	it("uses effective transcript display keys and keeps tool state aligned with Pi", () => {
		const setterValues: boolean[] = [];
		const component = new SubagentsStatusComponent(
			createTestTui(() => {}),
			createTestTheme(),
			() => {},
			{
				listRunsForOverlay: () => ({ active: [], recent: [] }),
				refreshMs: 1000,
				keybindings: {
					getKeys: (binding) => {
						if (binding === "app.tools.expand") return ["x"];
						if (binding === "app.thinking.toggle") return ["z"];
						return [];
					},
				},
				getToolsExpanded: () => true,
				setToolsExpanded: (expanded) => setterValues.push(expanded),
			},
		);

		try {
			const legend = component.render(120).join("\n");
			assert.match(legend, /x\s+tools/);
			assert.match(legend, /z\s+thinking/);
			assert.doesNotMatch(legend, /ctrl\+o\s+tools|ctrl\+t\s+thinking/);

			component.handleInput("\x0f");
			assert.deepEqual(setterValues, [], "the default chord is inactive after a remap");

			component.handleInput("x");
			assert.deepEqual(setterValues, [false], "the getter seeds the initial expanded state");

			component.handleInput("\t");
			component.handleInput("x");
			assert.deepEqual(setterValues, [false, true], "the action also works while the detail pane has focus");

			component.handleInput("z");
			component.handleInput("z");
			assert.deepEqual(setterValues, [false, true], "thinking changes remain dashboard-local");
		} finally {
			component.dispose();
		}
	});

	it("sorts running before complete and places cursor on the first row by default", () => {
		const running = createRun("run-running", "running", { startedAt: 2000 });
		const complete = createRun("run-done", "complete", { startedAt: 1000 });
		const component = new SubagentsStatusComponent(
			createTestTui(() => {}),
			createTestTheme(),
			() => {},
			{
				listRunsForOverlay: () => ({ active: [running], recent: [complete] }),
				refreshMs: 1000,
			},
		);

		try {
			const output = component.render(120);
			const bodyLines = output.slice(1, -1).map(stripBorders);
			// State is conveyed by the row glyph now (◈ running, ✓ complete), not a word.
			const runIndex = bodyLines.findIndex((line) => line.includes("◈"));
			const doneIndex = bodyLines.findIndex((line) => line.includes("✓"));
			assert.ok(runIndex >= 0 && doneIndex >= 0, "both rows present");
			assert.ok(runIndex < doneIndex, "running row sorts above complete row");
			assert.match(bodyLines[runIndex]!, /^> /);
			assert.doesNotMatch(bodyLines[doneIndex]!, /^> /);
		} finally {
			component.dispose();
		}
	});

	it("shows an interrupted run as a terminal history row", () => {
		const endedAt = Date.now() - 1000;
		const interrupted = createRun("run-interrupted", "interrupted", {
			endedAt,
			lastUpdate: endedAt,
			phase: "streaming_text",
			phaseStartedAt: Date.now() - 30_000,
			steps: [{ index: 0, agent: "waiter", status: "interrupted" }],
		});
		const component = new SubagentsStatusComponent(
			createTestTui(() => {}),
			createTestTheme(),
			() => {},
			{
				listRunsForOverlay: () => ({ active: [], recent: [interrupted] }),
				refreshMs: 1000,
			},
		);

		try {
			const lines = component.render(180).map(stripBorders);
			const row = lines.find((line) => line.includes("■") && line.includes("waiter"));
			assert.ok(row, `interrupted row should render; got:\n${lines.join("\n")}`);
			// The ■ glyph carries the interrupted state; the redundant word is dropped.
			assert.match(row, /■ .*waiter/);
			assert.doesNotMatch(row, /· interrupted/);
			assert.doesNotMatch(row, /thinking|streaming|writing|waiting \d/);

			const d = new Date(endedAt);
			const stamp = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
			assert.match(row, new RegExp(`\\b${stamp}\\b`));
		} finally {
			component.dispose();
		}
	});

	it("buckets interrupted and skipped expanded child runs into recent not active", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-status-registry-"));
		const registryPath = path.join(dir, "runs-index.jsonl");
		setRegistryPathForTests(registryPath);
		try {
			const parent = createRun("parent-run", "running", { asyncDir: path.join(dir, "parent-run") });
			const interruptedDir = path.join(dir, "child-interrupted");
			const skippedDir = path.join(dir, "child-skipped");
			fs.mkdirSync(interruptedDir, { recursive: true });
			fs.mkdirSync(skippedDir, { recursive: true });
			const endedAt = Date.now() - 1000;
			for (const [runId, runDir, state] of [
				["child-interrupted", interruptedDir, "interrupted"],
				["child-skipped", skippedDir, "skipped"],
			] as const) {
				fs.writeFileSync(
					path.join(runDir, "status.json"),
					JSON.stringify({
						runId,
						parentRunId: "parent-run",
						mode: "single",
						state,
						startedAt: endedAt - 4000,
						lastUpdate: endedAt,
						endedAt,
						cwd: "/proj/here",
						steps: [{ index: 0, agent: "waiter", status: state }],
					}),
					"utf-8",
				);
			}
			for (const entry of [
				{
					runId: "parent-run",
					runRecordDir: parent.asyncDir!,
					mode: "single",
					source: "async",
					agentName: "waiter",
					rootRunId: "parent-run",
					cwd: "/proj/here",
					startedAt: parent.startedAt,
				},
				{
					runId: "child-interrupted",
					runRecordDir: interruptedDir,
					mode: "single",
					source: "async",
					agentName: "waiter",
					parentRunId: "parent-run",
					rootRunId: "parent-run",
					cwd: "/proj/here",
					startedAt: endedAt - 4000,
				},
				{
					runId: "child-skipped",
					runRecordDir: skippedDir,
					mode: "single",
					source: "async",
					agentName: "waiter",
					parentRunId: "parent-run",
					rootRunId: "parent-run",
					cwd: "/proj/here",
					startedAt: endedAt - 3000,
				},
			] as const) {
				appendRunEntry(entry);
			}

			const overlay = expandOverlayByRootRunId({ active: [parent], recent: [] }, { sessionCwd: "/proj/here" });
			assert.deepEqual(
				overlay.active.map((run) => run.id),
				["parent-run"],
			);
			assert.deepEqual(
				new Set(overlay.recent.map((run) => run.id)),
				new Set(["child-interrupted", "child-skipped"]),
			);
		} finally {
			setRegistryPathForTests(null);
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("j moves selection down and k moves it up, bounded at edges", () => {
		const a = createRun("run-a", "running");
		const b = createRun("run-b", "complete");
		const component = new SubagentsStatusComponent(
			createTestTui(() => {}),
			createTestTheme(),
			() => {},
			{
				listRunsForOverlay: () => ({ active: [a], recent: [b] }),
				refreshMs: 1000,
			},
		);

		try {
			const initial = component.render(120).join("\n");
			assert.match(initial, /> .*run-a-agent|> ◈ waiter/);

			component.handleInput("j");
			const afterDown = component.render(120);
			const bodyAfterDown = afterDown.slice(1, -1).map(stripBorders);
			const completeRow = bodyAfterDown.find((line) => line.includes("✓"));
			assert.ok(
				completeRow && completeRow.startsWith(">"),
				`cursor should be on complete row after j; got: ${completeRow}`,
			);

			// j past the end should stay at the bottom.
			component.handleInput("j");
			const bodyAfterDown2 = component.render(120).slice(1, -1).map(stripBorders);
			const completeRow2 = bodyAfterDown2.find((line) => line.includes("✓"));
			assert.ok(completeRow2 && completeRow2.startsWith(">"), "selection bounded at last row");

			component.handleInput("k");
			const bodyAfterUp = component.render(120).slice(1, -1).map(stripBorders);
			const runningRow = bodyAfterUp.find((line) => line.includes("◈"));
			assert.ok(runningRow && runningRow.startsWith(">"), "k moves selection up");

			// k past the top should stay at row 0.
			component.handleInput("k");
			const bodyAfterUp2 = component.render(120).slice(1, -1).map(stripBorders);
			const runningRow2 = bodyAfterUp2.find((line) => line.includes("◈"));
			assert.ok(runningRow2 && runningRow2.startsWith(">"), "selection bounded at first row");
		} finally {
			component.dispose();
		}
	});

	it("renders step-start, tool with duration, step-end, and final-text for the selected run", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-status-events-"));
		try {
			makeEventsFile(dir, [
				{ type: "subagent.step.started", stepIndex: 0, agent: "planner", ts: 1000 },
				{
					type: "tool_execution_start",
					subagentStepIndex: 0,
					toolName: "read",
					toolCallId: "t1",
					args: { path: "a.ts" },
					observedAt: 1100,
				},
				{ type: "tool_execution_end", subagentStepIndex: 0, toolCallId: "t1", observedAt: 1350 },
				{
					type: "message_end",
					subagentStepIndex: 0,
					subagentAgent: "planner",
					message: { role: "assistant", content: [{ type: "text", text: "Wrapped final answer text." }] },
				},
				{
					type: "subagent.step.completed",
					stepIndex: 0,
					agent: "planner",
					ts: 1400,
					durationMs: 400,
					tokens: { total: 42 },
					status: "completed",
				},
			]);
			const run = createRun("run-e", "running", { asyncDir: dir });
			const component = new SubagentsStatusComponent(
				createTestTui(() => {}),
				createTestTheme(),
				() => {},
				{
					listRunsForOverlay: () => ({ active: [run], recent: [] }),
					refreshMs: 1000,
				},
			);

			try {
				const lines = component.render(160).map(stripBorders);
				const joined = lines.join("\n");
				const stepIdx = lines.findIndex((line) => line.includes("Step 1: planner"));
				const toolIdx = lines.findIndex((line) => /→ read · 250ms/.test(line));
				const finalIdx = lines.findIndex((line) => line.includes("Wrapped final answer text."));
				const endIdx = lines.findIndex((line) => line.includes("done · completed · 42t · 400ms"));
				assert.equal(stepIdx, -1, `step header must be removed:\n${joined}`);
				assert.equal(endIdx, -1, `step footer must be removed:\n${joined}`);
				assert.ok(toolIdx >= 0 && finalIdx > toolIdx, `order wrong: ${toolIdx}/${finalIdx}\n${joined}`);
			} finally {
				component.dispose();
			}
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("renders '(no events yet)' in the right pane for a foreground sync run without events", () => {
		const component = new SubagentsStatusComponent(
			createTestTui(() => {}),
			createTestTheme(),
			() => {},
			{
				listRunsForOverlay: () => ({ active: [], recent: [] }),
				listForegroundRuns: () => [createSyncRun()],
				refreshMs: 1000,
			},
		);

		try {
			const output = component.render(120).join("\n");
			assert.match(output, /\(no events yet\)/);
			assert.match(output, /◈ .*reviewer/);
		} finally {
			component.dispose();
		}
	});

	it("dedupes in-flight sync disk mirrors and keeps completed disk sync runs visible", () => {
		const id = `sync-dedupe-${process.pid}-${Date.now()}`;
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-status-sync-dedupe-"));
		fs.mkdirSync(dir, { recursive: true });
		try {
			fs.writeFileSync(
				path.join(dir, "status.json"),
				JSON.stringify({
					runId: id,
					mode: "single",
					state: "complete",
					startedAt: 1,
					endedAt: 2,
					steps: [{ agent: "syncer", status: "complete" }],
				}),
				"utf-8",
			);
			makeEventsFile(dir, [
				{ type: "subagent.step.started", stepIndex: 0, agent: "syncer", ts: 1 },
				{
					type: "message_end",
					subagentStepIndex: 0,
					subagentAgent: "syncer",
					message: { role: "assistant", content: [{ type: "text", text: "sync final" }] },
				},
				{ type: "subagent.step.completed", stepIndex: 0, agent: "syncer", ts: 2, status: "completed" },
			]);
			let foreground = [createSyncRun(id, dir)];
			const component = new SubagentsStatusComponent(
				createTestTui(() => {}),
				createTestTheme(),
				() => {},
				{
					listRunsForOverlay: () => ({
						active: [],
						recent: [
							createRun(id, "complete", {
								asyncDir: dir,
								steps: [{ index: 0, agent: "syncer", status: "complete" }],
							}),
						],
					}),
					listForegroundRuns: () => foreground,
					refreshMs: 1000,
				},
			);
			try {
				let output = component.render(160).join("\n");
				assert.match(output, /Subagent runs · 1 total/);
				assert.match(output, /sync final/);
				foreground = [];
				component.setShowAllSessions(true);
				output = component.render(160).join("\n");
				assert.match(output, /Subagent runs · 1 total/);
				assert.match(output, /complete/);
			} finally {
				component.dispose();
			}
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("indents child runs directly after their parent", () => {
		const parent = createRun("parent-run", "running", {
			startedAt: 100,
			steps: [{ index: 0, agent: "parent", status: "running" }],
		});
		const sibling = createRun("sibling-run", "running", {
			startedAt: 300,
			steps: [{ index: 0, agent: "sibling", status: "running" }],
		});
		const child = createRun("child-run", "running", {
			parentRunId: "parent-run",
			startedAt: 200,
			steps: [{ index: 0, agent: "child", status: "running" }],
		});
		const component = new SubagentsStatusComponent(
			createTestTui(() => {}),
			createTestTheme(),
			() => {},
			{
				listRunsForOverlay: () => ({ active: [sibling, child, parent], recent: [] }),
				refreshMs: 1000,
			},
		);
		try {
			const rows = component
				.render(160)
				.slice(1, -1)
				.map(stripBorders)
				.map((line) => line.split("│")[0] ?? line)
				.filter((line) => line.includes("◈"));
			const parentIndex = rows.findIndex((line) => line.includes("parent"));
			const childIndex = rows.findIndex((line) => line.includes("child"));
			assert.equal(childIndex, parentIndex + 1);
			assert.match(rows[childIndex]!, /└─/);
		} finally {
			component.dispose();
		}
	});

	it("keeps selection sticky by id across refreshes", async () => {
		const a = createRun("run-a", "running");
		const b = createRun("run-b", "running");
		let snapshot: AsyncRunOverlayData = { active: [a, b], recent: [] };
		const component = new SubagentsStatusComponent(
			createTestTui(() => {}),
			createTestTheme(),
			() => {},
			{
				listRunsForOverlay: () => snapshot,
				refreshMs: 10,
			},
		);

		try {
			component.handleInput("j");
			const before = component.render(120).join("\n");
			assert.match(before, />.*run-b agent|> ◈ waiter/);
			snapshot = { active: [createRun("run-c", "running"), b, a], recent: [] };
			await wait(25);
			const lines = component.render(120).map(stripBorders);
			// The previously selected run was run-b (second of two waiter rows). After refresh
			// the order of rows changes; cursor should still be on a running waiter row,
			// not on the brand-new run-c row at index 0.
			const cursorRowIndex = lines.findIndex((line) => line.startsWith(">"));
			assert.ok(
				cursorRowIndex > 0,
				`cursor should not reset to the top after refresh; got index ${cursorRowIndex}`,
			);
		} finally {
			component.dispose();
		}
	});

	it("q and escape both call the done callback", () => {
		let doneCalls = 0;
		const component = new SubagentsStatusComponent(
			createTestTui(() => {}),
			createTestTheme(),
			() => {
				doneCalls++;
			},
			{
				listRunsForOverlay: () => ({ active: [createRun("run-a", "running")], recent: [] }),
				refreshMs: 1000,
			},
		);

		try {
			component.handleInput("q");
			assert.equal(doneCalls, 1);
			component.handleInput("\u001b");
			assert.equal(doneCalls, 2);
		} finally {
			component.dispose();
		}
	});

	it("smoke-renders the two-pane layout with two mock runs", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-status-smoke-"));
		try {
			makeEventsFile(dir, [{ type: "subagent.step.started", stepIndex: 0, agent: "scout", ts: 1000 }]);
			const running = createRun("run-running", "running", { asyncDir: dir, startedAt: 2000 });
			const done = createRun("run-done", "complete", { startedAt: 1000 });
			const component = new SubagentsStatusComponent(
				createTestTui(() => {}),
				createTestTheme(),
				() => {},
				{
					listRunsForOverlay: () => ({ active: [running], recent: [done] }),
					refreshMs: 1000,
				},
			);

			try {
				const lines = component.render(120);
				for (const line of lines) {
					assert.ok(visibleWidth(line) <= 120, `line too wide: ${visibleWidth(line)} ${line}`);
				}
				const joined = lines.join("\n");
				assert.match(joined, /Subagent runs · 2 total/);
				assert.doesNotMatch(joined, /Step 1: scout/);
				assert.match(joined, /◈/);
				assert.match(joined, /✓/);
			} finally {
				component.dispose();
			}
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps top border within terminal width with long selected title and tail", () => {
		const run = createRun("run-wide-title", "running", {
			label: "long selected subagent title ".repeat(4),
			currentTool: "task_manage",
		});
		const component = new SubagentsStatusComponent(
			createTestTui(() => {}),
			createTestTheme(),
			() => {},
			{
				listRunsForOverlay: () => ({ active: [run], recent: [] }),
				refreshMs: 1000,
			},
		);

		try {
			for (const line of component.render(120)) {
				assert.ok(visibleWidth(line) <= 120, `line too wide: ${visibleWidth(line)} ${line}`);
			}
		} finally {
			component.dispose();
		}
	});

	it("auto-refresh requests render and stops after dispose", async () => {
		let renderRequests = 0;
		const component = new SubagentsStatusComponent(
			createTestTui(() => {
				renderRequests++;
			}),
			createTestTheme(),
			() => {},
			{
				listRunsForOverlay: () => ({ active: [createRun("run-a", "running")], recent: [] }),
				refreshMs: 10,
			},
		);

		await wait(25);
		assert.ok(renderRequests >= 1, "expected auto-refresh to request a render");
		component.dispose();
		const before = renderRequests;
		await wait(25);
		assert.equal(renderRequests, before, "auto-refresh stops after dispose");
	});

	it("filters async runs by sessionCwd by default and shows all when toggled", () => {
		const here = createRun("run-here", "running", { cwd: "/proj/here" });
		const other = createRun("run-other", "running", { cwd: "/proj/other" });
		const unknown = createRun("run-unknown", "running", { cwd: undefined });
		const component = new SubagentsStatusComponent(
			createTestTui(() => {}),
			createTestTheme(),
			() => {},
			{
				listRunsForOverlay: () => ({ active: [here, other, unknown], recent: [] }),
				refreshMs: 1000,
				sessionCwd: "/proj/here",
			},
		);

		try {
			const scoped = component.render(140).join("\n");
			assert.match(scoped, /Subagent runs · 1 total/);
			// In scoped mode the per-row cwd badge is suppressed (every visible run
			// shares the session cwd, so repeating it is noise). The contract here is
			// that the other-workspace runs are filtered out, not that the cwd shows.
			assert.doesNotMatch(scoped, /\[all sessions\]/);
			assert.doesNotMatch(scoped, /run-other|other/);

			component.handleInput("a");
			const all = component.render(140).join("\n");
			assert.match(all, /Subagent runs · 3 total/);
			assert.match(all, /\[all sessions\]/);
			// In all-sessions mode the cwd badge becomes essential to disambiguate.
			assert.match(all, /here/);
			assert.match(all, /other/);

			component.setShowAllSessions(false);
			const rescoped = component.render(140).join("\n");
			assert.match(rescoped, /Subagent runs · 1 total/);
		} finally {
			component.dispose();
		}
	});

	it("shows all runs when no sessionCwd is provided (no filtering)", () => {
		const a = createRun("run-a", "running", { cwd: "/proj/a" });
		const b = createRun("run-b", "running", { cwd: "/proj/b" });
		const component = new SubagentsStatusComponent(
			createTestTui(() => {}),
			createTestTheme(),
			() => {},
			{
				listRunsForOverlay: () => ({ active: [a, b], recent: [] }),
				refreshMs: 1000,
			},
		);

		try {
			const out = component.render(140).join("\n");
			assert.match(out, /Subagent runs · 2 total/);
			assert.match(out, /\[all sessions\]/);
		} finally {
			component.dispose();
		}
	});

	it("converts foreground controls from state in spawn-time order (newest first)", () => {
		const controls = new Map<
			string,
			SubagentState["foregroundControls"] extends Map<string, infer T> ? T : never
		>();
		controls.set("older", {
			runId: "older",
			mode: "single",
			startedAt: 100,
			updatedAt: 200,
			currentAgent: "scout",
		});
		controls.set("newer", {
			runId: "newer",
			mode: "parallel",
			startedAt: 200,
			updatedAt: 300,
			currentAgent: "planner",
			currentTool: "bash",
			currentToolStartedAt: 250,
		});

		const runs = foregroundRunsFromState({ foregroundControls: controls } as Pick<
			SubagentState,
			"foregroundControls"
		>);
		assert.deepEqual(
			runs.map((run) => run.id),
			["newer", "older"],
		);
		assert.equal(runs[0]?.currentTool, "bash");
	});

	describe("phase label", () => {
		function renderStatus(run: AsyncRunSummary): string {
			const component = new SubagentsStatusComponent(
				createTestTui(() => {}),
				createTestTheme(),
				() => {},
				{
					listRunsForOverlay: () => ({ active: [run], recent: [] }),
					refreshMs: 1000,
				},
			);
			try {
				return component.render(180).join("\n");
			} finally {
				component.dispose();
			}
		}

		function renderInlineProgress(progress: Partial<AgentProgress>): string {
			const widget = renderSubagentResult(
				{
					content: [{ type: "text", text: "(running...)" }],
					details: {
						mode: "single",
						results: [
							{
								agent: "worker",
								task: "work",
								exitCode: 0,
								messages: [],
								usage: { input: 0, output: 0 },
								progress: {
									index: 0,
									agent: "worker",
									status: "running",
									task: "work",
									lastActivityAt: Date.now(),
									recentTools: [],
									recentOutput: [],
									toolCount: 1,
									tokens: 0,
									durationMs: 0,
									...progress,
								},
							},
						],
					},
				},
				{ expanded: false },
				{ fg: (_name: string, value: string) => value, bold: (value: string) => value },
			);

			return widget.render(180).join("\n");
		}

		it("phase label renders thinking duration in the left pane", () => {
			const now = Date.now();
			const output = renderStatus(
				createRun("phase-thinking", "running", {
					currentTool: undefined,
					currentToolStartedAt: undefined,
					phase: "thinking",
					phaseStartedAt: now - 12_000,
				}),
			);

			assert.match(output, /thinking 12\.0s/);
		});

		it("phase label renders tool name in the left pane", () => {
			const now = Date.now();
			const output = renderStatus(
				createRun("phase-tool", "running", {
					currentTool: "bash",
					phase: "tool_running",
					phaseStartedAt: now - 45_000,
				}),
			);

			assert.match(output, /tool: bash 45\.0s/);
		});

		it("shows just 'lost' (not 'running/lost') for a force-killed run", () => {
			const output = renderStatus(
				createRun("phase-lost", "running", {
					currentTool: undefined,
					currentToolStartedAt: undefined,
					displayState: "lost",
					runnerHeartbeatAt: Date.now() - 30_000,
				}),
			);

			// displayState 'lost' is authoritative over the stale on-disk 'running' state:
			// render the lost glyph + a bare 'lost' label, never the confusing 'running/lost'.
			assert.match(output, /! .*waiter .* lost /);
			assert.doesNotMatch(output, /running\/lost/);
		});

		it("stamps a lost run with a clock time, not a frozen elapsed duration", () => {
			const died = new Date();
			died.setHours(14, 7, 0, 0);
			const output = renderStatus(
				createRun("phase-lost-stamp", "running", {
					currentTool: undefined,
					currentToolStartedAt: undefined,
					displayState: "lost",
					endedAt: undefined,
					lastUpdate: died.getTime(),
					runnerHeartbeatAt: died.getTime(),
				}),
			);

			// A lost run has no endedAt; stamp its last heartbeat as the clock time like
			// any other terminal row, rather than the frozen 'Xs' elapsed duration.
			assert.match(output, /14:07/);
			assert.doesNotMatch(output, /\d+(\.\d+)?s\b/);
		});

		it("freezes the resumed identity age once a run is terminal", () => {
			const ended = Date.now() - 60_000;
			const started = ended - 600_000; // ran for 10m, ended 1m ago
			const output = renderStatus(
				createRun("phase-resumed-age", "complete", {
					resumeCount: 1,
					startedAt: started,
					resumedAt: ended - 120_000,
					endedAt: ended,
					lastUpdate: ended,
				}),
			);

			// age must freeze at (endedAt - startedAt) = 10m0s, not keep ticking toward now
			// (the trailing 's' can be clipped at the pane border, so match the stem).
			assert.match(output, /age 10m0/);
		});

		it("phase label renders thinking in inline progress", () => {
			const output = renderInlineProgress({
				phase: "thinking",
				phaseStartedAt: Date.now() - 12_000,
			});

			assert.match(output, /thinking 12\.0s/);
		});

		it("phase label keeps current tool rendering in inline progress", () => {
			const output = renderInlineProgress({
				phase: "tool_running",
				phaseStartedAt: Date.now() - 12_000,
				currentTool: "bash",
			});

			assert.match(output, /tool: bash/);
		});
	});
});
