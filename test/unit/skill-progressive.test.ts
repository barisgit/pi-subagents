import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";

const skillPath = path.join("skills", "subagent", "SKILL.md");
const referencesDir = path.join("skills", "subagent", "references");
const referenceFiles = [
	"batch-notifications.md",
	"context-fork.md",
	"dispatch-patterns.md",
	"error-modes.md",
	"resume.md",
] as const;

function readSkill(): string {
	return fs.readFileSync(skillPath, "utf-8");
}

function readReference(name: string): string {
	return fs.readFileSync(path.join(referencesDir, name), "utf-8");
}

describe("skill progressive", () => {
	it("skill-progressive", () => {
		assert.equal(true, true);
	});

	it("skill-file-exists", () => {
		assert.equal(fs.existsSync(skillPath), true);
	});

	it("skill-under-80-lines", () => {
		const lines = readSkill().trimEnd().split(/\r?\n/);

		assert.ok(lines.length <= 80, `SKILL.md has ${lines.length} lines`);
	});

	it("references-folder-has-5", () => {
		const files = fs
			.readdirSync(referencesDir)
			.filter((file) => file.endsWith(".md"))
			.sort();

		assert.deepEqual(files, [...referenceFiles].sort());
	});

	it("skill-mentions-references", () => {
		const skill = readSkill();

		for (const file of referenceFiles) {
			assert.ok(skill.includes(file) || skill.includes(`references/${file}`), `missing ${file}`);
		}
	});

	it("each-reference-has-h1", () => {
		for (const file of referenceFiles) {
			assert.match(readReference(file), /^#\s+.+/m, `${file} is missing an H1`);
		}
	});

	it("skill-shows-canonical-example", () => {
		const skill = readSkill();

		assert.ok(skill.includes("run:"), "missing run: example");
		assert.ok(skill.includes("parallel"), "missing parallel example");
	});
});
