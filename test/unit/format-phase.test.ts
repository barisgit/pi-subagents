import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import { formatPhase } from "../../run-phase.ts";

let testsRun = 0;
afterEach(() => { testsRun++; });
after(() => { process.stdout.write(`# tests ${testsRun}\n`); });

describe("formatPhase", () => {
	it("formats thinking with elapsed seconds", () => {
		const label = formatPhase("thinking", 88_000, 100_000);

		assert.match(label, /thinking/);
		assert.match(label, /12s/);
	});

	it("formats tool phases with the current tool name", () => {
		const label = formatPhase("tool_running", 55_000, 100_000, "bash");

		assert.match(label, /tool: bash/);
	});

	it("returns empty for idle or undefined phase", () => {
		assert.equal(formatPhase("idle", 88_000, 100_000), "");
		assert.equal(formatPhase(undefined, undefined, 100_000), "");
	});

	it("omits duration when phaseStartedAt is missing", () => {
		assert.equal(formatPhase("thinking", undefined, 100_000), "thinking");
	});
});
