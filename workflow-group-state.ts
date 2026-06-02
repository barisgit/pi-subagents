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
		fs.writeFileSync(path.join(runRecordDir, WORKFLOW_GROUP_STATE_FILE), JSON.stringify({ state, updatedAt: Date.now() }), "utf8");
	} catch { /* liveness marker is best-effort; must never break the run */ }
}

export function readWorkflowGroupState(runRecordDir: string): WorkflowGroupLifecycle | undefined {
	try {
		const parsed = JSON.parse(fs.readFileSync(path.join(runRecordDir, WORKFLOW_GROUP_STATE_FILE), "utf8")) as { state?: WorkflowGroupLifecycle };
		return parsed.state;
	} catch { return undefined; }
}
