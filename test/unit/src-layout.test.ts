import { describe, test } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const moduleDirs = ["api", "dispatch", "runtime", "state", "surfaces", "workflow", "protocol", "shared"];

describe("source layout", () => {
	test("keeps only index.ts at the repository root", () => {
		const rootTsFiles = fs.readdirSync(repoRoot)
			.filter((name) => name.endsWith(".ts"))
			.sort();

		assert.deepStrictEqual(rootTsFiles, ["index.ts"]);
	});

	test("keeps the expected non-empty src modules", () => {
		const srcDir = path.join(repoRoot, "src");
		const actualDirs = fs.readdirSync(srcDir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();

		assert.deepStrictEqual(actualDirs, [...moduleDirs].sort());
		for (const dir of moduleDirs) {
			const tsFiles = fs.readdirSync(path.join(srcDir, dir))
				.filter((name) => name.endsWith(".ts"));
			assert.ok(tsFiles.length > 0, `${dir} should contain TypeScript files`);
		}
	});

	test("documents the src modules in codemap.md", () => {
		const codemapPath = path.join(repoRoot, "codemap.md");
		assert.ok(fs.existsSync(codemapPath), "codemap.md should exist");

		const codemap = fs.readFileSync(codemapPath, "utf8");
		for (const dir of moduleDirs) {
			assert.match(codemap, new RegExp(`src/${dir}`));
		}
	});
});
