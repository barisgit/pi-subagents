import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	appendRunEntry,
	readAllEntries,
	setRegistryPathForTests,
	type RunsRegistryEntry,
} from "../../src/state/runs-registry.ts";

const tmpRoots: string[] = [];

function tmpRegistry(): void {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "root-runid-test-"));
	tmpRoots.push(root);
	setRegistryPathForTests(path.join(root, "nested", "runs-index.jsonl"));
}

function entry(runId: string, rootRunId: string, parentRunId?: string): RunsRegistryEntry {
	return {
		runId,
		rootRunId,
		...(parentRunId ? { parentRunId } : {}),
		runRecordDir: path.join(os.tmpdir(), runId),
		mode: "single",
		source: "sync",
		agentName: "fixer",
		cwd: "/repo",
		startedAt: 1,
	};
}

afterEach(() => {
	setRegistryPathForTests(null);
	for (const root of tmpRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("rootRunId registry denormalization", () => {
	it("persists denormalized rootRunId on every node", () => {
		tmpRegistry();
		const top = entry("run-top", "run-top");
		const nested = entry("run-nested", "run-top", "run-top");

		appendRunEntry(top);
		appendRunEntry(nested);

		const entries = readAllEntries();
		const byId = new Map(entries.map((item) => [item.runId, item]));
		assert.equal(byId.get("run-top")?.rootRunId, "run-top");
		assert.equal(byId.get("run-nested")?.rootRunId, "run-top");
		assert.notEqual(byId.get("run-nested")?.rootRunId, "run-nested");
	});
});
