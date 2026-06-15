import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

const docPath = "docs/schema-decisions.md";

function readDoc(): string {
	return readFileSync(docPath, "utf8");
}

function h2Section(doc: string, name: string): string {
	const lines = doc.split(/\r?\n/);
	const start = lines.findIndex((line) => line.startsWith("## ") && line.toLowerCase().includes(name.toLowerCase()));
	assert.notEqual(start, -1, `missing ${name} section`);
	const end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
	return lines.slice(start, end === -1 ? undefined : end).join("\n");
}

describe("doctrine doc", () => {
	it("file exists", () => {
		assert.equal(existsSync(docPath), true);
	});

	it('has H1 "Subagent schema decisions"', () => {
		const firstH1 = readDoc()
			.split(/\r?\n/)
			.find((line) => line.startsWith("# "));
		assert.equal(firstH1, "# Subagent schema decisions");
	});

	it("has all 8 required H2 sections", () => {
		const doc = readDoc();
		const headings = Array.from(doc.matchAll(/^##\s+(.+)$/gim), (match) => match[1]?.toLowerCase() ?? "");
		const required = [
			"Goal & non-goals",
			"Baseline",
			"Kept fields",
			"Dropped fields",
			"Renames",
			"Token budget rationale",
			"Compat policy",
			"Rejected alternatives",
		];

		for (const heading of required) {
			assert.ok(
				headings.some((actual) => actual.includes(heading.toLowerCase())),
				`missing H2 section containing ${heading}`,
			);
		}
	});

	it("each dropped field is individually listed", () => {
		const doc = readDoc();
		const decisionText = `${h2Section(doc, "Dropped fields")}\n${h2Section(doc, "Renames")}`;
		const droppedFields = [
			"model",
			"tasks",
			"prompt",
			"clarify",
			"share",
			"preset",
			"sessionDir",
			"control",
			"skill",
			"artifacts",
			"progress",
			"agentScope",
			"includeInternal",
			"metadata",
			"cwd",
			"reads",
		];

		for (const field of droppedFields) {
			assert.ok(decisionText.includes(`\`${field}\``), `missing dropped field ${field}`);
		}
	});

	it("rename mappings present", () => {
		const renames = h2Section(readDoc(), "Renames");
		assert.match(renames, /`prompt`\s*\|\s*`message`/);
		assert.match(renames, /`tasks`\s*\|\s*`run`/);
		assert.match(renames, /`parallel`/);
	});

	it("baseline version recorded", () => {
		const baseline = h2Section(readDoc(), "Baseline");
		assert.match(baseline, /\d+\.\d+\.\d+/);
	});

	it("migration reference noted", () => {
		assert.match(readDoc(), /skills\/subagent\/references\/migration\.md/);
	});
});
