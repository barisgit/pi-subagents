import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { inspectSubagentStatus } from "../../run-status.ts";
import { appendRunEntry, setRegistryPathForTests } from "../../runs-registry.ts";

const tmpRoots: string[] = [];

afterEach(() => {
	setRegistryPathForTests(null);
	for (const root of tmpRoots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

function tmpRegistry(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "group-status-inspect-"));
	tmpRoots.push(root);
	setRegistryPathForTests(path.join(root, "registry", "runs-index.jsonl"));
	return root;
}

function seedChild(root: string, runId: string, parentRunId: string, agentName: string, state: "complete" | "failed"): void {
	const runRecordDir = path.join(root, "runs", runId);
	fs.mkdirSync(runRecordDir, { recursive: true });
	fs.writeFileSync(
		path.join(runRecordDir, "status.json"),
		JSON.stringify({
			runId,
			mode: "single",
			state,
			startedAt: 1000,
			endedAt: 2000,
			lastUpdate: 2000,
			cwd: root,
			currentStep: 0,
			parentRunId,
			steps: [{ agent: agentName, status: state, startedAt: 1000, endedAt: 2000 }],
		}),
		"utf8",
	);
	appendRunEntry({
		runId,
		runRecordDir,
		mode: "single",
		source: "async",
		cwd: root,
		startedAt: 1000,
		agentName,
		parentRunId,
		rootRunId: parentRunId,
	});
}

// A workflow/parallel GROUP container has no status.json of its own — its state
// is synthesized from children. `status id=<group>` must fall back to the
// registry summary instead of returning "Status file not found."
describe("group container status inspect", () => {
	it("synthesizes a workflow group's status from its children", () => {
		const root = tmpRegistry();
		const groupDir = path.join(root, "runs", "wf-group");
		fs.mkdirSync(groupDir, { recursive: true });
		appendRunEntry({
			runId: "wf-group",
			runRecordDir: groupDir,
			mode: "parallel",
			source: "async",
			cwd: root,
			startedAt: 500,
			kind: "workflow",
			rootRunId: "wf-group",
		});
		seedChild(root, "wf-child-a", "wf-group", "explorer", "complete");
		seedChild(root, "wf-child-b", "wf-group", "qa", "complete");

		const result = inspectSubagentStatus({ id: "wf-group" });
		assert.equal(result.isError ?? false, false, "group inspect must not error");
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		assert.match(text, /Run: wf-group/);
		assert.match(text, /Mode: parallel \(workflow\)/);
		assert.match(text, /Child: wf-child/);
		assert.match(text, /explorer \| complete/);
		assert.match(text, /qa \| complete/);
		assert.doesNotMatch(text, /Status file not found/);
	});

	it("still reports not-found for a genuinely unknown id", () => {
		tmpRegistry();
		const result = inspectSubagentStatus({ id: "no-such-run" });
		assert.equal(result.isError, true);
	});
});
