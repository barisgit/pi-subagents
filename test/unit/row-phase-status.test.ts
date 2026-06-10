import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import { stopWidgetAnimation } from "../../src/surfaces/render.ts";
import { buildLeftLine, type LiveRun } from "../../src/surfaces/subagents-status.ts";

const theme = {
	fg: (_name: string, text: string) => text,
	bold: (text: string) => text,
};

let testsRun = 0;
afterEach(() => {
	testsRun++;
	stopWidgetAnimation();
});
after(() => process.stdout.write(`# tests ${testsRun}\n`));

describe("row phase/displayState contradiction", () => {
	it("suppresses the working/quiet discriminant when a live phase chip is present", () => {
		const now = 1_000_000;
		const run: LiveRun = {
			source: "async",
			run: {
				id: "finishing-run",
				asyncDir: "/tmp/finishing-run",
				mode: "single",
				state: "running",
				displayState: "quiet",
				phase: "finishing",
				phaseStartedAt: now - 19_900,
				startedAt: now - 67_000,
				lastUpdate: now - 19_900,
				steps: [{ index: 0, agent: "explorer", status: "running" }],
			},
		};
		const line = buildLeftLine(theme as never, run, false, now, 240);
		// The phase chip conveys live activity richly.
		assert.match(line, /finishing/);
		// It must NOT also print the contradictory `running/quiet` discriminant.
		assert.doesNotMatch(line, /running\/quiet/);
		// The bare state still appears (so the row isn't ambiguous about running vs done).
		assert.match(line, /\brunning\b/);
	});

	it("keeps the state/displayState discriminant when there is no phase chip", () => {
		const now = 1_000_000;
		const run: LiveRun = {
			source: "async",
			run: {
				id: "quiet-run",
				asyncDir: "/tmp/quiet-run",
				mode: "single",
				state: "running",
				displayState: "quiet",
				// no phase -> displayState is the only live-activity signal
				startedAt: now - 30_000,
				lastUpdate: now - 8_000,
				steps: [{ index: 0, agent: "explorer", status: "running" }],
			},
		};
		const line = buildLeftLine(theme as never, run, false, now, 240);
		assert.match(line, /running\/quiet/);
	});

	it("keeps lost authoritative over a stale running state", () => {
		const now = 1_000_000;
		const run: LiveRun = {
			source: "async",
			run: {
				id: "lost-run",
				asyncDir: "/tmp/lost-run",
				mode: "single",
				state: "running",
				displayState: "lost",
				phase: "finishing",
				phaseStartedAt: now - 40_000,
				startedAt: now - 90_000,
				lastUpdate: now - 40_000,
				steps: [{ index: 0, agent: "explorer", status: "running" }],
			},
		};
		const line = buildLeftLine(theme as never, run, false, now, 240);
		// lost wins: no phase chip, just `lost`, never `running/lost`.
		assert.match(line, /\blost\b/);
		assert.doesNotMatch(line, /running\/lost/);
		assert.doesNotMatch(line, /finishing/);
	});
});
