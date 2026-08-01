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
			}),
			"utf8",
		);
	} catch {
		/* phase marker is best-effort; must never break the run */
	}
}

interface WorkflowGroupRecord {
	state?: WorkflowGroupLifecycle;
	phase?: WorkflowGroupPhase;
}

function readWorkflowGroupRecord(runRecordDir: string): WorkflowGroupRecord | undefined {
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
		return { ...(state ? { state } : {}), ...(phase ? { phase } : {}) };
	} catch {
		return undefined;
	}
}

export function writeWorkflowGroupState(runRecordDir: string, state: WorkflowGroupLifecycle): void {
	try {
		fs.mkdirSync(runRecordDir, { recursive: true });
		const phase = readWorkflowGroupRecord(runRecordDir)?.phase;
		fs.writeFileSync(
			path.join(runRecordDir, WORKFLOW_GROUP_STATE_FILE),
			JSON.stringify({ state, updatedAt: Date.now(), ...phase }),
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
