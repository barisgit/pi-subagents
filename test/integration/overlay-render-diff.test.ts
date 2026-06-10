import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import { type ForegroundRunSummary, SubagentsStatusComponent } from "../../src/surfaces/subagents-status.ts";
import type { AsyncRunOverlayData, AsyncRunSummary } from "../../src/state/async-status.ts";

// VAL-RENDER-ON-DIFF: the overlay's auto-refresh tick repaints only when the
// derived run set changed (cheap structural signature) OR a live run still needs
// its elapsed/spinner label advanced. An idle tick over an all-terminal set with
// no change must NOT requestRender; a real state change must; an active run must
// keep ticking every period regardless of structural change.

let testsRun = 0;
afterEach(() => { testsRun++; });
after(() => { process.stdout.write(`# tests ${testsRun}\n`); });

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

type StatusTui = ConstructorParameters<typeof SubagentsStatusComponent>[0];
type StatusTheme = ConstructorParameters<typeof SubagentsStatusComponent>[1];

function createTestTui(requestRender: () => void): StatusTui {
	return { requestRender } as StatusTui;
}

function createTestTheme(): StatusTheme {
	const passthrough = (_token: string, text: string) => text;
	return { fg: passthrough, bg: passthrough, dim: (t: string) => t, bold: (t: string) => t } as unknown as StatusTheme;
}

function terminalRun(id: string): AsyncRunSummary {
	const now = Date.now();
	return {
		id,
		asyncDir: `/tmp/${id}`,
		state: "complete",
		mode: "single",
		cwd: `/tmp/${id}`,
		startedAt: now - 5000,
		lastUpdate: now - 1000,
		endedAt: now - 1000,
		currentStep: 0,
		steps: [{ index: 0, agent: "fixer", status: "complete", tokens: { input: 1, output: 1, total: 2 } }],
	};
}

function pausedRun(id: string): AsyncRunSummary {
	const now = Date.now();
	return {
		id,
		asyncDir: `/tmp/${id}`,
		state: "paused",
		mode: "single",
		cwd: `/tmp/${id}`,
		startedAt: now - 5000,
		lastUpdate: now - 1000,
		currentStep: 0,
		steps: [{ index: 0, agent: "fixer", status: "running", tokens: { input: 1, output: 1, total: 2 } }],
	};
}

function runningRun(id: string): AsyncRunSummary {
	const now = Date.now();
	return {
		id,
		asyncDir: `/tmp/${id}`,
		state: "running",
		displayState: "working",
		currentTool: "bash",
		currentToolStartedAt: now - 1000,
		mode: "single",
		cwd: `/tmp/${id}`,
		startedAt: now - 5000,
		lastUpdate: now - 300,
		runnerHeartbeatAt: now - 300,
		currentStep: 0,
		steps: [{ index: 0, agent: "fixer", status: "running", tokens: { input: 1, output: 1, total: 2 } }],
	};
}

describe("overlay render-on-diff", () => {
	it("does not repaint on an idle tick over an unchanged terminal run set", async () => {
		let renders = 0;
		const snapshot: AsyncRunOverlayData = { active: [], recent: [terminalRun("done-1"), terminalRun("done-2")] };
		const component = new SubagentsStatusComponent(
			createTestTui(() => { renders++; }),
			createTestTheme(),
			() => {},
			{ listRunsForOverlay: () => snapshot, refreshMs: 10 },
		);
		// Let several ticks pass with no change to the snapshot.
		await wait(60);
		component.dispose();
		assert.equal(renders, 0, "an unchanged all-terminal set must not request any render");
	});

	it("repaints when the derived run set changes", async () => {
		let renders = 0;
		let snapshot: AsyncRunOverlayData = { active: [], recent: [terminalRun("done-1")] };
		const component = new SubagentsStatusComponent(
			createTestTui(() => { renders++; }),
			createTestTheme(),
			() => {},
			{ listRunsForOverlay: () => snapshot, refreshMs: 10 },
		);
		await wait(30);
		assert.equal(renders, 0, "no change yet => no render");
		// A new run appears => structural signature changes => one repaint.
		snapshot = { active: [], recent: [terminalRun("done-1"), terminalRun("done-2")] };
		await wait(40);
		component.dispose();
		assert.ok(renders >= 1, "a changed run set must request a render");
	});

	it("does not repaint on an idle tick over an unchanged paused run set", async () => {
		let renders = 0;
		// A paused run is terminal-ish (recent bucket, frozen label) so it must not
		// keep the refresh loop live; an idle tick over it requests no render.
		const snapshot: AsyncRunOverlayData = { active: [], recent: [pausedRun("paused-1")] };
		const component = new SubagentsStatusComponent(
			createTestTui(() => { renders++; }),
			createTestTheme(),
			() => {},
			{ listRunsForOverlay: () => snapshot, refreshMs: 10 },
		);
		await wait(60);
		component.dispose();
		assert.equal(renders, 0, "an unchanged paused run must not request any render");
	});

	it("keeps ticking renders for an active run even with no structural change", async () => {
		let renders = 0;
		const snapshot: AsyncRunOverlayData = { active: [runningRun("live-1")], recent: [] };
		const component = new SubagentsStatusComponent(
			createTestTui(() => { renders++; }),
			createTestTheme(),
			() => {},
			{ listRunsForOverlay: () => snapshot, refreshMs: 10 },
		);
		await wait(55);
		component.dispose();
		assert.ok(renders >= 2, "an active run must keep advancing its live label every tick");
	});
});
