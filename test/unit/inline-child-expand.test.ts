import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { renderNestedChild } from "../../render.ts";
import { rmRun, tool, writeRun } from "./inline-nested-helpers.ts";

const ids = ["inline-parent-f4", "inline-child-f4", "inline-grand-f4"];

afterEach(() => ids.forEach(rmRun));

describe("inline child expansion", () => {
	it("renders live child and grandchild as expanded nested cards", () => {
		writeRun(ids[0]);
		writeRun(ids[1], { parentRunId: ids[0], agent: "explorer", label: "find files", tokens: 1200, events: [
			tool("read", { path: "/tmp/a.ts" }),
			tool("subagent", { agent: "fixer", label: "patch files" }, 1200),
		] });
		writeRun(ids[2], { parentRunId: ids[1], agent: "fixer", label: "patch files", tokens: 300, events: [tool("bash", { command: "npm test" })] });
		const lines = renderNestedChild(ids[1], 1, { agent: "explorer", label: "find files" });
		assert.match(lines.join("\n"), /└─ ◇ subagent: explorer · find files · 2 tools · ~1.2k tok/);
		assert.match(lines.join("\n"), /└─ read: \{"path":"\/tmp\/a.ts"\}/);
		assert.match(lines.join("\n"), /  └─ ◇ subagent: fixer · patch files · 1 tools · ~300 tok/);
		assert.match(lines.join("\n"), /bash: \{"command":"npm test"\}/);
	});
});
