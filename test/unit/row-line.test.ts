import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Theme } from "../../src/surfaces/render-shared.ts";
import { aggregateState, renderRowLine, rowGlyph, stateKey, type RowState } from "../../src/surfaces/row-line.ts";

const theme: Theme = {
	fg: (color, text) => `<${color}>${text}</${color}>`,
	bold: (text) => text,
};

describe("row-line state grammar", () => {
	it("maps every row state to its semantic color and dashboard glyph", () => {
		const expected: Array<[RowState, string, string]> = [
			["queued", "dim", "○"],
			["running", "accent", "◈"],
			["paused", "warning", "⏸"],
			["complete", "success", "✓"],
			["failed", "error", "✗"],
			["interrupted", "warning", "■"],
			["skipped", "dim", "·"],
			["lost", "error", "!"],
			["attention", "warning", "!"],
			["delivering", "accent", "✓"],
		];

		for (const [state, color, glyph] of expected) {
			assert.equal(stateKey(state), color);
			assert.equal(rowGlyph(theme, state), `<${color}>${glyph}</${color}>`);
		}
	});

	it("aggregates child states by failure and liveness precedence", () => {
		assert.equal(aggregateState([]), "queued");
		assert.equal(aggregateState(["complete", "failed", "running"]), "failed");
		assert.equal(aggregateState(["complete", "lost", "attention"]), "lost");
		assert.equal(aggregateState(["complete", "attention", "running"]), "attention");
		assert.equal(aggregateState(["complete", "running", "queued"]), "running");
		assert.equal(aggregateState(["complete", "queued"]), "queued");
		assert.equal(aggregateState(["complete", "interrupted", "skipped", "paused", "delivering"]), "complete");
	});
});

describe("renderRowLine", () => {
	const plainTheme: Theme = { fg: (_color, text) => text, bold: (text) => text };
	const cells = {
		state: "running" as const,
		name: "worker",
		phaseChip: "P2 verify",
		badge: "2/3",
		label: "check output",
		tools: 2,
		tokens: 1_500,
		durationMs: 2_000,
	};

	it("uses the same fixed column order for every variant and reserves the cursor for dashboard", () => {
		const body = "◈ worker · P2 verify · 2/3 · check output · 2 tools · 1.5kt · 2.0s";
		assert.equal(renderRowLine(plainTheme, cells, 120, "dashboard"), `  ${body}`);
		assert.equal(renderRowLine(plainTheme, cells, 120, "widget"), body);
		assert.equal(renderRowLine(plainTheme, cells, 120, "detailStep"), body);
		assert.equal(renderRowLine(plainTheme, cells, 120, "notice"), body);
	});

	it("right-aligns a wall-clock stamp only for terminal dashboard rows", () => {
		const endedAt = new Date(2024, 0, 2, 3, 4).getTime();
		const dashboard = renderRowLine(
			plainTheme,
			{ state: "complete", name: "worker", durationMs: 3_000, endedAt },
			30,
			"dashboard",
		);
		assert.equal(dashboard.length, 30);
		assert.match(dashboard, /· 3\.0s\s+@03:04$/);
		assert.doesNotMatch(
			renderRowLine(plainTheme, { state: "complete", name: "worker", endedAt }, 80, "notice"),
			/@/,
		);
		assert.doesNotMatch(renderRowLine(plainTheme, { state: "running", name: "worker" }, 80, "dashboard"), /@/);
	});
});

describe("row cell producers", () => {
	it("maps RunView display state precedence and freezes durations", async () => {
		const { cellsFromRunView } = await import("../../src/surfaces/row-line.ts");
		const base = { id: "r", mode: "single" as const, state: "running" as const, startedAt: 1_000, steps: [] };

		assert.deepEqual(cellsFromRunView({ ...base, executionStartedAt: 2_000 }, 7_000), {
			state: "running",
			name: "single",
			durationMs: 5_000,
		});
		assert.equal(cellsFromRunView({ ...base, state: "queued" }, 7_000).durationMs, undefined);
		assert.deepEqual(cellsFromRunView({ ...base, state: "complete", endedAt: 6_000 }, 9_000), {
			state: "complete",
			name: "single",
			durationMs: 5_000,
			endedAt: 6_000,
		});
		assert.deepEqual(cellsFromRunView({ ...base, displayState: "lost", lastUpdate: 5_000 }, 9_000), {
			state: "lost",
			name: "single",
			durationMs: 4_000,
			endedAt: 5_000,
		});
		assert.equal(cellsFromRunView({ ...base, displayState: "needs_attention" }, 7_000).state, "attention");
		assert.equal(cellsFromRunView(base, 7_000, { pendingDelivery: true }).state, "delivering");
	});

	it("maps SingleResult state, agent color, stats, duration, and caller cells", async () => {
		const { cellsFromSingleResult } = await import("../../src/surfaces/row-line.ts");
		const cells = cellsFromSingleResult(
			{
				agent: "reviewer",
				task: "review",
				label: "inspect seam",
				exitCode: 0,
				usage: { input: 400, output: 100 },
				progress: {
					agent: "reviewer",
					status: "completed",
					task: "review",
					recentTools: [],
					recentOutput: [],
					color: "cyan",
					toolCount: 3,
					tokens: 700,
					durationMs: 2_500,
				},
			},
			{ depth: 2, selected: true, phaseChip: "P1", badge: "stage 1" },
		);
		assert.deepEqual(cells, {
			state: "complete",
			name: "reviewer",
			nameColor: "cyan",
			depth: 2,
			selected: true,
			phaseChip: "P1",
			badge: "stage 1",
			label: "inspect seam",
			tools: 3,
			tokens: 700,
			durationMs: 2_500,
		});
		assert.equal(
			cellsFromSingleResult({ agent: "x", task: "x", exitCode: 1, usage: { input: 0, output: 0 } }).state,
			"failed",
		);
		assert.equal(
			cellsFromSingleResult({
				agent: "x",
				task: "x",
				exitCode: 0,
				interrupted: true,
				usage: { input: 0, output: 0 },
			}).state,
			"interrupted",
		);
	});
});
