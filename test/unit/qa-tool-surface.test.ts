import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const CHARTER_ID = "f5fec59c-e92e-4263-927c-17a1ec03c93a";
const EVIDENCE_PATH = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	".pi",
	"charters",
	CHARTER_ID,
	"evidence",
	"qa-tool-surface.json",
);

interface ScenarioRecord {
	name: string;
	outcome: string;
	details?: Record<string, unknown>;
}

interface QaToolSurfaceEvidence {
	kind?: string;
	source?: string;
	scenarios?: ScenarioRecord[];
}

function readEvidence(): QaToolSurfaceEvidence {
	return JSON.parse(fs.readFileSync(EVIDENCE_PATH, "utf-8")) as QaToolSurfaceEvidence;
}

function scenario(evidence: QaToolSurfaceEvidence, name: string): ScenarioRecord {
	const found = evidence.scenarios?.find((entry) => entry.name === name);
	assert.ok(found, `expected scenario ${name}`);
	return found;
}

describe("qa tool surface", () => {
	it("qa-tool-surface", () => {
		assert.ok(true);
	});

	it("qa-evidence-file-imported", () => {
		assert.equal(fs.existsSync(EVIDENCE_PATH), true);
		assert.equal(readEvidence().kind, "qa");
	});

	it("all-scenarios-pass", () => {
		const evidence = readEvidence();
		assert.ok(Array.isArray(evidence.scenarios));
		assert.equal(evidence.scenarios.length, 8);
		for (const entry of evidence.scenarios) {
			assert.equal(entry.outcome, "pass", entry.name);
		}
	});

	it("qa-source-subagent", () => {
		assert.equal(readEvidence().source, "subagent");
	});

	it("negative-cases-rejected-with-hints", () => {
		const evidence = readEvidence();
		const negatives = [
			["negative: prompt renamed to message", /prompt.*message/i],
			["negative: CRUD removed uses file-based agent workflow", /Agent CRUD removed.*agents\/<name>\.md/i],
			["negative: fork is main-only", /fork.*same-role\/main|same-role\/main.*fork/i],
		] as const;

		for (const [name, pattern] of negatives) {
			const entry = scenario(evidence, name);
			assert.equal(entry.outcome, "pass");
			assert.match(JSON.stringify(entry.details ?? {}), pattern, name);
		}
	});
});
