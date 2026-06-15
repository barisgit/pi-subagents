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
	"reviewer-doctrine.json",
);

interface ReviewerEvidence {
	kind?: string;
	source?: string;
	outcome?: string;
	because?: string;
	blockingIssues?: unknown[];
}

function readEvidence(): ReviewerEvidence {
	return JSON.parse(fs.readFileSync(EVIDENCE_PATH, "utf-8")) as ReviewerEvidence;
}

describe("reviewer doctrine", () => {
	it("reviewer-doctrine", () => {
		assert.equal(fs.existsSync(EVIDENCE_PATH), true);
	});

	it("reviewer-evidence-kind-review", () => {
		assert.equal(readEvidence().kind, "review");
	});

	it("reviewer-source-subagent", () => {
		assert.equal(readEvidence().source, "subagent");
	});

	it("reviewer-outcome-pass", () => {
		assert.equal(readEvidence().outcome, "pass");
	});

	it("reviewer-because-present", () => {
		const because = readEvidence().because ?? "";
		assert.ok(because.length >= 50, "because field is too short");
	});

	it("reviewer-no-blocking-issues", () => {
		const issues = readEvidence().blockingIssues ?? [];
		assert.equal(issues.length, 0, `expected 0 blocking issues, got ${issues.length}`);
	});

	it("reviewer-task-field-cited", () => {
		const because = readEvidence().because ?? "";
		// must cite key review areas: schema fields, token budget, skill, doctrine
		assert.match(because, /schema|field|token|skill|doctrine/i);
	});
});
