import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { countQueuedInlineChildren } from "../../src/surfaces/render-inline.ts";
import { rmRun, writeRun } from "./inline-nested-helpers.ts";

const ids = [
	"inline-queued-parent",
	"inline-queued-run-1",
	"inline-queued-run-2",
	"inline-queued-q1",
	"inline-queued-q2",
];

afterEach(() => ids.forEach(rmRun));

describe("countQueuedInlineChildren", () => {
	it("counts only direct children still in the queued state", () => {
		writeRun(ids[0]!);
		writeRun(ids[1]!, { parentRunId: ids[0], state: "running", agent: "fixer" });
		writeRun(ids[2]!, { parentRunId: ids[0], state: "running", agent: "explorer" });
		writeRun(ids[3]!, { parentRunId: ids[0], state: "queued", agent: "fixer" });
		writeRun(ids[4]!, { parentRunId: ids[0], state: "queued", agent: "explorer" });
		assert.equal(countQueuedInlineChildren(ids[0]!), 2);
	});

	it("excludes children already rendered as their own rows via the used set", () => {
		writeRun(ids[0]!);
		writeRun(ids[3]!, { parentRunId: ids[0], state: "queued", agent: "fixer" });
		writeRun(ids[4]!, { parentRunId: ids[0], state: "queued", agent: "explorer" });
		assert.equal(countQueuedInlineChildren(ids[0]!, new Set([ids[3]!])), 1);
	});
});
