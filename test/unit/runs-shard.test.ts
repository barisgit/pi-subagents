import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	appendRunEntry,
	getShardPath,
	readAllEntries,
	readShardEntries,
	setRegistryPathForTests,
	type RunsRegistryEntry,
} from "../../src/state/runs-registry.ts";

const tmpRoots: string[] = [];
let registryPath = "";

function entry(
	runId: string,
	startedAt: number,
	lineage: Partial<Pick<RunsRegistryEntry, "rootSessionId" | "parentSessionId">> = {},
): RunsRegistryEntry {
	return {
		runId,
		runRecordDir: path.join(os.tmpdir(), runId),
		mode: "single",
		source: "async",
		agentName: "fixer",
		cwd: "/repo",
		startedAt,
		...lineage,
	};
}

beforeEach(() => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "runs-shard-test-"));
	tmpRoots.push(root);
	registryPath = path.join(root, "registry", "runs-index.jsonl");
	setRegistryPathForTests(registryPath);
});

afterEach(() => {
	setRegistryPathForTests(null);
	for (const root of tmpRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("runs registry session shards", () => {
	// Mutant note: dropping the shard append makes readShardEntries("host") empty;
	// keying by parentSessionId instead of rootSessionId would put the nested child
	// in "sub" rather than "host".
	it("appendRunEntry with rootSessionId writes global and session shard", () => {
		const run = entry("run-a", 100, { rootSessionId: "host" });
		appendRunEntry(run);

		assert.equal(fs.readFileSync(registryPath, "utf8"), JSON.stringify(run) + "\n");
		assert.equal(fs.readFileSync(getShardPath("host"), "utf8"), JSON.stringify(run) + "\n");
		assert.deepEqual(readShardEntries("host"), [run]);
		assert.deepEqual(readAllEntries(), [run]);
	});

	it("retrying after a shard write failure repairs the missing shard", () => {
		const run = entry("run-repair", 150, { rootSessionId: "host" });
		const sessionsPath = path.dirname(getShardPath("host"));
		fs.mkdirSync(path.dirname(registryPath), { recursive: true });
		fs.writeFileSync(sessionsPath, "not a directory", "utf8");

		appendRunEntry(run);
		fs.rmSync(sessionsPath);
		assert.deepEqual(readShardEntries("host"), []);

		appendRunEntry(run);
		appendRunEntry(run);

		assert.equal(fs.readFileSync(getShardPath("host"), "utf8"), JSON.stringify(run) + "\n");
		assert.deepEqual(readShardEntries("host"), [run]);
		assert.deepEqual(readAllEntries(), [run]);
	});

	it("nested child entries are keyed by rootSessionId before parentSessionId", () => {
		const child = entry("child", 200, { rootSessionId: "host", parentSessionId: "sub" });
		appendRunEntry(child);

		assert.deepEqual(readShardEntries("host"), [child]);
		assert.deepEqual(readShardEntries("sub"), []);
	});

	it("entries without lineage are global-only", () => {
		const run = entry("global-only", 300);
		appendRunEntry(run);

		assert.deepEqual(readAllEntries(), [run]);
		assert.equal(fs.existsSync(path.dirname(getShardPath("unused"))), false);
	});

	it("readShardEntries returns an empty array for missing shards", () => {
		assert.deepEqual(readShardEntries("missing"), []);
	});
});
