import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { visibleWidth } from "@mariozechner/pi-tui";
import { foregroundRunsFromState, type ForegroundRunSummary, SubagentsStatusComponent } from "../../subagents-status.ts";
import type { AsyncRunOverlayData } from "../../async-status.ts";
import type { SubagentState } from "../../types.ts";

type StatusTui = ConstructorParameters<typeof SubagentsStatusComponent>[0];
type StatusTheme = ConstructorParameters<typeof SubagentsStatusComponent>[1];

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function createRun(id: string, state: "queued" | "running" | "complete" | "failed") {
	return {
		id,
		asyncDir: `/tmp/${id}`,
		state,
		activityState: undefined,
		lastActivityAt: Date.now() - 1500,
		currentTool: state === "running" ? "bash" : undefined,
		currentToolStartedAt: state === "running" ? Date.now() - 1000 : undefined,
		mode: "single" as const,
		cwd: `/tmp/${id}`,
		startedAt: Date.now() - 5000,
		lastUpdate: state === "running" ? Date.now() - 500 : Date.now() - 1000,
		endedAt: state === "running" ? undefined : Date.now() - 1000,
		currentStep: 0,
		steps: [{
			index: 0,
			agent: "waiter",
			status: state === "running" ? "running" : "complete",
			currentTool: state === "running" ? "bash" : undefined,
			currentToolStartedAt: state === "running" ? Date.now() - 1000 : undefined,
			tokens: { input: 100, output: 50, total: 150 },
		}],
		totalTokens: { input: 100, output: 50, total: 150 },
		outputFile: `/tmp/${id}/output-0.log`,
		sessionFile: `/tmp/${id}/session.jsonl`,
	};
}

function createSyncRun(id = "sync-a"): ForegroundRunSummary {
	return {
		id,
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

function createAnsiTheme(): StatusTheme {
	return {
		fg: (_token: string, text: string) => `\u001B[38;2;138;190;183m${text}\u001B[39m`,
		bg: (_token: string, text: string) => text,
	} as StatusTheme;
}

function stripSgr(text: string): string {
	return text.replace(/\u001B\[[0-9;]*m/g, "");
}

describe("SubagentsStatusComponent", () => {
	it("auto-refreshes and keeps the same async run selected when it moves to recent", async () => {
		const states: AsyncRunOverlayData[] = [
			{ active: [createRun("run-a", "running")], recent: [] },
			{ active: [], recent: [createRun("run-a", "complete")] },
		];
		let callCount = 0;
		let renderRequests = 0;
		const component = new SubagentsStatusComponent(
			createTestTui(() => { renderRequests++; }),
			createTestTheme(),
			() => {},
			{
				listRunsForOverlay: () => states[Math.min(callCount++, states.length - 1)]!,
				refreshMs: 10,
			},
		);

		try {
			await wait(25);
			const output = component.render(120).join("\n");
			assert.match(output, /Recent async/);
			assert.match(output, /Selected async: run-a/);
			assert.doesNotMatch(output, /Timeline:/);
			assert.match(output, /150 tok/);
			assert.match(output, /output: \/tmp\/run-a\/output-0\.log/);
			assert.match(output, /0 sync \/ 0 async \/ 1 recent/);
			assert.match(output, /enter detail/);
			assert.ok(renderRequests >= 1, "expected auto-refresh to request a render");
		} finally {
			component.dispose();
		}
	});

	it("shows foreground sync runs as live selectable sessions", () => {
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
			assert.match(output, /Subagents Live/);
			assert.match(output, /Live now \(1 sync \/ 0 async\)/);
			assert.match(output, /sync \| running \| parallel \| step 2/);
			assert.match(output, /Selected sync: sync-a/);
			assert.match(output, /Now: reviewer \| parallel \| step 2 \| tool read/);
			assert.doesNotMatch(output, /Timeline:/);
		} finally {
			component.dispose();
		}
	});

	it("opens compact async detail with tools and output tail", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-status-"));
		const run = {
			...createRun("run-detail", "running"),
			asyncDir: dir,
			outputFile: "output-0.log",
		};
		fs.writeFileSync(path.join(dir, "output-0.log"), "first line\nlatest transcript line\n");
		fs.writeFileSync(path.join(dir, "events.jsonl"), `${JSON.stringify({ type: "tool_call", ts: 1000, agent: "waiter", stepIndex: 0, message: "read file" })}\n`);
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
			component.handleInput("\r");
			const output = component.render(120).join("\n");
			assert.match(output, /Subagent Run run-deta/);
			assert.match(output, /Recent tools/);
			assert.match(output, /tool_call/);
			assert.match(output, /Compact output tail/);
			assert.match(output, /latest transcript line/);
			assert.match(output, /Paths/);
			assert.doesNotMatch(output, /Recent events/);
		} finally {
			component.dispose();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("opens compact sync detail with tools and output tail", () => {
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
			component.handleInput("\r");
			const output = component.render(140).join("\n");
			assert.match(output, /Recent tools/);
			assert.match(output, /read subagents-status\.ts/);
			assert.match(output, /Compact output tail/);
			assert.match(output, /sync compact tail line/);
			assert.match(output, /compact sync digest/);
		} finally {
			component.dispose();
		}
	});

	it("keeps every rendered detail line within the overlay width", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-status-width-"));
		const longText = "x".repeat(500);
		const run = {
			...createRun(longText, "running"),
			asyncDir: dir,
			cwd: path.join(dir, longText),
			outputFile: "output-0.log",
			sessionFile: path.join(dir, `${longText}.jsonl`),
			steps: [{
				index: 0,
				agent: longText,
				status: "running",
				currentTool: longText,
				currentToolStartedAt: Date.now() - 1000,
				error: longText,
			}],
		};
		fs.writeFileSync(path.join(dir, "output-0.log"), `${longText}\n\t}${longText}\n`);
		fs.writeFileSync(path.join(dir, "events.jsonl"), `${JSON.stringify({ type: longText, ts: 1000, agent: longText, message: `\t${longText}` })}\n`);
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
			component.handleInput("\r");
			const lines = component.render(202);
			for (const line of lines) assert.ok(visibleWidth(line) <= 140, `line too wide: ${visibleWidth(line)} ${line}`);
		} finally {
			component.dispose();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("preserves ANSI colors while normalizing tabs in detail output", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-status-ansi-"));
		const run = {
			...createRun("ansi-run", "running"),
			asyncDir: dir,
			outputFile: "output-0.log",
		};
		fs.writeFileSync(path.join(dir, "output-0.log"), "\tcolored tail line\n");
		const component = new SubagentsStatusComponent(
			createTestTui(() => {}),
			createAnsiTheme(),
			() => {},
			{
				listRunsForOverlay: () => ({ active: [run], recent: [] }),
				refreshMs: 1000,
			},
		);

		try {
			component.handleInput("\r");
			const output = component.render(202).join("\n");
			assert.match(output, /\u001B\[38;2;138;190;183m/);
			assert.doesNotMatch(stripSgr(output), /\[38;2;/);
			assert.doesNotMatch(stripSgr(output), /\t/);
		} finally {
			component.dispose();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("uses a wider overlay when terminal space is available", () => {
		const component = new SubagentsStatusComponent(
			createTestTui(() => {}),
			createTestTheme(),
			() => {},
			{
				listRunsForOverlay: () => ({ active: [createRun("wide-run", "running")], recent: [] }),
				refreshMs: 1000,
			},
		);

		try {
			const lines = component.render(202);
			assert.ok(lines.some((line) => visibleWidth(line) === 140), "expected overlay to grow beyond the old 84-column width");
		} finally {
			component.dispose();
		}
	});

	it("renders a clearer empty dashboard state", () => {
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
			assert.match(output, /No subagent sessions found/);
			assert.match(output, /No live or recent subagent runs yet/);
			assert.match(output, /Start one with \/run, \/chain, \/parallel/);
		} finally {
			component.dispose();
		}
	});

	it("converts foreground controls from state in most-recent order", () => {
		const controls = new Map<string, SubagentState["foregroundControls"] extends Map<string, infer T> ? T : never>();
		controls.set("older", {
			runId: "older",
			mode: "single",
			startedAt: 100,
			updatedAt: 200,
			currentAgent: "scout",
		});
		controls.set("newer", {
			runId: "newer",
			mode: "chain",
			startedAt: 100,
			updatedAt: 300,
			currentAgent: "planner",
			currentTool: "bash",
			currentToolStartedAt: 250,
		});

		const runs = foregroundRunsFromState({ foregroundControls: controls } as Pick<SubagentState, "foregroundControls">);
		assert.deepEqual(runs.map((run) => run.id), ["newer", "older"]);
		assert.equal(runs[0]?.currentTool, "bash");
	});

	it("stops auto-refreshing after dispose", async () => {
		let renderRequests = 0;
		const component = new SubagentsStatusComponent(
			createTestTui(() => { renderRequests++; }),
			createTestTheme(),
			() => {},
			{
				listRunsForOverlay: () => ({ active: [createRun("run-a", "running")], recent: [] }),
				refreshMs: 10,
			},
		);

		await wait(25);
		component.dispose();
		const before = renderRequests;
		await wait(25);
		assert.equal(renderRequests, before);
	});
});
