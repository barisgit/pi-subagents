import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { renderNestedChild } from "../../render.ts";
import { rmRun, tool, writeRun } from "./inline-nested-helpers.ts";

const ids = ["inline-d1", "inline-d2", "inline-d3", "inline-d4", "inline-d5", "inline-d6"];

afterEach(() => ids.forEach(rmRun));

describe("inline nested rollup", () => {
	it("renders the direct child as one line and rolls the whole subtree into a nested hint", () => {
		// Build a deep chain a1 -> a2 -> ... -> a6, each spawning the next.
		for (let i = 0; i < ids.length; i++) {
			writeRun(ids[i]!, { parentRunId: i === 0 ? undefined : ids[i - 1], agent: `a${i + 1}`, label: `l${i + 1}`, events: [
				tool("read", { path: `/tmp/${i}` }),
				...(i < ids.length - 1 ? [tool("subagent", { agent: `a${i + 2}`, label: `l${i + 2}` }, 1200)] : []),
			] });
		}
		const lines = renderNestedChild(ids[0]!, 1);
		// Inline renders at most one level: the direct child (a1) is a single line,
		// and the entire deeper subtree (a2..a6) folds into a `↳ N nested` hint.
		assert.equal(lines.length, 1, `expected one line, got ${lines.length}:\n${lines.join("\n")}`);
		assert.match(lines[0]!, /subagent: a1 · l1/);
		assert.match(lines[0]!, /↳ 5 nested/);
		// No deeper level is expanded inline.
		assert.doesNotMatch(lines[0]!, /subagent: a2|subagent: a3|subagent: a5|subagent: a6/);
	});
});
