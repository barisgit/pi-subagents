import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	readWorkflowGroupPhase,
	readWorkflowGroupState,
	readWorkflowMeta,
	readWorkflowScript,
	writeWorkflowGroupPhase,
	writeWorkflowGroupState,
	writeWorkflowMeta,
	writeWorkflowScript,
} from "../../src/workflow/workflow-group-state.ts";
import { formatWorkflowPhase, shapeWorkflowPhasePlan } from "../../src/state/workflow-display.ts";
import { parseWorkflowMeta } from "../../src/protocol/workflow-meta.ts";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it("keeps old current-phase records readable and carries them into new history", () => {
	const root = groupRecord({ state: "running", updatedAt: 1, phaseIndex: 1, phaseTitle: "Scope" });
	assert.deepEqual(readWorkflowGroupPhase(root), {
		phaseIndex: 1,
		phaseTitle: "Scope",
		reachedPhaseTitles: [],
	});
	writeWorkflowGroupPhase(root, 2, "Review");
	assert.deepEqual(readWorkflowGroupPhase(root)?.reachedPhaseTitles, ["Scope", "Review"]);
});

it("bounds durable reached phase history", () => {
	const root = groupRecord({ state: "running", updatedAt: 1 });
	for (let index = 1; index <= 70; index += 1) writeWorkflowGroupPhase(root, index, `Step ${index}`);
	const history = readWorkflowGroupPhase(root)?.reachedPhaseTitles;
	assert.equal(history?.length, 64);
	assert.equal(history?.at(-1), "Step 70");
});

it("fails closed on malformed reached phase history without hiding lifecycle", () => {
	for (const reachedPhaseTitles of [
		["Scope", 42],
		["Scope", "bad\nphase"],
	]) {
		const root = groupRecord({
			state: "running",
			updatedAt: 1,
			phaseIndex: 2,
			phaseTitle: "Review",
			reachedPhaseTitles,
		});
		assert.equal(readWorkflowGroupState(root), "running");
		assert.equal(readWorkflowGroupPhase(root), undefined);
	}
});

describe("workflow metadata display shaping", () => {
	const meta = {
		name: "Parity audit",
		description: "Compare behavior",
		phases: [{ title: "Scope" }, { title: "Verify" }, { title: "Report" }],
	};

	it("uses declared progress while preserving ad-hoc phase labels", () => {
		assert.equal(formatWorkflowPhase(meta, 7, "Verify"), "Phase 2/3: Verify");
		assert.equal(formatWorkflowPhase(meta, 7, "Ad hoc"), "Phase 7: Ad hoc");
	});

	it("distinguishes skipped phases from completed and upcoming phases", () => {
		assert.deepEqual(
			shapeWorkflowPhasePlan(meta, ["Verify"], true).map((phase) => phase.state),
			["unreached", "current", "upcoming"],
		);
	});

	it("uses the durable current phase when it has no child", () => {
		assert.deepEqual(
			shapeWorkflowPhasePlan(meta, ["Scope"], true, "Verify").map((phase) => phase.state),
			["completed", "current", "upcoming"],
		);
	});

	it("does not mark a declared phase current when the durable current phase is ad-hoc", () => {
		assert.deepEqual(
			shapeWorkflowPhasePlan(meta, ["Scope"], true, "Ad hoc").map((phase) => phase.state),
			["completed", "upcoming", "upcoming"],
		);
	});

	it("canonicalizes prefixed titles for progress and plan comparisons", () => {
		const prefixed = {
			...meta,
			phases: [{ title: "Phase 1: Scope" }, { title: "Phase 2: Verify" }, { title: "Report" }],
		};
		assert.equal(formatWorkflowPhase(prefixed, 2, "Phase 2: Verify"), "Phase 2/3: Verify");
		assert.deepEqual(
			shapeWorkflowPhasePlan(prefixed, ["Phase 1: Scope"], true, "Phase 2: Verify").map((phase) => phase.state),
			["completed", "current", "upcoming"],
		);
	});

	it("marks only durably reached declared titles complete", () => {
		assert.deepEqual(
			shapeWorkflowPhasePlan(meta, ["Scope", "Verify", "Report"], true, "Report").map((phase) => phase.state),
			["completed", "completed", "current"],
		);
		assert.deepEqual(
			shapeWorkflowPhasePlan(meta, ["Scope", "Report"], true, "Report").map((phase) => phase.state),
			["completed", "unreached", "current"],
		);
	});

	it("fails closed on display-unsafe persisted metadata", () => {
		const root = record({
			script: "return 'safe';",
			meta: { name: "Broken\nframe", description: "Compare", phases: [] },
		});
		assert.equal(readWorkflowScript(root), "return 'safe';");
		assert.equal(readWorkflowMeta(root), undefined);
	});

	it("does not create workflow-script.json when metadata is written without a script", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-meta-missing-script-"));
		roots.push(root);
		writeWorkflowMeta(root, { name: "Audit", description: "Compare", phases: [] });
		assert.equal(fs.existsSync(path.join(root, "workflow-script.json")), false);
		assert.equal(readWorkflowMeta(root), undefined);
	});
});

describe("workflow metadata validation", () => {
	it("trims safe Unicode metadata and canonicalizes declared titles", () => {
		const parsed = parseWorkflowMeta({
			name: "  安全 audit  ",
			description: "  Compare Δ behavior  ",
			phases: [{ title: "  Phase 1: Récon  ", detail: "  Déjà vu  " }],
		});
		if (!parsed.ok) assert.fail(parsed.reason);
		assert.deepEqual(parsed.value, {
			name: "安全 audit",
			description: "Compare Δ behavior",
			phases: [{ title: "Récon", detail: "Déjà vu" }],
		});
	});

	it("rejects canonical duplicate declared titles", () => {
		const parsed = parseWorkflowMeta({
			name: "Audit",
			description: "Compare",
			phases: [{ title: "Phase 1: Recon" }, { title: "Recon" }],
		});
		assert.equal(parsed.ok, false);
		if (!parsed.ok) assert.match(parsed.reason, /must be unique/);
	});

	it("rejects more than 64 declared phases", () => {
		const parsed = parseWorkflowMeta({
			name: "Audit",
			description: "Compare",
			phases: Array.from({ length: 65 }, (_, index) => ({ title: `Step ${index + 1}` })),
		});
		assert.equal(parsed.ok, false);
		if (!parsed.ok) assert.match(parsed.reason, /at most 64/);
	});

	it("rejects control characters with field-specific errors", () => {
		const controls = ["line\nbreak", "tab\tbreak", "ansi\u001b[31mred", "c1\u0085break"];
		for (const field of ["name", "description", "title", "detail"] as const) {
			for (const unsafe of controls) {
				const value = {
					name: field === "name" ? unsafe : "Audit",
					description: field === "description" ? unsafe : "Compare",
					phases: [
						{
							title: field === "title" ? unsafe : "Scope",
							detail: field === "detail" ? unsafe : "Inspect",
						},
					],
				};
				const parsed = parseWorkflowMeta(value);
				assert.equal(parsed.ok, false);
				if (!parsed.ok) assert.match(parsed.reason, new RegExp(`meta.*${field}.*control`));
			}
		}
	});
});

function record(contents: unknown): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-meta-"));
	roots.push(root);
	fs.writeFileSync(path.join(root, "workflow-script.json"), JSON.stringify(contents), "utf8");
	return root;
}

function groupRecord(contents: unknown): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-group-phase-"));
	roots.push(root);
	fs.writeFileSync(path.join(root, "workflow-group.json"), JSON.stringify(contents), "utf8");
	return root;
}

describe("workflow group phase disk codec", () => {
	it("retains all declared history while persisting many ad-hoc current phases separately", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-declared-history-"));
		roots.push(root);
		const declaredTitles = Array.from({ length: 64 }, (_, index) => `Declared ${index + 1}`);
		writeWorkflowScript(root, "return 'done';");
		writeWorkflowMeta(root, {
			name: "Audit",
			description: "Compare",
			phases: declaredTitles.map((title) => ({ title })),
		});
		for (const [index, title] of declaredTitles.entries()) writeWorkflowGroupPhase(root, index + 1, title);
		for (let index = 1; index <= 70; index += 1) {
			writeWorkflowGroupPhase(root, 64 + index, `Ad hoc ${index}`);
		}

		const phase = readWorkflowGroupPhase(root);
		assert.equal(phase?.phaseTitle, "Ad hoc 70");
		assert.deepEqual(phase?.reachedPhaseTitles, declaredTitles);
	});

	it("reads old lifecycle records and preserves phase and lifecycle across updates", () => {
		const root = groupRecord({ state: "running", updatedAt: 1 });
		assert.equal(readWorkflowGroupState(root), "running");
		assert.equal(readWorkflowGroupPhase(root), undefined);

		writeWorkflowGroupPhase(root, 2, "Review");
		assert.deepEqual(readWorkflowGroupPhase(root), {
			phaseIndex: 2,
			phaseTitle: "Review",
			reachedPhaseTitles: ["Review"],
		});
		assert.equal(readWorkflowGroupState(root), "running");
		writeWorkflowGroupPhase(root, 3, "Report");
		writeWorkflowGroupPhase(root, 4, "Phase 4: Review");

		writeWorkflowGroupState(root, "complete");
		assert.equal(readWorkflowGroupState(root), "complete");
		assert.deepEqual(readWorkflowGroupPhase(root), {
			phaseIndex: 4,
			phaseTitle: "Review",
			reachedPhaseTitles: ["Review", "Report"],
		});
	});

	it("fails closed on malformed persisted phase fields without hiding lifecycle", () => {
		const root = groupRecord({ state: "running", updatedAt: 1, phaseIndex: 0, phaseTitle: "" });
		assert.equal(readWorkflowGroupState(root), "running");
		assert.equal(readWorkflowGroupPhase(root), undefined);
	});
});

describe("workflow metadata disk codec", () => {
	it("keeps old script-only records backward-readable", () => {
		const root = record({ script: "return 'legacy';" });
		assert.equal(readWorkflowScript(root), "return 'legacy';");
		assert.equal(readWorkflowMeta(root), undefined);
	});

	it("fails closed on malformed persisted metadata without hiding a valid script", () => {
		const root = record({ script: "return 'safe';", meta: { name: "Broken", phases: [] } });
		assert.equal(readWorkflowScript(root), "return 'safe';");
		assert.equal(readWorkflowMeta(root), undefined);
	});
});
