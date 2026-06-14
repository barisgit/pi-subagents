import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	buildLeftLine,
	overlayRunsSignature,
	runElapsed,
	runEndedStamp,
	runIdentityAge,
	runKey,
	type ForegroundRunSummary,
	type LiveRun,
} from "../../src/surfaces/subagents-status.ts";
import { isGroupContainerRow, sortLiveRuns } from "../../src/surfaces/dashboard-row-model.ts";
import { buildWorkflowRightLines } from "../../src/surfaces/dashboard-detail-renderer.ts";
import { readRunViewForEntry } from "../../src/state/async-status.ts";
import { appendRunEntry, setRegistryPathForTests, type RunsRegistryEntry } from "../../src/state/runs-registry.ts";
import type { AsyncRunSummary } from "../../src/state/async-status.ts";

const theme = { fg: (_t: string, text: string) => text, bg: (_t: string, text: string) => text } as never;
const tmpRoots: string[] = [];

// An OWNED async run as produced by the registry memory mirror: async-shaped
// (real steps, no foreground currentAgent) but stamped ownership:'live' because
// this process still owns it. This is the exact combination the latent-site
// conversions must handle.
function ownedAsync(over: Partial<AsyncRunSummary> = {}): LiveRun {
	return {
		ownership: "live",
		run: {
			id: "owned-1",
			asyncDir: "/tmp/owned-1",
			mode: "single",
			state: "running",
			startedAt: 1_000,
			lastUpdate: 1_500,
			steps: [{ index: 0, agent: "fixer", status: "running", startedAt: 1_000 }],
			...over,
		} as unknown as AsyncRunSummary,
	};
}

function foreignAsync(over: Partial<AsyncRunSummary> = {}): LiveRun {
	const owned = ownedAsync(over);
	return { ownership: "foreign", run: owned.run };
}

describe("RunView producers: owned-async memory vs foreign disk", () => {
	afterEach(() => {
		setRegistryPathForTests(null);
		for (const root of tmpRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
	});

	// (producer) owned ids resolve live, others foreign; empty (post-reload) => all foreign.
	it("sortLiveRuns stamps owned async ids live and the rest foreign", () => {
		const async: AsyncRunSummary[] = [
			ownedAsync({ id: "mine" }).run,
			ownedAsync({ id: "theirs" }).run,
		];
		const sync: ForegroundRunSummary[] = [];

		const owned = sortLiveRuns(sync, async, new Set(["mine"]));
		assert.equal(owned.find((r) => r.run.id === "mine")?.ownership, "live");
		assert.equal(owned.find((r) => r.run.id === "theirs")?.ownership, "foreign");

		// Post-reload: registry empty => no owned ids => every run hydrates foreign.
		const reloaded = sortLiveRuns(sync, async, new Set());
		assert.ok(reloaded.every((r) => r.ownership === "foreign"), "empty owned set => all foreign (today's behavior)");
	});

	// (producer) readRunViewForEntry prefers the in-memory owned view; non-owned
	// reads from disk; after reload (no ownedViews) all read from disk.
	it("readRunViewForEntry resolves owned leaves from memory and the rest from disk", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "runview-producers-"));
		tmpRoots.push(root);
		setRegistryPathForTests(path.join(root, "registry", "runs-index.jsonl"));

		const mkLeaf = (runId: string, label: string): RunsRegistryEntry => {
			const runRecordDir = path.join(root, "runs", runId);
			fs.mkdirSync(runRecordDir, { recursive: true });
			fs.writeFileSync(path.join(runRecordDir, "status.json"), JSON.stringify({
				runId,
				mode: "single",
				state: "complete",
				startedAt: 1_000,
				lastUpdate: 1_001,
				endedAt: 1_001,
				cwd: root,
				currentStep: 0,
				label: `disk:${label}`,
				steps: [{ agent: "fixer", status: "complete", startedAt: 1_000, endedAt: 1_001 }],
			}), "utf8");
			const entry = { runId, runRecordDir, mode: "single", source: "async", agentName: "fixer", label, rootRunId: runId, cwd: root, startedAt: 1_000 } as RunsRegistryEntry;
			appendRunEntry(entry);
			return entry;
		};

		const ownedEntry = mkLeaf("owned", "owned");
		const foreignEntry = mkLeaf("foreign", "foreign");
		const entries = [ownedEntry, foreignEntry];

		// Memory mirror only holds the owned run, with a distinct label so we can
		// tell memory from disk.
		const ownedViews = new Map<string, AsyncRunSummary>([
			["owned", { ...readRunViewForEntry(ownedEntry, entries)!, label: "memory:owned" }],
		]);

		const ownedResolved = readRunViewForEntry(ownedEntry, entries, ownedViews);
		const foreignResolved = readRunViewForEntry(foreignEntry, entries, ownedViews);
		assert.equal(ownedResolved?.label, "memory:owned", "owned leaf resolves from registry memory");
		assert.equal(foreignResolved?.label, "disk:foreign", "non-owned leaf hydrates from status.json");

		// Reload: registry empty => no ownedViews => every run hydrates from disk.
		const afterReload = readRunViewForEntry(ownedEntry, entries);
		assert.equal(afterReload?.label, "disk:owned", "after reload the owned run hydrates from disk = today's behavior");
	});
});

describe("latent-site conversions: owned-async behaves like disk by data, not provenance", () => {
	// (1) completed owned-async run freezes elapsed + identity age.
	it("freezes elapsed and identity age for a COMPLETED owned-async run", () => {
		// resumeCount>0 is required for runIdentityAge to emit a value at all, so the
		// freeze branch it claims to test is actually exercised (not a vacuous
		// undefined===undefined).
		const done = ownedAsync({ id: "done", state: "complete", endedAt: 2_000, lastUpdate: 2_000, resumeCount: 1, resumedAt: 1_200 });
		// Drive with two clocks far past endedAt: frozen output must not change.
		assert.equal(runElapsed(done, 5_000), runElapsed(done, 9_999), "elapsed frozen at endedAt");
		assert.equal(runElapsed(done, 5_000), "800ms", "elapsed measured from resumedAt to endedAt, not now");
		const age1 = runIdentityAge(done, 5_000);
		const age2 = runIdentityAge(done, 9_999);
		assert.equal(age1, age2, "identity age frozen at endedAt");
		assert.equal(age1, "1.0s", "identity age measured from startedAt to endedAt (frozen), not ticking to now");
		assert.equal(runEndedStamp(done) !== "", true, "completed owned-async shows an end stamp");

		// A still-running owned-async run keeps ticking (control: not frozen).
		const live = ownedAsync({ id: "live", state: "running" });
		assert.notEqual(runElapsed(live, 5_000), runElapsed(live, 9_999), "running run keeps ticking");
		assert.equal(runEndedStamp(live), "", "running run has no end stamp");
	});

	// (5) foreign disk run unchanged: still freezes.
	it("keeps a foreign (disk) completed run frozen, unchanged", () => {
		const foreign = foreignAsync({ id: "f", state: "complete", endedAt: 2_000, lastUpdate: 2_000 });
		assert.equal(runElapsed(foreign, 5_000), runElapsed(foreign, 9_999), "foreign elapsed frozen");
		assert.notEqual(runEndedStamp(foreign), "", "foreign completed shows end stamp");
	});

	// (2) signature changes when an owned-async run's step/phase/displayState advances.
	it("repaints (signature changes) when an owned-async run advances", () => {
		const before = ownedAsync({ id: "adv", phase: "thinking", currentStep: 0 });
		const sigBefore = overlayRunsSignature([before], undefined, undefined);

		const phaseAdvanced = ownedAsync({ id: "adv", phase: "streaming_text", currentStep: 0 });
		assert.notEqual(overlayRunsSignature([phaseAdvanced], undefined, undefined), sigBefore, "phase change repaints");

		const stepAdvanced = ownedAsync({
			id: "adv",
			phase: "thinking",
			currentStep: 1,
			steps: [
				{ index: 0, agent: "fixer", status: "complete", startedAt: 1_000 },
				{ index: 1, agent: "review", status: "running", startedAt: 1_200 },
			] as never,
		});
		assert.notEqual(overlayRunsSignature([stepAdvanced], undefined, undefined), sigBefore, "step advance repaints");

		const displayAdvanced = ownedAsync({ id: "adv", phase: "thinking", currentStep: 0, displayState: "lost" });
		assert.notEqual(overlayRunsSignature([displayAdvanced], undefined, undefined), sigBefore, "displayState change repaints");
	});

	// (3) owned-async parallel PARENT with child rows is a container by structure.
	it("treats an owned-async parallel parent with child rows as a container", () => {
		const parent = ownedAsync({ id: "group", mode: "parallel", state: "running", steps: [] as never });
		const child = ownedAsync({ id: "child", parentRunId: "group", mode: "single" } as Partial<AsyncRunSummary>);
		const runs = [parent, child];
		assert.equal(isGroupContainerRow(runs, parent), true, "owned-async parallel parent nests as a container");
		// Control: same parent with no children is NOT a container.
		assert.equal(isGroupContainerRow([parent], parent), false, "no child rows => not a container");
		// Control: foreign parent still nests (unchanged).
		const fParent = foreignAsync({ id: "group", mode: "parallel", state: "running", steps: [] as never });
		const fChild = foreignAsync({ id: "child", parentRunId: "group", mode: "single" } as Partial<AsyncRunSummary>);
		assert.equal(isGroupContainerRow([fParent, fChild], fParent), true, "foreign parent still nests, unchanged");
	});

	// (4) owned-async CHILDREN appear in the right-pane children filter.
	it("includes owned-async children in the detail-pane children filter", () => {
		const parent = ownedAsync({ id: "wf", mode: "parallel", state: "running", workflow: true, steps: [] as never } as Partial<AsyncRunSummary>);
		const child = ownedAsync({ id: "kid", parentRunId: "wf", mode: "single", state: "complete", endedAt: 1_900, label: "kid-label" } as Partial<AsyncRunSummary>);
		const lines = buildWorkflowRightLines(theme, parent.run, 120, [parent, child]).join("\n");
		assert.match(lines, /kid-label|kid/, "owned-async child appears in the right-pane steps list");
	});

	// (selection stability) runKey must NOT embed the now-mutable ownership: an
	// owned-async run that completes flips live->foreign once the registry retention
	// sweep drops it. If the key changed across that flip, reconcileSelection would
	// reset the user's selection to the top row. The key is the bare run id, so it
	// is stable across the transition.
	it("keeps runKey stable when an owned-async run transitions live -> foreign", () => {
		const live = ownedAsync({ id: "sel", state: "complete", endedAt: 2_000 });
		const foreign = foreignAsync({ id: "sel", state: "complete", endedAt: 2_000 });
		assert.equal(runKey(live), runKey(foreign), "selection key survives the live->foreign retention-sweep flip");
		assert.equal(runKey(live), "sel", "runKey is the bare run id, not ownership-prefixed");
	});

	// The left line renders an owned-async run from its steps (no currentAgent),
	// proving runAgentLabel selects on field presence, not provenance.
	it("renders an owned-async row from its steps, not as a foreground agent", () => {
		const run = ownedAsync({ id: "row", state: "running" });
		const line = buildLeftLine(theme, run, false, 5_000, 160);
		assert.match(line, /fixer/, "owned-async row labels from its step agent");
	});
});
