import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { renderInlineAsyncToolLine } from "../../render.ts";
import { rmRun, writeRun } from "./inline-nested-helpers.ts";

const parent = "inline-async-parent";
const child = "a1b2c3d4ffff";

afterEach(() => [parent, child].forEach(rmRun));

describe("inline async child tool line", () => {
	for (const state of ["running", "complete"] as const) {
		it(`renders the same plain line while ${state}`, () => {
			writeRun(parent);
			writeRun(child, { parentRunId: parent, state, agent: "explorer", label: "find pattern" });
			assert.equal(renderInlineAsyncToolLine(parent, { async: true, agent: "explorer", label: "find pattern" }), "└─ subagent (background): explorer · find pattern → a1b2c3d4");
		});
	}
});
