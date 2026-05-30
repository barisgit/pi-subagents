import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { assertCompleteResumeTarget, resolveResumeTarget } from "../../subagent-executor.ts";
import { appendRunEntry, setRegistryPathForTests } from "../../runs-registry.ts";
import { createTempDir, removeTempDir } from "../support/helpers.ts";

let tempDir: string | undefined;

afterEach(() => {
	setRegistryPathForTests(null);
	if (tempDir) removeTempDir(tempDir);
	tempDir = undefined;
});

function setup(): string {
	tempDir = createTempDir("pi-subagent-resolve-resume-");
	setRegistryPathForTests(path.join(tempDir, "runs-index.jsonl"));
	return tempDir;
}

function writeStatus(runRecordDir: string, status: Record<string, unknown>): void {
	fs.mkdirSync(runRecordDir, { recursive: true });
	fs.writeFileSync(path.join(runRecordDir, "status.json"), JSON.stringify(status), "utf8");
}

function writeSessionFile(sessionFile: string): void {
	fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
	fs.writeFileSync(sessionFile, "{\"sessionId\":\"same-session\"}\n", "utf8");
}

describe("resolveResumeTarget", () => {
	it("parallel child resolves sessionFile from status.json path", () => {
		const root = setup();
		const runRecordDir = path.join(root, "child-run");
		const sessionFile = path.join(runRecordDir, "custom", "session.jsonl");
		appendRunEntry({ runId: "child-run", runRecordDir, mode: "single", source: "async", agentName: "fixer", parentRunId: "group-run", rootRunId: "group-run", cwd: root, startedAt: 111 });
		writeSessionFile(sessionFile);
		writeStatus(runRecordDir, { runId: "child-run", mode: "single", state: "complete", startedAt: 111, cwd: root, parentRunId: "group-run", sessionFile, steps: [{ agent: "fixer", status: "complete", sessionFile }] });

		const target = resolveResumeTarget("child-run");

		assert.equal(target.sessionFile, sessionFile);
		assert.equal(target.parentRunId, "group-run");
		assert.equal(target.agentName, "fixer");
	});

	it("deterministic fallback resolves run-0/session.jsonl when status lacks sessionFile", () => {
		const root = setup();
		const runRecordDir = path.join(root, "single-run");
		appendRunEntry({ runId: "single-run", runRecordDir, mode: "single", source: "sync", agentName: "explorer", rootRunId: "single-run", cwd: root, startedAt: 222 });
		writeSessionFile(path.join(runRecordDir, "run-0", "session.jsonl"));
		writeStatus(runRecordDir, { runId: "single-run", mode: "single", state: "complete", startedAt: 222, cwd: root, steps: [{ agent: "explorer", status: "complete" }] });

		const target = resolveResumeTarget("single-run");

		assert.equal(target.sessionFile, path.join(runRecordDir, "run-0", "session.jsonl"));
		assert.equal(target.startedAt, 222);
		assert.equal(target.rootRunId, "single-run");
	});

	it("unknown runId is rejected", () => {
		setup();

		assert.throws(() => resolveResumeTarget("missing-run"), /Unknown runId 'missing-run'/);
	});

	it("complete-only gate rejects non-complete disk state", () => {
		assert.throws(() => assertCompleteResumeTarget({ runId: "running-run", state: "running" }), /not complete/);
	});
});
