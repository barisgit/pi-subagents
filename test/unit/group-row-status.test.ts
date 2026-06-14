import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { formatDuration } from "../../src/surfaces/formatters.ts";
import { runViewFromRegistryEntry } from "../../src/surfaces/subagents-status.ts";
import { appendRunEntry, readAllEntries, setRegistryPathForTests, type RunsRegistryEntry } from "../../src/state/runs-registry.ts";

const tmpRoots: string[] = [];

function tmpRegistry(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "group-row-status-"));
	tmpRoots.push(root);
	setRegistryPathForTests(path.join(root, "registry", "runs-index.jsonl"));
	return root;
}

function appendGroup(root: string, runId: string, startedAt: number): RunsRegistryEntry {
	const runRecordDir = path.join(root, "runs", runId);
	fs.mkdirSync(runRecordDir, { recursive: true });
	const entry: RunsRegistryEntry = {
		runId,
		runRecordDir,
		mode: "parallel",
		source: "sync",
		label: runId,
		rootRunId: runId,
		cwd: root,
		startedAt,
	};
	appendRunEntry(entry);
	return entry;
}

function appendChild(root: string, entry: {
	runId: string;
	parentRunId: string;
	rootRunId: string;
	agentName: string;
	state: "running" | "complete" | "failed";
	startedAt: number;
	endedAt?: number;
}): void {
	const runRecordDir = path.join(root, "runs", entry.runId);
	fs.mkdirSync(runRecordDir, { recursive: true });
	fs.writeFileSync(path.join(runRecordDir, "status.json"), JSON.stringify({
		runId: entry.runId,
		mode: "single",
		state: entry.state,
		startedAt: entry.startedAt,
		lastUpdate: entry.endedAt ?? entry.startedAt + 1,
		...(entry.endedAt !== undefined ? { endedAt: entry.endedAt } : {}),
		cwd: root,
		currentStep: 0,
		parentRunId: entry.parentRunId,
		steps: [{
			agent: entry.agentName,
			status: entry.state,
			startedAt: entry.startedAt,
			...(entry.endedAt !== undefined ? { endedAt: entry.endedAt } : {}),
		}],
	}), "utf8");
	appendRunEntry({
		runId: entry.runId,
		runRecordDir,
		mode: "single",
		source: "async",
		agentName: entry.agentName,
		parentRunId: entry.parentRunId,
		rootRunId: entry.rootRunId,
		cwd: root,
		startedAt: entry.startedAt,
	});
}

afterEach(() => {
	setRegistryPathForTests(null);
	for (const root of tmpRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("group row status", () => {
	it("group row derives status and endedAt from children", () => {
		const root = tmpRegistry();
		const completeGroup = appendGroup(root, "group-complete", 1000);
		appendChild(root, {
			runId: "complete-child-a",
			parentRunId: completeGroup.runId,
			rootRunId: completeGroup.runId,
			agentName: "fixer",
			state: "complete",
			startedAt: 2000,
			endedAt: 7000,
		});
		appendChild(root, {
			runId: "complete-child-b",
			parentRunId: completeGroup.runId,
			rootRunId: completeGroup.runId,
			agentName: "qa",
			state: "complete",
			startedAt: 3000,
			endedAt: 11000,
		});

		const runningGroup = appendGroup(root, "group-running", 20000);
		appendChild(root, {
			runId: "running-child-a",
			parentRunId: runningGroup.runId,
			rootRunId: runningGroup.runId,
			agentName: "review",
			state: "complete",
			startedAt: 21000,
			endedAt: 25000,
		});
		appendChild(root, {
			runId: "running-child-b",
			parentRunId: runningGroup.runId,
			rootRunId: runningGroup.runId,
			agentName: "oracle",
			state: "running",
			startedAt: 22000,
		});

		const entries = readAllEntries();
		const completeSummary = runViewFromRegistryEntry(completeGroup, entries);
		assert.equal(completeSummary.state, "complete");
		assert.equal(completeSummary.endedAt, 11000);
		assert.equal(formatDuration(completeSummary.endedAt - completeSummary.startedAt), "10.0s");

		const runningSummary = runViewFromRegistryEntry(runningGroup, entries);
		assert.equal(runningSummary.state, "running");
		assert.equal(runningSummary.endedAt, undefined);
	});
});
