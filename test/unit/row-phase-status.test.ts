import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import { stopWidgetAnimation } from "../../src/surfaces/render-widget.ts";
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
			ownership: "foreign",
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
		// The state glyph already encodes running; the redundant bare `running` word
		// is dropped (the phase chip + running glyph carry the liveness signal).
		assert.doesNotMatch(line, /\brunning\b/);
	});

	it("keeps the state/displayState discriminant when there is no phase chip", () => {
		const now = 1_000_000;
		const run: LiveRun = {
			ownership: "foreign",
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
		// No phase chip: the displayState discriminant is the only live-activity signal,
		// shown bare (`quiet`) since the running glyph already conveys the state.
		assert.match(line, /\bquiet\b/);
		assert.doesNotMatch(line, /running\/quiet/);
	});

	it("shows bare `queued` without the always-quiet discriminant", () => {
		const now = 1_000_000;
		const run: LiveRun = {
			ownership: "foreign",
			run: {
				id: "queued-run",
				asyncDir: "/tmp/queued-run",
				mode: "single",
				state: "queued",
				// A queued run's displayState is always 'quiet' (it has not begun executing).
				displayState: "quiet",
				startedAt: now - 5_000,
				lastUpdate: now - 5_000,
				steps: [{ index: 0, agent: "explorer", status: "queued" }],
			},
		};
		const line = buildLeftLine(theme as never, run, false, now, 240);
		// A queued leaf row shows the `○` glyph alone; the redundant `queued` word and
		// the always-`quiet` discriminant are both dropped.
		assert.doesNotMatch(line, /\bqueued\b/);
		assert.doesNotMatch(line, /quiet/);
	});

	it("keeps lost authoritative over a stale running state", () => {
		const now = 1_000_000;
		const run: LiveRun = {
			ownership: "foreign",
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
		// Lost wins via the ! glyph; the shared grammar never emits state words.
		assert.match(line, /! .*explorer/);
		assert.doesNotMatch(line, /\blost\b/);
		assert.doesNotMatch(line, /running\/lost/);
		assert.doesNotMatch(line, /finishing/);
	});
});
