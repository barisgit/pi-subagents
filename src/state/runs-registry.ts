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
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface RunsRegistryEntry {
	runId: string;
	runRecordDir: string; // canonical: <parentSessionDir>/<runId>/
	mode: "single" | "parallel";
	source: "sync" | "async";
	agentName?: string;
	agentNames?: string[];
	kind?: "workflow";
	phaseIndex?: number;
	phaseTitle?: string;
	parallelGroupId?: string;
	pipelineId?: string;
	pipelineItemIndex?: number;
	pipelineStageIndex?: number;
	pipelineItemLabel?: string;
	label?: string;
	// Immediate dispatcher session (parent subagent for nested runs, user
	// session for top-level runs).
	parentSessionId?: string;
	// Top-of-tree user session. Equal to parentSessionId for top-level dispatches
	// and to the user session for any nested subagent run. Resolved from session
	// lineage first and PI_SUBAGENT_ROOT_SESSION_ID env for subprocess/legacy
	// paths. Used by the /subagents-status overlay to scope to the current
	// session's tree.
	rootSessionId?: string;
	parentRunId?: string;
	// Top-of-tree run id. Equal to runId for top-level dispatches and inherited
	// from the ancestor run for nested subagent dispatches.
	rootRunId?: string;
	cwd: string;
	startedAt: number;
}

const DEFAULT_REGISTRY_PATH = path.join(getAgentDir(), "pi-subagents", "runs-index.jsonl");

let registryPathOverride: string | null = null;

export function setRegistryPathForTests(p: string | null): void {
	registryPathOverride = p;
}

export function getRegistryPath(): string {
	// Test isolation: setRegistryPathForTests wins, then PI_SUBAGENTS_REGISTRY_PATH
	// env (set by integration test scaffolding so subprocess-spawned executors
	// can pick it up without explicit wiring), then the real registry under HOME.
	if (registryPathOverride) return registryPathOverride;
	const envPath = process.env.PI_SUBAGENTS_REGISTRY_PATH;
	if (envPath && envPath.length > 0) return envPath;
	return DEFAULT_REGISTRY_PATH;
}

export function getShardPath(sessionId: string): string {
	return path.join(path.dirname(getRegistryPath()), "sessions", sessionId + ".jsonl");
}

export function appendRunEntry(entry: RunsRegistryEntry): void {
	const filePath = getRegistryPath();
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.appendFileSync(filePath, JSON.stringify(entry) + "\n", "utf8");
	const shardKey = entry.rootSessionId ?? entry.parentSessionId;
	if (shardKey) {
		const shardPath = getShardPath(shardKey);
		fs.mkdirSync(path.dirname(shardPath), { recursive: true });
		fs.appendFileSync(shardPath, JSON.stringify(entry) + "\n", "utf8");
	}
}

export interface ReadOptions {
	limit?: number; // most-recent first; default unlimited
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOptionalString(record: Record<string, unknown>, key: string): boolean {
	return record[key] === undefined || typeof record[key] === "string";
}

function hasOptionalFiniteNumber(record: Record<string, unknown>, key: string): boolean {
	return record[key] === undefined || (typeof record[key] === "number" && Number.isFinite(record[key]));
}

function hasOptionalStringArray(record: Record<string, unknown>, key: string): boolean {
	return (
		record[key] === undefined ||
		(Array.isArray(record[key]) && record[key].every((item) => typeof item === "string"))
	);
}

function isRunsRegistryEntry(value: unknown): value is RunsRegistryEntry {
	if (!isRecord(value)) return false;
	return (
		typeof value.runId === "string" &&
		typeof value.runRecordDir === "string" &&
		(value.mode === "single" || value.mode === "parallel") &&
		(value.source === "sync" || value.source === "async") &&
		typeof value.cwd === "string" &&
		typeof value.startedAt === "number" &&
		Number.isFinite(value.startedAt) &&
		hasOptionalString(value, "agentName") &&
		hasOptionalStringArray(value, "agentNames") &&
		(value.kind === undefined || value.kind === "workflow") &&
		hasOptionalFiniteNumber(value, "phaseIndex") &&
		hasOptionalString(value, "phaseTitle") &&
		hasOptionalString(value, "parallelGroupId") &&
		hasOptionalString(value, "pipelineId") &&
		hasOptionalFiniteNumber(value, "pipelineItemIndex") &&
		hasOptionalFiniteNumber(value, "pipelineStageIndex") &&
		hasOptionalString(value, "pipelineItemLabel") &&
		hasOptionalString(value, "label") &&
		hasOptionalString(value, "parentSessionId") &&
		hasOptionalString(value, "rootSessionId") &&
		hasOptionalString(value, "parentRunId") &&
		hasOptionalString(value, "rootRunId")
	);
}

export function parseRunsRegistryEntryLine(line: string): RunsRegistryEntry | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return undefined;
	}
	return isRunsRegistryEntry(parsed) ? parsed : undefined;
}

function parseEntriesFromFile(filePath: string, opts: ReadOptions): RunsRegistryEntry[] {
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
		const entry = parseRunsRegistryEntryLine(line);
		if (entry) entries.push(entry);
	}
	entries.reverse(); // most-recent first
	return opts.limit !== undefined ? entries.slice(0, opts.limit) : entries;
}

export function readAllEntries(opts: ReadOptions = {}): RunsRegistryEntry[] {
	return parseEntriesFromFile(getRegistryPath(), opts);
}

export function readShardEntries(sessionId: string, opts: ReadOptions = {}): RunsRegistryEntry[] {
	return parseEntriesFromFile(getShardPath(sessionId), opts);
}

export function listRunsByRootRunId(rootRunId: string): RunsRegistryEntry[] {
	return listRunsByRootRunIds([rootRunId]);
}

export function listRunsByRootRunIds(rootRunIds: Iterable<string>): RunsRegistryEntry[] {
	const wanted = new Set(rootRunIds);
	if (wanted.size === 0) return [];
	return readAllEntries().filter((entry) => wanted.has(entry.rootRunId ?? entry.runId));
}
