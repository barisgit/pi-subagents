// Append-only registry of subagent runs (sync + async, in-process).
//
// One JSONL line per top-level dispatch. The registry is the SINGLE source of
// truth for run discovery: the /subagents-status overlay, the /runs slash
// command, and the right-pane transcript reader all resolve runRecordDir from
// here. No code scans temp directories for runs.
//
// File: ~/.pi/agent/pi-subagents/runs-index.jsonl
//
// Lines are appended with fs.appendFileSync, which is atomic on POSIX for
// writes smaller than PIPE_BUF (~4KB); each record is well below that limit.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface RunsRegistryEntry {
	runId: string;
	runRecordDir: string; // canonical: <parentSessionDir>/<runId>/
	mode: "single" | "chain" | "parallel";
	source: "sync" | "async";
	agentName?: string;
	agentNames?: string[];
	label?: string;
	parentSessionId?: string;
	parentRunId?: string;
	cwd: string;
	startedAt: number;
}

const DEFAULT_REGISTRY_PATH = path.join(os.homedir(), ".pi", "agent", "pi-subagents", "runs-index.jsonl");

let registryPathOverride: string | null = null;

export function setRegistryPathForTests(p: string | null): void {
	registryPathOverride = p;
}

export function getRegistryPath(): string {
	return registryPathOverride ?? DEFAULT_REGISTRY_PATH;
}

export function appendRunEntry(entry: RunsRegistryEntry): void {
	const filePath = getRegistryPath();
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.appendFileSync(filePath, JSON.stringify(entry) + "\n", "utf8");
}

export interface ReadOptions {
	limit?: number; // most-recent first; default unlimited
}

export function readAllEntries(opts: ReadOptions = {}): RunsRegistryEntry[] {
	const filePath = getRegistryPath();
	let raw: string;
	try {
		raw = fs.readFileSync(filePath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const entries: RunsRegistryEntry[] = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			const parsed = JSON.parse(line) as RunsRegistryEntry;
			if (parsed && typeof parsed.runId === "string" && typeof parsed.runRecordDir === "string") {
				entries.push(parsed);
			}
		} catch {
			// Skip malformed line; keep registry forgiving.
		}
	}
	entries.reverse(); // most-recent first
	return opts.limit !== undefined ? entries.slice(0, opts.limit) : entries;
}
