import * as fs from "node:fs";
import * as path from "node:path";
import { get_encoding } from "tiktoken";

export const DESCRIPTION_TOKEN_LIMIT = 700;

export function countCl100kTokens(text: string): number {
	const encoding = get_encoding("cl100k_base");
	try {
		return encoding.encode(text).length;
	} finally {
		encoding.free();
	}
}

export function descriptionTokenCheck(text: string, limit = DESCRIPTION_TOKEN_LIMIT): { count: number; limit: number; ok: boolean } {
	const count = countCl100kTokens(text);
	return { count, limit, ok: count <= limit };
}

export function readRegisteredSubagentDescription(indexPath = path.resolve("index.ts")): string {
	const source = fs.readFileSync(indexPath, "utf-8");
	const match = source.match(/name:\s*"subagent",[\s\S]*?description:\s*((?:`(?:\\[\s\S]|[^`])*`))[\s,]*\n\t\tparameters: SubagentParams,/);
	if (!match) throw new Error(`expected to find registered subagent tool description in ${indexPath}`);
	const literal = match[1]!;
	if (/\$\{/.test(literal)) throw new Error("subagent description must be a static template literal");
	return Function(`"use strict"; return ${literal};`)() as string;
}
