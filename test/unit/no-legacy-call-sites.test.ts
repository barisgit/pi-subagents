import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDir, "..", "..");
const thisFile = fileURLToPath(import.meta.url);

const skippedDirs = new Set([".git", "node_modules", ".pi", "lib", "skills"]);
const scannedExtensions = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".md"]);
const legacyAllowed = new Set([
	path.join(projectRoot, "docs/schema-decisions.md"),
	path.join(projectRoot, "skills/subagent/references/migration.md"),
	thisFile,
]);
const rejectionFixtureFiles = new Set([
	path.join(projectRoot, "test/integration/dispatch-shapes.test.ts"),
]);
const removedCrudActions = new Set(["create", "update", "delete", "get"]);

interface TopLevelKey {
	name: string;
	colonIndex: number;
}

function listFiles(root: string): string[] {
	if (!fs.existsSync(root)) return [];
	const stat = fs.statSync(root);
	if (stat.isFile()) return scannedExtensions.has(path.extname(root)) ? [root] : [];
	const entries = fs.readdirSync(root, { withFileTypes: true });
	return entries.flatMap((entry) => {
		if (entry.isDirectory() && skippedDirs.has(entry.name)) return [];
		const full = path.join(root, entry.name);
		if (entry.isDirectory()) return listFiles(full);
		return scannedExtensions.has(path.extname(entry.name)) ? [full] : [];
	});
}

function rel(file: string): string {
	return path.relative(projectRoot, file) || path.basename(file);
}

function lineFor(source: string, index: number): number {
	return source.slice(0, index).split("\n").length;
}

function readScanned(paths: string[]): Array<{ file: string; source: string }> {
	return [...new Set(paths.flatMap((root) => listFiles(root)))].map((file) => ({ file, source: fs.readFileSync(file, "utf-8") }));
}

function findMatching(source: string, start: number, open: string, close: string): number {
	let depth = 0;
	let quote: string | null = null;
	let inLineComment = false;
	let inBlockComment = false;
	for (let i = start; i < source.length; i++) {
		const char = source[i]!;
		const next = source[i + 1];
		if (inLineComment) {
			if (char === "\n") inLineComment = false;
			continue;
		}
		if (inBlockComment) {
			if (char === "*" && next === "/") { inBlockComment = false; i++; }
			continue;
		}
		if (quote) {
			if (char === "\\") { i++; continue; }
			if (char === quote) quote = null;
			continue;
		}
		if (char === "/" && next === "/") { inLineComment = true; i++; continue; }
		if (char === "/" && next === "*") { inBlockComment = true; i++; continue; }
		if (char === '"' || char === "'" || char === "`") { quote = char; continue; }
		if (char === open) depth++;
		if (char === close) {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

function topLevelKeys(objectSource: string): TopLevelKey[] {
	const keys: TopLevelKey[] = [];
	let depth = 0;
	let quote: string | null = null;
	let inLineComment = false;
	let inBlockComment = false;
	for (let i = 0; i < objectSource.length; i++) {
		const char = objectSource[i]!;
		const next = objectSource[i + 1];
		if (inLineComment) {
			if (char === "\n") inLineComment = false;
			continue;
		}
		if (inBlockComment) {
			if (char === "*" && next === "/") { inBlockComment = false; i++; }
			continue;
		}
		if (quote) {
			if (char === "\\") { i++; continue; }
			if (char === quote) quote = null;
			continue;
		}
		if (char === "/" && next === "/") { inLineComment = true; i++; continue; }
		if (char === "/" && next === "*") { inBlockComment = true; i++; continue; }
		if (char === '"' || char === "'" || char === "`") { quote = char; continue; }
		if (char === "{" || char === "[" || char === "(") { depth++; continue; }
		if (char === "}" || char === "]" || char === ")") { depth--; continue; }
		if (char !== ":" || depth !== 1) continue;
		const before = objectSource.slice(0, i).match(/(?:^|[,{}\s])([A-Za-z_$][\w$]*)\s*$/);
		if (before?.[1]) keys.push({ name: before[1], colonIndex: i });
	}
	return keys;
}

function stringValueAfterColon(objectSource: string, colonIndex: number): string | undefined {
	const match = objectSource.slice(colonIndex + 1).match(/^\s*(["'])([^"']+)\1/);
	return match?.[2];
}

function scanLegacyCalls(file: string, source: string): string[] {
	if (rejectionFixtureFiles.has(file)) return [];
	const failures: string[] = [];
	const callPattern = /\bsubagent\s*\(/g;
	for (let match = callPattern.exec(source); match; match = callPattern.exec(source)) {
		const callStart = match.index;
		const objectStart = source.indexOf("{", callPattern.lastIndex);
		const closeParen = findMatching(source, callPattern.lastIndex - 1, "(", ")");
		if (objectStart === -1 || closeParen === -1 || objectStart > closeParen) continue;
		const objectEnd = findMatching(source, objectStart, "{", "}");
		if (objectEnd === -1 || objectEnd > closeParen) continue;
		const objectSource = source.slice(objectStart, objectEnd + 1);
		const keys = topLevelKeys(objectSource);
		for (const key of keys) {
			if (key.name === "task" || key.name === "tasks") {
				failures.push(`${rel(file)}:${lineFor(source, callStart)}: top-level ${key.name} in subagent(...)`);
			}
			if (key.name === "action") {
				const value = stringValueAfterColon(objectSource, key.colonIndex);
				if (value && removedCrudActions.has(value)) failures.push(`${rel(file)}:${lineFor(source, callStart)}: legacy CRUD action ${value} in subagent(...)`);
			}
		}
	}
	return failures;
}

function assertClean(label: string, roots: string[]): void {
	const failures: string[] = [];
	for (const { file, source } of readScanned(roots)) {
		failures.push(...scanLegacyCalls(file, source));
		if (!legacyAllowed.has(file) && source.includes("LegacySubagentParamsLike")) {
			failures.push(`${rel(file)}:${lineFor(source, source.indexOf("LegacySubagentParamsLike"))}: LegacySubagentParamsLike`);
		}
	}
	assert.deepEqual(failures, [], label);
}

test("no legacy call sites", async (t) => {
	await t.test("no-legacy-call-sites", () => {
		assertClean("project call sites are slim", [projectRoot]);
	});

	await t.test("agent-files-clean", () => {
		assertClean("agent files are slim", [path.join(projectRoot, "agents")]);
	});

	await t.test("legacy-files-clean", () => {
		assertClean("legacy files are slim", [path.join(projectRoot, "legacy")]);
	});

	await t.test("scripts-clean", () => {
		assertClean("scripts are slim", [path.join(projectRoot, "scripts")]);
	});

	await t.test("no-legacy-type-alias", () => {
		const failures = readScanned([projectRoot])
			.filter(({ file }) => !legacyAllowed.has(file))
			.filter(({ source }) => source.includes("LegacySubagentParamsLike"))
			.map(({ file, source }) => `${rel(file)}:${lineFor(source, source.indexOf("LegacySubagentParamsLike"))}`);
		assert.deepEqual(failures, []);
	});

	await t.test("suite-green-after-migration", (subtest) => {
		if (process.env.PI_NO_LEGACY_CALL_SITES_SKIP_SUITE === "1") {
			subtest.skip("skipping recursive npm run test:all invocation");
			return;
		}
		const result = spawnSync("npm", ["run", "test:all"], {
			cwd: projectRoot,
			encoding: "utf-8",
			stdio: "pipe",
			env: { ...process.env, PI_NO_LEGACY_CALL_SITES_SKIP_SUITE: "1" },
		});
		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
	});
});
