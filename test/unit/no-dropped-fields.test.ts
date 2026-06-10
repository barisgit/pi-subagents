import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

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
	"includeProgress",
] as const;

const droppedCrudVerbs = ["create", "update", "delete", "get"] as const;
const droppedNames = [...droppedFields, ...droppedCrudVerbs] as const;

const testDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDir, "..", "..");
const thisFile = fileURLToPath(import.meta.url);

function sourceFiles(dir: string): string[] {
	if (!fs.existsSync(dir)) return [];
	const entries = fs.readdirSync(dir, { withFileTypes: true });
	return entries.flatMap((entry) => {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) return sourceFiles(full);
		return /\.(?:ts|tsx|js|mjs)$/.test(entry.name) ? [full] : [];
	});
}

function linesWithNumbers(file: string): Array<{ line: string; number: number }> {
	return fs.readFileSync(file, "utf-8").split("\n").map((line, index) => ({ line, number: index + 1 }));
}

function lineIsComment(line: string): boolean {
	const trimmed = line.trimStart();
	return trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*");
}

function wordPattern(name: string): RegExp {
	return new RegExp(`\\b${name}\\b`);
}

function readRegisteredSubagentDescription(): string {
	const indexSource = fs.readFileSync(path.join(projectRoot, "index.ts"), "utf-8");
	const match = indexSource.match(/name:\s*"subagent",[\s\S]*?description:\s*`([\s\S]*?)`,\n\t\tparameters: SubagentParams,/);
	assert.ok(match, "expected to find the registered subagent tool description");
	return match[1]!;
}

function uncommentedLines(text: string): string[] {
	return text.split("\n").filter((line) => !lineIsComment(line));
}

function extractFunction(source: string, name: string): string {
	const marker = `function ${name}`;
	const start = source.indexOf(marker);
	assert.notEqual(start, -1, `expected ${name} function`);
	const brace = source.indexOf("{", start);
	assert.notEqual(brace, -1, `expected ${name} body`);
	let depth = 0;
	for (let index = brace; index < source.length; index++) {
		const char = source[index];
		if (char === "{") depth++;
		if (char === "}") depth--;
		if (depth === 0) return source.slice(start, index + 1);
	}
	throw new Error(`unterminated ${name} function`);
}

function canonicalExecutorPrelude(): string {
	const source = fs.readFileSync(path.join(projectRoot, "subagent-executor.ts"), "utf-8");
	const start = source.indexOf("export function createSubagentExecutor");
	assert.notEqual(start, -1, "expected createSubagentExecutor");
	const end = source.indexOf("\n\t\tconst requestCwd", start);
	assert.notEqual(end, -1, "expected canonical validation prelude before legacy execution");
	return source.slice(start, end);
}

describe("no dropped fields", () => {
	it("no-dropped-fields", () => {
		const srcRoot = path.join(projectRoot, "src");
		const files = sourceFiles(srcRoot);
		const failures: string[] = [];

		for (const file of files) {
			if (file === thisFile) continue;
			for (const { line, number } of linesWithNumbers(file)) {
				if (lineIsComment(line)) continue;
				for (const name of droppedNames) {
					if (wordPattern(name).test(line)) failures.push(`${path.relative(projectRoot, file)}:${number}: ${name}: ${line.trim()}`);
				}
			}
		}

		assert.deepEqual(failures, []);
	});

	it("tool-description-clean", () => {
		const description = readRegisteredSubagentDescription();

		for (const name of droppedFields) assert.doesNotMatch(description, wordPattern(name), `${name} leaked into tool description`);
		for (const verb of droppedCrudVerbs) assert.doesNotMatch(description, wordPattern(verb), `${verb} leaked into tool description`);
		assert.match(description, /agents\/<name>\.md/, "description should point to file-based agent authoring");
	});

	it("crud-verb-absence", () => {
		const schemas = fs.readFileSync(path.join(projectRoot, "schemas.ts"), "utf-8");
		const management = fs.readFileSync(path.join(projectRoot, "agent-management.ts"), "utf-8");
		const dispatchHandler = extractFunction(management, "handleManagementAction");

		for (const verb of droppedCrudVerbs) {
			assert.doesNotMatch(schemas, new RegExp(`Type\\.Literal\\("${verb}"\\)`), `${verb} remained in action schema`);
			assert.doesNotMatch(dispatchHandler, new RegExp(`case "${verb}"`), `${verb} remained in management dispatch`);
		}
	});

	it("no-aliases-or-shims", () => {
		const schemas = uncommentedLines(fs.readFileSync(path.join(projectRoot, "schemas.ts"), "utf-8")).join("\n");
		const prelude = uncommentedLines(canonicalExecutorPrelude()).join("\n");

		for (const name of droppedFields) {
			assert.doesNotMatch(schemas, new RegExp(`${name}:\\s*Type\\.Optional`), `${name} remained optional in schema`);
		}
		assert.doesNotMatch(prelude, /\bprompt\s*:/, "canonical entry still builds prompt shorthand");
		assert.doesNotMatch(prelude, /\btasks\s*:/, "canonical entry still builds tasks shorthand");
	});
});
