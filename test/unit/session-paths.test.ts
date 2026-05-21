import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { resolveChildSessionFile } from "../../session-paths.ts";

const cleanup: string[] = [];

after(() => {
	for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	cleanup.push(dir);
	return dir;
}

describe("resolveChildSessionFile", () => {
	it("forkContextFile no longer collapses the run path onto the source file", () => {
		const root = tempDir("pi-session-paths-fork-");
		const base = path.join(root, "sessions");
		const forkSource = path.join(root, "parent-session.jsonl");
		const resolved = resolveChildSessionFile({
			parentCwd: root,
			parentSessionFile: forkSource,
			runId: "run-1",
			stepIndex: 2,
			sessionDirOverride: base,
			forkContextFile: forkSource,
		});

		// Fork runs use the canonical layout; the source file is only a seed,
		// not a path override (see in-process-executor.ts seedForkSessionFile).
		assert.equal(resolved.runRecordDir, path.join(base, "run-1"));
		assert.equal(resolved.sessionRoot, path.join(base, "run-1"));
		assert.equal(resolved.sessionFile, path.join(base, "run-1", "run-2", "session.jsonl"));
	});

	it("uses sessionDirOverride before all other bases while still appending run and step", () => {
		const root = tempDir("pi-session-paths-override-");
		const base = path.join(root, "sessions");
		const resolved = resolveChildSessionFile({
			parentCwd: root,
			parentSessionFile: path.join(root, "parent.jsonl"),
			runId: "run-2",
			stepIndex: 3,
			sessionDirOverride: base,
			defaultSessionDir: path.join(root, "default"),
		});

		assert.equal(resolved.runRecordDir, path.join(base, "run-2"));
		assert.equal(resolved.sessionRoot, path.join(base, "run-2"));
		assert.equal(resolved.sessionFile, path.join(base, "run-2", "run-3", "session.jsonl"));
	});

	it("uses defaultSessionDir when no explicit sessionDirOverride is provided", () => {
		const root = tempDir("pi-session-paths-default-");
		const base = path.join(root, "default-sessions");
		const resolved = resolveChildSessionFile({
			parentCwd: root,
			parentSessionFile: path.join(root, "parent.jsonl"),
			runId: "run-3",
			stepIndex: 0,
			defaultSessionDir: base,
		});

		assert.equal(resolved.runRecordDir, path.join(base, "run-3"));
		assert.equal(resolved.sessionRoot, path.join(base, "run-3"));
		assert.equal(resolved.sessionFile, path.join(base, "run-3", "run-0", "session.jsonl"));
	});

	it("derives the base from the parent session filename slug", () => {
		const root = tempDir("pi-session-paths-parent-");
		const parentSessionFile = path.join(root, "sessions", "abc123.jsonl");
		const resolved = resolveChildSessionFile({
			parentCwd: root,
			parentSessionFile,
			runId: "run-4",
			stepIndex: 1,
		});

		const base = path.join(path.dirname(parentSessionFile), "abc123");
		assert.equal(resolved.runRecordDir, path.join(base, "run-4"));
		assert.equal(resolved.sessionRoot, path.join(base, "run-4"));
		assert.equal(resolved.sessionFile, path.join(base, "run-4", "run-1", "session.jsonl"));
	});

	it("creates and uses a mkdtemp fallback base when no session base exists", () => {
		const root = tempDir("pi-session-paths-mkdtemp-");
		const resolved = resolveChildSessionFile({
			parentCwd: root,
			parentSessionFile: null,
			runId: "run-5",
			stepIndex: 4,
		});

		const fallbackBase = path.dirname(resolved.runRecordDir);
		cleanup.push(fallbackBase);
		assert.equal(path.basename(resolved.runRecordDir), "run-5");
		assert.equal(resolved.sessionRoot, resolved.runRecordDir);
		assert.equal(resolved.sessionFile, path.join(resolved.runRecordDir, "run-4", "session.jsonl"));
		assert.match(path.basename(fallbackBase), /^pi-subagent-session-/);
		assert.equal(fs.existsSync(fallbackBase), true);
	});
});
