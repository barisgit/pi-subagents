import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	appendRunEntry,
	parseRunsRegistryEntryLine,
	readAllEntries,
	setRegistryPathForTests,
	type RunsRegistryEntry,
} from "../../src/state/runs-registry.ts";

const tmpRoots: string[] = [];

function tmpRegistry(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "runs-registry-test-"));
	tmpRoots.push(root);
	const registryPath = path.join(root, "nested", "runs-index.jsonl");
	setRegistryPathForTests(registryPath);
	return registryPath;
}

function entry(runId: string, startedAt: number): RunsRegistryEntry {
	return {
		runId,
		runRecordDir: path.join(os.tmpdir(), runId),
		mode: "single",
		source: "async",
		agentName: "fixer",
		cwd: "/repo",
		startedAt,
	};
}

afterEach(() => {
	setRegistryPathForTests(null);
	for (const root of tmpRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("runs registry", () => {
	it("appendRunEntry creates the parent dir and writes a JSONL line", () => {
		const registryPath = tmpRegistry();
		const first = entry("run-a", 100);
		appendRunEntry(first);

		assert.equal(fs.existsSync(path.dirname(registryPath)), true);
		const lines = fs.readFileSync(registryPath, "utf-8").trim().split("\n");
		assert.equal(lines.length, 1);
		assert.deepEqual(JSON.parse(lines[0]!), first);
	});

	it("readAllEntries roundtrips appended entries", () => {
		tmpRegistry();
		const first = entry("run-a", 100);
		appendRunEntry(first);
		assert.deepEqual(readAllEntries(), [first]);
	});

	it("returns multiple entries newest-first", () => {
		tmpRegistry();
		const older = entry("older", 100);
		const newer = entry("newer", 200);
		appendRunEntry(older);
		appendRunEntry(newer);
		assert.deepEqual(
			readAllEntries().map((e) => e.runId),
			["newer", "older"],
		);
	});

	it("rejects records with invalid required or optional fields", () => {
		const valid = entry("valid", 100);
		const invalid = [
			{ ...valid, mode: "chain" },
			{ ...valid, source: "process" },
			{ ...valid, cwd: 42 },
			{ ...valid, startedAt: Number.NaN },
			{ ...valid, agentNames: ["A", 42] },
			{ ...valid, phaseIndex: "one" },
			{ runId: valid.runId, runRecordDir: valid.runRecordDir },
		];

		for (const record of invalid) assert.equal(parseRunsRegistryEntryLine(JSON.stringify(record)), undefined);
		assert.deepEqual(parseRunsRegistryEntryLine(JSON.stringify(valid)), valid);
	});

	it("skips malformed lines", () => {
		const registryPath = tmpRegistry();
		const good = entry("good", 100);
		fs.mkdirSync(path.dirname(registryPath), { recursive: true });
		fs.writeFileSync(registryPath, `not-json\n${JSON.stringify(good)}\n{}\n`, "utf-8");
		assert.deepEqual(readAllEntries(), [good]);
	});

	it("respects the limit option", () => {
		tmpRegistry();
		appendRunEntry(entry("oldest", 100));
		appendRunEntry(entry("middle", 200));
		appendRunEntry(entry("newest", 300));
		assert.deepEqual(
			readAllEntries({ limit: 2 }).map((e) => e.runId),
			["newest", "middle"],
		);
	});
});
