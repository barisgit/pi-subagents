import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { inspectSubagentStatus } from "../../src/state/run-status.ts";
import { appendRunEntry, setRegistryPathForTests, type RunsRegistryEntry } from "../../src/state/runs-registry.ts";
import type { AsyncStatus } from "../../src/protocol/types.ts";

const tmpRoots: string[] = [];
const originalHome = process.env.HOME;

function tmpRegistry(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "action-status-list-"));
	tmpRoots.push(root);
	process.env.HOME = root;
	setRegistryPathForTests(path.join(root, "registry", "runs-index.jsonl"));
	return root;
}

function appendStatusRun(root: string, entry: {
	runId: string;
	agentName: string;
	state: AsyncStatus["state"];
	startedAt: number;
	endedAt?: number;
	parentRunId?: string;
	rootRunId?: string;
	label?: string;
	mode?: "single" | "parallel";
	tokens?: number;
}): void {
	const runRecordDir = path.join(root, "runs", entry.runId);
	fs.mkdirSync(runRecordDir, { recursive: true });
	const status: AsyncStatus = {
		runId: entry.runId,
		mode: entry.mode ?? "single",
		state: entry.state,
		startedAt: entry.startedAt,
		lastUpdate: entry.endedAt ?? entry.startedAt + 1,
		...(entry.endedAt !== undefined ? { endedAt: entry.endedAt } : {}),
		cwd: root,
		currentStep: 0,
		...(entry.parentRunId ? { parentRunId: entry.parentRunId } : {}),
		...(entry.label ? { label: entry.label } : {}),
		...(entry.tokens !== undefined ? { totalTokens: { input: 0, output: entry.tokens, total: entry.tokens } } : {}),
		steps: [{
			agent: entry.agentName,
			status: entry.state,
			startedAt: entry.startedAt,
			...(entry.endedAt !== undefined ? { endedAt: entry.endedAt, durationMs: entry.endedAt - entry.startedAt } : {}),
			...(entry.tokens !== undefined ? { tokens: { input: 0, output: entry.tokens, total: entry.tokens } } : {}),
		}],
	};
	fs.writeFileSync(path.join(runRecordDir, "status.json"), JSON.stringify(status), "utf8");
	appendRunEntry({
		runId: entry.runId,
		runRecordDir,
		mode: entry.mode ?? "single",
		source: "async",
		agentName: entry.agentName,
		...(entry.parentRunId ? { parentRunId: entry.parentRunId } : {}),
		...(entry.rootRunId ? { rootRunId: entry.rootRunId } : {}),
		...(entry.label ? { label: entry.label } : {}),
		cwd: root,
		startedAt: entry.startedAt,
	});
}

function appendGroup(root: string, entry: Omit<RunsRegistryEntry, "runRecordDir" | "mode" | "source" | "cwd">): void {
	const runRecordDir = path.join(root, "runs", entry.runId);
	fs.mkdirSync(runRecordDir, { recursive: true });
	appendRunEntry({
		runId: entry.runId,
		runRecordDir,
		mode: "parallel",
		source: "sync",
		...(entry.label ? { label: entry.label } : {}),
		...(entry.rootRunId ? { rootRunId: entry.rootRunId } : {}),
		cwd: root,
		startedAt: entry.startedAt,
	});
}

function statusText(params: Parameters<typeof inspectSubagentStatus>[0]): string {
	const result = inspectSubagentStatus(params);
	assert.equal(result.isError, undefined);
	return result.content.map((item) => "text" in item ? item.text : "").join("\n");
}

afterEach(() => {
	setRegistryPathForTests(null);
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	for (const root of tmpRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("action status list", () => {
	it("includes completed runs by default and excludes them when includeCompleted is false", () => {
		const root = tmpRegistry();
		appendStatusRun(root, { runId: "done-run", agentName: "fixer", state: "complete", startedAt: 1000, endedAt: 2000 });
		appendStatusRun(root, { runId: "live-run", agentName: "qa", state: "running", startedAt: 3000 });

		const defaultText = statusText({ sessionCwd: root });
		assert.match(defaultText, /^Subagent runs: 2/m);
		assert.doesNotMatch(defaultText, /^Active async runs:/m);
		assert.match(defaultText, /done-run/);
		assert.match(defaultText, /live-run/);

		const activeOnlyText = statusText({ sessionCwd: root, includeCompleted: false });
		assert.doesNotMatch(activeOnlyText, /done-run/);
		assert.match(activeOnlyText, /live-run/);
	});

	it("renders parallel group children nested under the group header", () => {
		const root = tmpRegistry();
		const groupId = "parallel-group";
		appendGroup(root, { runId: groupId, label: "parallel fanout", rootRunId: groupId, startedAt: 1000 });
		appendStatusRun(root, { runId: "child-fixer", agentName: "fixer", label: "patch", state: "complete", startedAt: 2000, endedAt: 6000, parentRunId: groupId, rootRunId: groupId, tokens: 11 });
		appendStatusRun(root, { runId: "child-review", agentName: "review", label: "review", state: "complete", startedAt: 3000, endedAt: 7000, parentRunId: groupId, rootRunId: groupId, tokens: 12 });
		appendStatusRun(root, { runId: "child-qa", agentName: "qa", label: "verify", state: "failed", startedAt: 4000, endedAt: 8000, parentRunId: groupId, rootRunId: groupId, tokens: 13 });

		const text = statusText({ sessionCwd: root });
		const lines = text.split("\n");
		const groupIndex = lines.findIndex((line) => line.startsWith("- parallel-group | failed | parallel"));
		assert.notEqual(groupIndex, -1);
		assert.match(lines[groupIndex], /tasks 3\/3 complete/);
		assert.doesNotMatch(lines[groupIndex], /tasks 0\/1 complete/);
		const childLines = lines.slice(groupIndex + 1, groupIndex + 4);
		assert.deepEqual(childLines.map((line) => line.startsWith("  - ")), [true, true, true]);
		assert.match(childLines.join("\n"), /child-fixer \| fixer \| patch \| complete/);
		assert.match(childLines.join("\n"), /child-review \| review \| review \| complete/);
		assert.match(childLines.join("\n"), /child-qa \| qa \| verify \| failed/);
		assert.match(childLines.join("\n"), /fixer \| patch \| complete/);
		assert.match(childLines.join("\n"), /review \| review \| complete/);
		assert.match(childLines.join("\n"), /qa \| verify \| failed/);
		assert.doesNotMatch(text, /^- child-/m);
	});

	it("orders the no-id list by most recent started or ended time first", () => {
		const root = tmpRegistry();
		appendStatusRun(root, { runId: "older-ended-later", agentName: "fixer", state: "complete", startedAt: 1000, endedAt: 9000 });
		appendStatusRun(root, { runId: "newer-started", agentName: "qa", state: "running", startedAt: 8000 });
		appendStatusRun(root, { runId: "oldest", agentName: "review", state: "complete", startedAt: 100, endedAt: 200 });

		const text = statusText({ sessionCwd: root });
		assert.ok(text.indexOf("older-ended-later") < text.indexOf("newer-started"));
		assert.ok(text.indexOf("newer-started") < text.indexOf("oldest"));
	});
});
