import * as fs from "node:fs";
import * as path from "node:path";

export type WorkflowGroupLifecycle = "running" | "complete" | "failed";

// A workflow group is intentionally STATUSLESS (no status.json — that would make
// the dashboard treat it as a leaf run and break parent/child nesting). But pure
// child-synthesis (computeGroupStatus) reports an empty-children group as
// 'complete', so an async workflow looks done before its first agent() and in
// any all-settled gap between phases. This separate marker records ORCHESTRATOR
// liveness without ever writing status.json. Best-effort: never throw into a run.
const WORKFLOW_GROUP_STATE_FILE = "workflow-group.json";

export function writeWorkflowGroupState(runRecordDir: string, state: WorkflowGroupLifecycle): void {
	try {
		fs.mkdirSync(runRecordDir, { recursive: true });
		fs.writeFileSync(
			path.join(runRecordDir, WORKFLOW_GROUP_STATE_FILE),
			JSON.stringify({ state, updatedAt: Date.now() }),
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
const WORKFLOW_SCRIPT_FILE = "workflow-script.json";

export function writeWorkflowScript(runRecordDir: string, script: string): void {
	try {
		fs.mkdirSync(runRecordDir, { recursive: true });
		fs.writeFileSync(path.join(runRecordDir, WORKFLOW_SCRIPT_FILE), JSON.stringify({ script }), "utf8");
	} catch {
		/* best-effort; must never break the run */
	}
}

export function readWorkflowScript(runRecordDir: string): string | undefined {
	try {
		const parsed = JSON.parse(fs.readFileSync(path.join(runRecordDir, WORKFLOW_SCRIPT_FILE), "utf8")) as {
			script?: string;
		};
		return typeof parsed.script === "string" && parsed.script.trim() !== "" ? parsed.script : undefined;
	} catch {
		return undefined;
	}
}

export function readWorkflowGroupState(runRecordDir: string): WorkflowGroupLifecycle | undefined {
	try {
		const parsed = JSON.parse(fs.readFileSync(path.join(runRecordDir, WORKFLOW_GROUP_STATE_FILE), "utf8")) as {
			state?: WorkflowGroupLifecycle;
		};
		return parsed.state;
	} catch {
		return undefined;
	}
}
