import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { buildWidgetLines, stopWidgetAnimation } from "../../src/surfaces/render-widget.ts";
import { buildLeftLine, type LiveRun } from "../../src/surfaces/subagents-status.ts";

const theme = {
	fg: (_name: string, text: string) => text,
	bold: (text: string) => text,
};

describe("resume leg duration display", () => {
	afterEach(() => stopWidgetAnimation());

	it("shows current leg duration with identity age as secondary text", () => {
		const now = 1_000_000;
		const run: LiveRun = {
			source: "async",
			run: {
				id: "resumed-run",
				asyncDir: "/tmp/resumed-run",
				mode: "single",
				state: "complete",
				startedAt: now - 143 * 60_000,
				resumedAt: now - 12_000,
				resumeCount: 1,
				endedAt: now,
				lastUpdate: now,
				steps: [{ index: 0, agent: "fixer", status: "complete" }],
			},
		};
		const line = buildLeftLine(theme as never, run, false, now, 240);
		assert.match(line, /12\.0s/);
		assert.match(line, /age 143m0s/);
		assert.match(line, /resumed 1×/);
		assert.equal((line.match(/12\.0s/g) ?? []).length, 1);
	});

	it("gates resumed dashboard chip to resumeCount greater than zero", () => {
		const now = 1_000_000;
		const run: LiveRun = {
			source: "async",
			run: {
				id: "never-resumed",
				asyncDir: "/tmp/never-resumed",
				mode: "single",
				state: "complete",
				startedAt: now - 12_000,
				endedAt: now,
				lastUpdate: now,
				resumeCount: 0,
				steps: [{ index: 0, agent: "fixer", status: "complete" }],
			},
		};
		const line = buildLeftLine(theme as never, run, false, now, 240);
		// Never-resumed terminal row stays byte-identical to the pre-resume layout:
		// date stamp only, no leg elapsed / identity age / resumed chip.
		assert.doesNotMatch(line, /\ds\b/);
		assert.doesNotMatch(line, /resumed/);
		assert.doesNotMatch(line, /age /);

		// Strict byte-identical guard: resumeCount:0 must equal the field being absent.
		const absent: LiveRun = JSON.parse(JSON.stringify(run));
		delete (absent.run as unknown as Record<string, unknown>).resumeCount;
		assert.equal(buildLeftLine(theme as never, run, false, now, 240), buildLeftLine(theme as never, absent, false, now, 240));
	});

	it("shows current leg duration on a resumed terminal row alongside the date stamp", () => {
		const now = 1_000_000;
		const run: LiveRun = {
			source: "async",
			run: {
				id: "resumed-terminal",
				asyncDir: "/tmp/resumed-terminal",
				mode: "single",
				state: "complete",
				startedAt: now - 143 * 60_000,
				resumedAt: now - 12_000,
				resumeCount: 1,
				endedAt: now,
				lastUpdate: now,
				steps: [{ index: 0, agent: "fixer", status: "complete" }],
			},
		};
		const line = buildLeftLine(theme as never, run, false, now, 240);
		assert.match(line, /12\.0s/);
		assert.match(line, /age 143m0s/);
		assert.match(line, /resumed 1×/);
	});

	it("keeps never-resumed widget row strings byte-identical while adding a resumed glyph only for resumed jobs", () => {
		const never = buildWidgetLines([{ asyncId: "never", asyncDir: "/tmp/never", status: "complete", mode: "single", agents: ["fixer"], startedAt: 1_000, updatedAt: 13_000, resumeCount: 0 }], theme as never, 200);
		const absent = buildWidgetLines([{ asyncId: "never", asyncDir: "/tmp/never", status: "complete", mode: "single", agents: ["fixer"], startedAt: 1_000, updatedAt: 13_000 }], theme as never, 200);
		assert.deepEqual(never, absent);
		const resumed = buildWidgetLines([{ asyncId: "resumed", asyncDir: "/tmp/resumed", status: "complete", mode: "single", agents: ["fixer"], startedAt: 1_000, resumedAt: 10_000, resumeCount: 2, updatedAt: 22_000 }], theme as never, 200);
		assert.match(resumed.join("\n"), /↻2/);
		assert.match(resumed.join("\n"), /12\.0s/);
	});
});
