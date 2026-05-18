import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { renderNestedChild } from "../../render.ts";
import { rmRun, tool, writeRun } from "./inline-nested-helpers.ts";

const ids = ["inline-d1", "inline-d2", "inline-d3", "inline-d4", "inline-d5", "inline-d6"];

afterEach(() => ids.forEach(rmRun));

describe("inline depth cap", () => {
	it("summarizes descendants beyond root plus three levels", () => {
		for (let i = 0; i < ids.length; i++) {
			writeRun(ids[i]!, { parentRunId: i === 0 ? undefined : ids[i - 1], agent: `a${i + 1}`, label: `l${i + 1}`, events: [
				tool("read", { path: `/tmp/${i}` }),
				...(i < ids.length - 1 ? [tool("subagent", { agent: `a${i + 2}`, label: `l${i + 2}` }, 1200)] : []),
			] });
		}
		const lines = renderNestedChild(ids[0]!, 1);
		const text = lines.join("\n");
		assert.match(text, /subagent: a1 · l1/);
		assert.match(text, /subagent: a2 · l2/);
		assert.match(text, /subagent: a3 · l3/);
		assert.match(text, /└─ … 2 more nested · 3 tools/);
		assert.doesNotMatch(text, /subagent: a5/);
		assert.doesNotMatch(text, /subagent: a6/);
	});
});
