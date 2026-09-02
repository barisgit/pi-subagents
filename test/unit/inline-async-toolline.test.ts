import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { renderInlineAsyncToolLine } from "../../src/surfaces/render-inline.ts";
import { rmRun, writeRun } from "./inline-nested-helpers.ts";

const parent = "inline-async-parent";
const child = "a1b2c3d4ffff";

afterEach(() => [parent, child].forEach(rmRun));

describe("inline async child tool line", () => {
	for (const [state, glyph] of [
		["running", "◈"],
		["complete", "✓"],
	] as const) {
		it(`renders the canonical ${state} row`, () => {
			writeRun(parent);
			writeRun(child, { parentRunId: parent, state, agent: "explorer", label: "find pattern" });
			// Async history now carries the same lifecycle glyph and duration columns as every compact row.
			assert.match(
				renderInlineAsyncToolLine(parent, { async: true, agent: "explorer", label: "find pattern" }) ?? "",
				new RegExp(`^└─${glyph} subagent \\(background\\): explorer · find pattern → a1b2c3d4 · 1\\.[5-9]s$`),
			);
		});
	}
});
