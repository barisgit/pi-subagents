import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { renderNestedChild } from "../../src/surfaces/render-inline.ts";
import { rmRun, tool, writeRun } from "./inline-nested-helpers.ts";

const ids = ["inline-parent-f4", "inline-child-f4", "inline-grand-f4"];

afterEach(() => ids.forEach(rmRun));

describe("inline child expansion", () => {
	it("renders a running child as a single rolled-up line and does not expand the grandchild", () => {
		writeRun(ids[0]!);
		writeRun(ids[1]!, {
			parentRunId: ids[0],
			agent: "explorer",
			label: "find files",
			tokens: 1200,
			events: [
				tool("read", { path: "/tmp/a.ts" }),
				tool("subagent", { agent: "fixer", label: "patch files" }, 1200),
			],
		});
		writeRun(ids[2]!, {
			parentRunId: ids[1],
			agent: "fixer",
			label: "patch files",
			tokens: 300,
			events: [tool("bash", { command: "npm test" })],
		});
		const lines = renderNestedChild(ids[1]!, 1, { agent: "explorer", label: "find files" });
		// The inline widget renders at most one level: the child is one line, the
		// grandchild (fixer) is NOT expanded — it only contributes a `↳ N nested` hint.
		assert.equal(lines.length, 1, `expected one line, got ${lines.length}:\n${lines.join("\n")}`);
		assert.match(lines[0]!, /◇ subagent: explorer · find files · 2 tools · 1.2kt/);
		assert.match(lines[0]!, /↳ 1 nested/);
		assert.doesNotMatch(lines[0]!, /subagent: fixer/);
		assert.doesNotMatch(lines[0]!, /read: |bash: /);
	});
});
