import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { readRunViewForEntry } from "../../src/state/async-status.ts";
import { appendRunEntry, readAllEntries, setRegistryPathForTests } from "../../src/state/runs-registry.ts";
import { runViewFromRegistryEntry } from "../../src/surfaces/subagents-status.ts";
import { writeWorkflowGroupState } from "../../src/workflow/workflow-group-state.ts";

// VAL-GROUP-SUMMARY: readRunViewForEntry (async-status) and runViewFromRegistryEntry
// (subagents-status) share one group-synthesis seam (buildGroupSummary). This test pins
// the exact contract: where the two builders MUST agree (the shared group body) and the
// four intentional knobs where they differ (orphan-drop nullability, isGroup predicate,
// leaf parentRunId injection, group object extras currentStep/lastUpdate). A change inside
// the shared seam must shift BOTH builders' fixtures identically.

const roots: string[] = [];
let previousHome: string | undefined;

function setup(prefix: string): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	roots.push(root);
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
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("group summary parity (VAL-GROUP-SUMMARY)", () => {
	it("synthesizes a parallel group identically except for B's currentStep/lastUpdate extras", () => {
		const root = setup("gsp-group-");
		const groupDir = path.join(root, "group-run");
		const childDir = path.join(root, "child-run");
		fs.mkdirSync(childDir, { recursive: true });
		const group = {
			runId: "grp",
			runRecordDir: groupDir,
			mode: "parallel" as const,
			source: "async" as const,
			cwd: root,
			startedAt: 1000,
		};
		const child = {
			runId: "grp-child",
			runRecordDir: childDir,
			mode: "single" as const,
			source: "async" as const,
			agentName: "A",
			parentRunId: group.runId,
			cwd: root,
			startedAt: 1000,
		};
		appendRunEntry(group);
		appendRunEntry(child);
		fs.writeFileSync(
			path.join(childDir, "status.json"),
			JSON.stringify({
				runId: child.runId,
				mode: "single",
				state: "complete",
				startedAt: 1000,
				endedAt: 2500,
				cwd: root,
				currentStep: 0,
				steps: [],
			}),
		);
		const entries = readAllEntries();

		const a = readRunViewForEntry(group, entries);
		const b = runViewFromRegistryEntry(group, entries);
		assert.ok(a, "async-status must synthesize the group (not drop it)");

		// Shared body: id/mode/state/startedAt/endedAt/cwd/steps must be identical.
		assert.equal(a.state, "complete");
		assert.equal(b.state, "complete");
		assert.equal(a.endedAt, 2500);
		assert.equal(b.endedAt, 2500);
		assert.equal(a.mode, "parallel");
		assert.equal(b.mode, "parallel");
		assert.deepEqual(a.steps, []);
		assert.deepEqual(b.steps, []);

		// Knob 4 (group extras): only B carries currentStep:0 + lastUpdate.
		assert.equal(a.currentStep, undefined);
		assert.equal(b.currentStep, 0);
		assert.equal(a.lastUpdate, undefined);
		assert.equal(b.lastUpdate, 2500);

		// Modulo those documented extras, the two group objects are equal.
		const { currentStep: _bStep, lastUpdate: _bUpdate, ...bShared } = b;
		assert.deepEqual(bShared, { ...a });
	});

	it("applies the workflow running-override gated on a computed complete in both builders", () => {
		const root = setup("gsp-wf-");
		const groupDir = path.join(root, "wf-run");
		const group = {
			runId: "wf",
			runRecordDir: groupDir,
			mode: "parallel" as const,
			source: "async" as const,
			kind: "workflow" as const,
			cwd: root,
			startedAt: 1000,
		};
		appendRunEntry(group);
		const entries = readAllEntries();

		writeWorkflowGroupState(groupDir, "running");
		assert.equal(readRunViewForEntry(group, entries)?.state, "running");
		assert.equal(runViewFromRegistryEntry(group, entries).state, "running");

		writeWorkflowGroupState(groupDir, "complete");
		assert.equal(readRunViewForEntry(group, entries)?.state, "complete");
		assert.equal(runViewFromRegistryEntry(group, entries).state, "complete");
	});

	it("differs on orphan-drop: A returns null past the stub window, B returns a queued stub", () => {
		const root = setup("gsp-orphan-");
		const stale = {
			runId: "orphan",
			runRecordDir: path.join(root, "orphan-run"),
			mode: "single" as const,
			source: "async" as const,
			agentName: "A",
			cwd: root,
			startedAt: Date.now() - 120_000, // older than QUEUED_STUB_MAX_AGE_MS (60s)
		};
		appendRunEntry(stale);
		const entries = readAllEntries();

		assert.equal(readRunViewForEntry(stale, entries), null, "A drops a stale statusless orphan");
		const b = runViewFromRegistryEntry(stale, entries);
		assert.equal(b.state, "queued", "B never drops: returns a queued stub");
		assert.equal(b.steps.length, 1);
		assert.equal(b.steps[0]!.agent, "A");
	});

	it("keeps a fresh statusless single run as a queued stub in both builders", () => {
		const root = setup("gsp-fresh-");
		const fresh = {
			runId: "fresh",
			runRecordDir: path.join(root, "fresh-run"),
			mode: "single" as const,
			source: "async" as const,
			agentName: "A",
			cwd: root,
			startedAt: Date.now(),
		};
		appendRunEntry(fresh);
		const entries = readAllEntries();

		const a = readRunViewForEntry(fresh, entries);
		const b = runViewFromRegistryEntry(fresh, entries);
		assert.equal(a?.state, "queued");
		assert.equal(b.state, "queued");
		assert.deepEqual(a!.steps, b.steps);
	});

	it("differs on leaf parentRunId injection: only B injects entry.parentRunId onto a leaf lacking it", () => {
		const root = setup("gsp-leaf-");
		const leafDir = path.join(root, "leaf-run");
		fs.mkdirSync(leafDir, { recursive: true });
		const leaf = {
			runId: "leaf",
			runRecordDir: leafDir,
			mode: "single" as const,
			source: "async" as const,
			agentName: "A",
			parentRunId: "some-parent",
			cwd: root,
			startedAt: 1000,
		};
		appendRunEntry(leaf);
		// status.json has NO parentRunId of its own, so only the registry entry carries it.
		fs.writeFileSync(
			path.join(leafDir, "status.json"),
			JSON.stringify({
				runId: leaf.runId,
				mode: "single",
				state: "complete",
				startedAt: 1000,
				endedAt: 2000,
				cwd: root,
				currentStep: 0,
				steps: [],
			}),
		);
		const entries = readAllEntries();

		const a = readRunViewForEntry(leaf, entries);
		const b = runViewFromRegistryEntry(leaf, entries);
		assert.equal(a?.parentRunId, undefined, "A does not inject the registry parentRunId onto a leaf summary");
		assert.equal(
			b.parentRunId,
			"some-parent",
			"B injects the registry parentRunId when the leaf summary lacks one",
		);
	});
});
