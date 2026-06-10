import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { findInlineChildRun } from "../../src/surfaces/render.ts";
import { rmRun, writeRun } from "./inline-nested-helpers.ts";

const parent = "inline-lookup-parent";
const child = "inline-lookup-child";

afterEach(() => [parent, child].forEach(rmRun));

describe("inline child lookup rescan", () => {
	it("finds an on-disk child by parentRunId when args do not contain a child run id", () => {
		writeRun(child, { parentRunId: parent, agent: "fixer", label: "rescanned child", startedAt: 1_000 });

		const found = findInlineChildRun(parent, {}, new Set<string>());

		assert.equal(found?.id, child);
	});
});
