import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { computeGroupStatus, openGroup } from "../../layer0-runs.ts";
import { readAllEntries, setRegistryPathForTests } from "../../runs-registry.ts";

const tmpRoots: string[] = [];
let previousHome: string | undefined;

function setupTempHome(prefix: string): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tmpRoots.push(root);
	previousHome = process.env.HOME;
	process.env.HOME = root;
	setRegistryPathForTests(path.join(root, ".pi", "agent", "pi-subagents", "runs-index.jsonl"));
	return root;
}

afterEach(() => {
	setRegistryPathForTests(null);
	if (previousHome === undefined) delete process.env.HOME;
	else process.env.HOME = previousHome;
	previousHome = undefined;
	for (const root of tmpRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Layer-0 group node", () => {
	it("group node has no agentName and an aggregate status derived from children", () => {
		const root = setupTempHome("layer0-group-node-test-");

		const group = openGroup({
			cwd: root,
			rootRunId: "root-run",
			notifyPolicy: "silent",
			defaultSessionDir: path.join(root, "runs"),
		});

		const entries = readAllEntries();
		assert.equal(entries.length, 1);
		assert.equal(entries[0]?.runId, group.runId);
		assert.equal(entries[0]?.agentName, undefined);
		assert.equal(Object.hasOwn(entries[0] ?? {}, "agentName"), false);

		assert.equal(computeGroupStatus(["complete", "running"]), "running");
		assert.equal(computeGroupStatus(["complete", "complete"]), "complete");
		assert.equal(computeGroupStatus(["complete", "failed"]), "failed");
	});
});
