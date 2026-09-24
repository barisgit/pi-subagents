import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseWorkflowMeta, type WorkflowMeta } from "../protocol/workflow-meta.ts";
import {
	canonicalWorkflowPhaseTitle,
	hasDisplayControlCharacters,
	MAX_WORKFLOW_PHASES,
} from "../shared/workflow-phase-title.ts";

export type WorkflowGroupLifecycle = "running" | "complete" | "failed";

// A workflow group is intentionally STATUSLESS (no status.json — that would make
// the dashboard treat it as a leaf run and break parent/child nesting). But pure
// child-synthesis (computeGroupStatus) reports an empty-children group as
// 'complete', so an async workflow looks done before its first agent() and in
// any all-settled gap between phases. This separate marker records ORCHESTRATOR
// liveness without ever writing status.json. Best-effort: never throw into a run.
const WORKFLOW_GROUP_STATE_FILE = "workflow-group.json";
const WORKFLOW_SCRIPT_FILE = "workflow-script.json";
const WORKFLOW_JOURNAL_FILE = "workflow-journal.jsonl";
const MAX_WORKFLOW_RESULT_BYTES = 8 * 1024;
const WORKFLOW_RESULT_TRUNCATION_MARKER = "\n[TRUNCATED]";

export interface WorkflowGroupPhase {
	phaseIndex: number;
	phaseTitle: string;
	reachedPhaseTitles: string[];
}

export function writeWorkflowGroupPhase(runRecordDir: string, phaseIndex: number, phaseTitle: string): void {
	try {
		fs.mkdirSync(runRecordDir, { recursive: true });
		if (hasDisplayControlCharacters(phaseTitle)) return;
		const title = canonicalWorkflowPhaseTitle(phaseTitle);
		if (!title) return;
		const current = readWorkflowGroupRecord(runRecordDir);
		const declaredTitles = readWorkflowMeta(runRecordDir)?.phases.map((phase) => phase.title);
		const reachedPhaseTitles = (current?.phase?.reachedPhaseTitles ?? []).filter(
			(reachedTitle) => declaredTitles === undefined || declaredTitles.includes(reachedTitle),
		);
		if (
			current?.phase &&
			(declaredTitles === undefined || declaredTitles.includes(current.phase.phaseTitle)) &&
			!reachedPhaseTitles.includes(current.phase.phaseTitle)
		) {
			reachedPhaseTitles.push(current.phase.phaseTitle);
		}
		if ((declaredTitles === undefined || declaredTitles.includes(title)) && !reachedPhaseTitles.includes(title)) {
			reachedPhaseTitles.push(title);
		}
		const boundedReachedPhaseTitles = reachedPhaseTitles.slice(-MAX_WORKFLOW_PHASES);
		fs.writeFileSync(
			path.join(runRecordDir, WORKFLOW_GROUP_STATE_FILE),
			JSON.stringify({
				...(current?.state ? { state: current.state } : {}),
				updatedAt: Date.now(),
				phaseIndex,
				phaseTitle: title,
				reachedPhaseTitles: boundedReachedPhaseTitles,
				...(current?.result ? { result: current.result } : {}),
			}),
			"utf8",
		);
	} catch {
		/* phase marker is best-effort; must never break the run */
	}
}

function stringifyWorkflowGroupResult(value: unknown): string {
	if (typeof value === "string") return value;
	if (value === undefined) return "undefined";
	return JSON.stringify(value, null, 2) ?? "undefined";
}

function truncateWorkflowGroupResult(text: string): string {
	if (Buffer.byteLength(text, "utf8") <= MAX_WORKFLOW_RESULT_BYTES) return text;
	const availableBytes = MAX_WORKFLOW_RESULT_BYTES - Buffer.byteLength(WORKFLOW_RESULT_TRUNCATION_MARKER, "utf8");
	let kept = "";
	let keptBytes = 0;
	for (const character of text) {
		const characterBytes = Buffer.byteLength(character, "utf8");
		if (keptBytes + characterBytes > availableBytes) break;
		kept += character;
		keptBytes += characterBytes;
	}
	return `${kept}${WORKFLOW_RESULT_TRUNCATION_MARKER}`;
}

export function writeWorkflowGroupResult(runRecordDir: string, value: unknown): void {
	try {
		fs.mkdirSync(runRecordDir, { recursive: true });
		const current = readWorkflowGroupRecord(runRecordDir);
		const result = {
			text: truncateWorkflowGroupResult(stringifyWorkflowGroupResult(value)),
			json: typeof value !== "string",
			endedAt: Date.now(),
		};
		fs.writeFileSync(
			path.join(runRecordDir, WORKFLOW_GROUP_STATE_FILE),
			JSON.stringify({
				...(current?.state ? { state: current.state } : {}),
				updatedAt: Date.now(),
				...current?.phase,
				result,
			}),
			"utf8",
		);
	} catch {
		/* result marker is best-effort; must never break the run */
	}
}

export interface WorkflowGroupRecord {
	state?: WorkflowGroupLifecycle;
	phase?: WorkflowGroupPhase;
	result?: { text: string; json: boolean; endedAt: number };
}

export function readWorkflowGroupRecord(runRecordDir: string): WorkflowGroupRecord | undefined {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(path.join(runRecordDir, WORKFLOW_GROUP_STATE_FILE), "utf8"));
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
		const rawState = Reflect.get(parsed, "state");
		const state = rawState === "running" || rawState === "complete" || rawState === "failed" ? rawState : undefined;
		const phaseIndex = Reflect.get(parsed, "phaseIndex");
		const phaseTitle = Reflect.get(parsed, "phaseTitle");
		const rawReachedPhaseTitles = Reflect.get(parsed, "reachedPhaseTitles");
		let reachedPhaseTitles: string[] | undefined;
		if (rawReachedPhaseTitles === undefined) {
			reachedPhaseTitles = [];
		} else if (Array.isArray(rawReachedPhaseTitles) && rawReachedPhaseTitles.length <= MAX_WORKFLOW_PHASES) {
			const normalized: string[] = [];
			reachedPhaseTitles = [];
			for (const rawTitle of rawReachedPhaseTitles) {
				if (typeof rawTitle !== "string" || rawTitle.trim() === "" || hasDisplayControlCharacters(rawTitle)) {
					reachedPhaseTitles = undefined;
					break;
				}
				const title = canonicalWorkflowPhaseTitle(rawTitle);
				if (!normalized.includes(title)) normalized.push(title);
			}
			if (reachedPhaseTitles !== undefined) reachedPhaseTitles = normalized;
		}
		const phase =
			Number.isInteger(phaseIndex) &&
			typeof phaseIndex === "number" &&
			phaseIndex > 0 &&
			typeof phaseTitle === "string" &&
			phaseTitle.trim() !== "" &&
			!hasDisplayControlCharacters(phaseTitle) &&
			reachedPhaseTitles !== undefined
				? {
						phaseIndex,
						phaseTitle: canonicalWorkflowPhaseTitle(phaseTitle),
						reachedPhaseTitles,
					}
				: undefined;
		const rawResult = Reflect.get(parsed, "result");
		let result: WorkflowGroupRecord["result"];
		if (rawResult !== null && typeof rawResult === "object" && !Array.isArray(rawResult)) {
			const text = Reflect.get(rawResult, "text");
			const json = Reflect.get(rawResult, "json");
			const endedAt = Reflect.get(rawResult, "endedAt");
			if (
				typeof text === "string" &&
				Buffer.byteLength(text, "utf8") <= MAX_WORKFLOW_RESULT_BYTES &&
				typeof json === "boolean" &&
				typeof endedAt === "number" &&
				Number.isFinite(endedAt)
			) {
				result = { text, json, endedAt };
			}
		}
		return { ...(state ? { state } : {}), ...(phase ? { phase } : {}), ...(result ? { result } : {}) };
	} catch {
		return undefined;
	}
}

export function writeWorkflowGroupState(runRecordDir: string, state: WorkflowGroupLifecycle): void {
	try {
		fs.mkdirSync(runRecordDir, { recursive: true });
		const current = readWorkflowGroupRecord(runRecordDir);
		fs.writeFileSync(
			path.join(runRecordDir, WORKFLOW_GROUP_STATE_FILE),
			JSON.stringify({
				state,
				updatedAt: Date.now(),
				...current?.phase,
				...(current?.result ? { result: current.result } : {}),
			}),
			"utf8",
		);
	} catch {
		/* liveness marker is best-effort; must never break the run */
	}
}

// The script that produced a workflow group, persisted so the dashboard can
// show WHAT the orchestration does (not just its children). Separate file from
// the lifecycle marker so state flips never clobber it. Best-effort like the
// lifecycle marker: never throw into a run.
export function writeWorkflowScript(runRecordDir: string, script: string): void {
	try {
		fs.mkdirSync(runRecordDir, { recursive: true });
		fs.writeFileSync(path.join(runRecordDir, WORKFLOW_SCRIPT_FILE), JSON.stringify({ script }), "utf8");
	} catch {
		/* best-effort; must never break the run */
	}
}

function readWorkflowScriptFile(runRecordDir: string): { script?: string; meta?: WorkflowMeta } | undefined {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(path.join(runRecordDir, WORKFLOW_SCRIPT_FILE), "utf8"));
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
		const rawScript = Reflect.get(parsed, "script");
		const rawMeta = Reflect.get(parsed, "meta");
		const metadata = rawMeta === undefined ? undefined : parseWorkflowMeta(rawMeta);
		return {
			...(typeof rawScript === "string" && rawScript.trim() !== "" ? { script: rawScript } : {}),
			...(metadata?.ok ? { meta: metadata.value } : {}),
		};
	} catch {
		return undefined;
	}
}

export function writeWorkflowMeta(runRecordDir: string, meta: WorkflowMeta): void {
	try {
		const current = readWorkflowScriptFile(runRecordDir);
		if (!current?.script) return;
		fs.writeFileSync(
			path.join(runRecordDir, WORKFLOW_SCRIPT_FILE),
			JSON.stringify({ script: current.script, meta }),
			"utf8",
		);
	} catch {
		/* best-effort; must never break the run */
	}
}

export function readWorkflowScript(runRecordDir: string): string | undefined {
	return readWorkflowScriptFile(runRecordDir)?.script;
}

export function readWorkflowMeta(runRecordDir: string): WorkflowMeta | undefined {
	return readWorkflowScriptFile(runRecordDir)?.meta;
}

export function readWorkflowGroupState(runRecordDir: string): WorkflowGroupLifecycle | undefined {
	return readWorkflowGroupRecord(runRecordDir)?.state;
}

export function readWorkflowGroupPhase(runRecordDir: string): WorkflowGroupPhase | undefined {
	return readWorkflowGroupRecord(runRecordDir)?.phase;
}

// Replay journal for workflow resume, kept in the workflow's own directory.
// Append-only JSONL keyed by agent() call:
// - { key, runId } when the call's child run starts, so an unfinished child can
//   later be continued in place from its own session;
// - { key, result } when the call SUCCEEDS, holding the exact value agent()
//   returned into the script.
// Resuming re-runs the script in the same workflow: journaled results are
// returned without dispatching, and started-but-unfinished calls continue their
// child run.
//
// Unlike the other markers this is written synchronously BEFORE the value is
// handed to the script: any later effect that depends on a result can only exist
// if the result was journaled first. Still best-effort: a failed write only
// means that call runs again on resume.
export function workflowCallKey(role: string, task: string, schema: unknown, cwd: string | undefined): string {
	// Label and phase are display-only and deliberately excluded, so editing them in
	// a resumed script does not invalidate cached results. Schema and cwd change what
	// the child produces, so they are part of the identity.
	return createHash("sha256")
		.update(JSON.stringify([role, task, schema ?? null, cwd ?? null]))
		.digest("hex");
}

export type WorkflowJournalLine = { key: string; result: unknown } | { key: string; runId: string };

export function appendWorkflowJournal(runRecordDir: string, line: WorkflowJournalLine): void {
	try {
		fs.appendFileSync(path.join(runRecordDir, WORKFLOW_JOURNAL_FILE), `${JSON.stringify(line)}\n`, "utf8");
	} catch {
		/* best-effort; the call simply runs again on resume */
	}
}

export interface WorkflowJournal {
	results: Map<string, unknown>;
	// Latest child run per call key; only meaningful for keys without a result.
	runIds: Map<string, string>;
}

// Malformed lines (e.g. a torn final line after a crash) are skipped: a missing
// entry only costs a re-run, never a wrong replayed value.
export function readWorkflowJournal(runRecordDir: string): WorkflowJournal {
	const journal: WorkflowJournal = { results: new Map(), runIds: new Map() };
	let raw: string;
	try {
		raw = fs.readFileSync(path.join(runRecordDir, WORKFLOW_JOURNAL_FILE), "utf8");
	} catch {
		return journal;
	}
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			const parsed: unknown = JSON.parse(line);
			if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
			const key = Reflect.get(parsed, "key");
			if (typeof key !== "string") continue;
			const runId = Reflect.get(parsed, "runId");
			if ("result" in parsed) journal.results.set(key, Reflect.get(parsed, "result"));
			else if (typeof runId === "string") journal.runIds.set(key, runId);
		} catch {
			/* skip malformed line */
		}
	}
	return journal;
}
