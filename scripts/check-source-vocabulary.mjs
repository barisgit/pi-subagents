#!/usr/bin/env node
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const forbidden = /\b(charter|mission|goal)s?\b/i;

function listSourceFiles(dir) {
	const entries = readdirSync(join(root, dir), { withFileTypes: true });
	const files = [];
	for (const entry of entries) {
		const name = `${dir}/${entry.name}`;
		if (entry.isDirectory()) files.push(...listSourceFiles(name));
		else if (entry.name.endsWith(".ts")) files.push(name);
	}
	return files;
}

const sourceFiles = [...readdirSync(root).filter((name) => name.endsWith(".ts")), ...listSourceFiles("src")].sort();

function stripComments(line, inBlockComment) {
	let output = "";
	let i = 0;
	while (i < line.length) {
		if (inBlockComment) {
			const end = line.indexOf("*/", i);
			if (end === -1) return { text: output, inBlockComment };
			inBlockComment = false;
			i = end + 2;
			continue;
		}
		if (line.startsWith("//", i)) break;
		if (line.startsWith("/*", i)) {
			inBlockComment = true;
			i += 2;
			continue;
		}
		output += line[i];
		i += 1;
	}
	return { text: output, inBlockComment };
}

const hits = [];
for (const file of sourceFiles) {
	const text = readFileSync(join(root, file), "utf8");
	const lines = text.split(/\r?\n/);
	let inBlockComment = false;
	lines.forEach((line, index) => {
		const stripped = stripComments(line, inBlockComment);
		inBlockComment = stripped.inBlockComment;
		if (forbidden.test(stripped.text)) hits.push(`${file}:${index + 1}: ${line.trim()}`);
	});
}

if (hits.length > 0) {
	console.error("Neutral vocabulary guard failed for extension source:");
	for (const hit of hits) console.error(hit);
	process.exit(1);
}
