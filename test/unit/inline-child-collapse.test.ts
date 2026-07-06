import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { renderNestedChild } from "../../src/surfaces/render-inline.ts";
import { rmRun, tool, writeRun } from "./inline-nested-helpers.ts";

const cases = [
	["complete", "✓"],
	["failed", "×"],
	["paused", "‖"],
] as const;
const ids = cases.map(([state]) => `inline-collapse-${state}`);

afterEach(() => ids.forEach(rmRun));

describe("inline child collapse", () => {
	for (const [state, glyph] of cases) {
		it(`collapses ${state} child to one summary line`, () => {
			const id = `inline-collapse-${state}`;
			writeRun(id, {
				state,
				agent: "fixer",
				label: `${state} work`,
				startedAt: 1_000,
				endedAt: 2_500,
				tokens: 2048,
				events: [tool("read", { path: "/a" }), tool("bash", { command: "echo hi" }, 1200)],
			});
			assert.deepEqual(renderNestedChild(id, 1), [
				`└─ ${glyph} subagent: ${state} work · 2 tools · 2.0kt · 1.5s`,
			]);
		});
	}
});
