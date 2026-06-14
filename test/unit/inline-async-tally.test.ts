import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { countLiveInlineAsyncChildren } from "../../src/surfaces/render-inline.ts";
import { rmRun, writeRun } from "./inline-nested-helpers.ts";

const ids = ["inline-tally-parent", "inline-tally-a", "inline-tally-b", "inline-tally-sync"];
const tools = [
	{ tool: "subagent", rawArgs: { async: true, agent: "explorer", label: "a" } },
	{ tool: "subagent", rawArgs: { async: true, agent: "fixer", label: "b" } },
	{ tool: "subagent", rawArgs: { agent: "reviewer", label: "sync" } },
];

afterEach(() => ids.forEach(rmRun));

describe("inline async tally", () => {
	it("counts only direct running async children", () => {
		writeRun(ids[0]!);
		writeRun(ids[1]!, { parentRunId: ids[0], state: "running", agent: "explorer", label: "a" });
		writeRun(ids[2]!, { parentRunId: ids[0], state: "running", agent: "fixer", label: "b" });
		writeRun(ids[3]!, { parentRunId: ids[0], state: "running", agent: "reviewer", label: "sync" });
		assert.equal(countLiveInlineAsyncChildren(ids[0]!, tools), 2);
		rmRun(ids[2]!);
		writeRun(ids[2]!, { parentRunId: ids[0], state: "complete", agent: "fixer", label: "b" });
		assert.equal(countLiveInlineAsyncChildren(ids[0]!, tools), 1);
		rmRun(ids[1]!);
		writeRun(ids[1]!, { parentRunId: ids[0], state: "complete", agent: "explorer", label: "a" });
		assert.equal(countLiveInlineAsyncChildren(ids[0]!, tools), 0);
	});
});
