import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { LiveRun, RunView } from "../../src/state/run-view.ts";
import { buildModelEvidenceLine, buildRightLines } from "../../src/surfaces/dashboard-detail-renderer.ts";
import type { DetailTarget } from "../../src/surfaces/dashboard-row-model.ts";
import { detailTargetTitle } from "../../src/surfaces/subagents-status.ts";
import { fe2026LiveRuns } from "../fixtures/dashboard/phase-first-fe-2026.ts";

initTheme();

const theme = { fg: (_name: string, text: string) => text, bg: (_name: string, text: string) => text } as never;

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function plain(lines: string[]): string {
	return stripAnsi(lines.join("\n"))
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n");
}

function render(target: DetailTarget, width = 100, runs: LiveRun[] = fe2026LiveRuns): string {
	return plain(buildRightLines(theme, target, width, runs));
}

function liveRun(run: RunView): LiveRun {
	return { ownership: "foreign", run };
}

function assistant(provider: string, model: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: "anthropic-messages",
		provider,
		model,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	} as never;
}

const workflow = fe2026LiveRuns[0]!;
const phase3 = fe2026LiveRuns.filter((run) => run.run.phaseIndex === 3);

describe("dashboard detail child cards", () => {
	it("counts paused and lost children as done and renders terminal cards", () => {
		const paused = liveRun({
			id: "paused-child",
			parentRunId: workflow.run.id,
			mode: "single",
			state: "paused",
			startedAt: 1,
			endedAt: 2,
			label: "paused",
			steps: [{ index: 0, agent: "operator", status: "paused" }],
		});
		const lost = liveRun({
			id: "lost-child",
			parentRunId: workflow.run.id,
			mode: "single",
			state: "lost",
			startedAt: 1,
			endedAt: 2,
			label: "lost",
			steps: [{ index: 0, agent: "operator", status: "lost" }],
		});
		const text = render(
			{ kind: "phase", workflow, phaseIndex: 3, title: "Validacija", children: [paused, lost] },
			100,
			[workflow, paused, lost],
		);
		assert.match(text, /^2 runs · 2 done · 1 paused · 1 lost · 0t tokens · 2ms$/m);
		assert.match(text, /^⏸ operator · paused · 1ms\n {2}\(no output\)$/m);
		assert.match(text, /^! operator · lost · 1ms\n {2}\(no output\)$/m);
	});

	it("phase border owns identity; body opens with state, aggregate progress, then child cards", () => {
		const target = { kind: "phase", workflow, phaseIndex: 3, title: "Validacija", children: phase3 } as const;
		assert.equal(detailTargetTitle(target), "Phase 3: Validacija");
		const text = render(target);
		const lines = text.split("\n");
		assert.equal(lines[0], "✗ failed");
		assert.doesNotMatch(text, /Phase 3: Validacija/, "phase identity belongs to the border");
		assert.equal(lines[1], "3 runs · 2 done · 1 failed · 1 running · 300t tokens · 2.0s");
		assert.doesNotMatch(text, /Frontend Feature FE-2026/, "the pane border owns the workflow title");
		assert.match(text, /^── Preverjanje · Testi 1\/2 · 2\/2 items$/m);
		assert.match(text, /^── Preverjanje · Pregled 2\/2 · 1\/2 items$/m);
		// finished child: identity once, role, metrics, bounded output preview
		assert.match(text, /^✓ operator · Prijava · 100t · 1\.0s\n {2}Testi prijave so uspešni\.$/m);
		// running child: current activity from the live progress helpers
		assert.match(text, /^◈ operator · Profil · 1 tool · 100t · 0ms\n {2}bash \| 0ms$/m);
		// failed child: error then its returned text
		assert.match(text, /^✗ reviewer · Prijava · 100t · 1\.0s\n {2}✗ Najdena regresija\n {2}Pregled ni uspel\.$/m);
		assert.equal(text.split("Prijava").length - 1, 2, "each item is named once per card");
		assert.doesNotMatch(text, /P3 Validacija/, "cards do not repeat the phase the pane already names");
	});

	it("running card shows recent tools before the current line", () => {
		const running = fe2026LiveRuns.find((run) => run.run.id === "draft-build-b")!;
		const text = render({ kind: "phase", workflow, phaseIndex: 2, title: "Implementacija", children: [running] });
		assert.match(text, /^◈ fixer · Profil · 1 tool · 100t · 0ms\n {2}← read: src\/profile\.ts\n {2}waiting 0ms$/m);
	});

	it("pipeline stage border owns identity; body gives progress, the grid, then item cards", () => {
		const stage = phase3.filter((run) => run.run.pipeline?.stageIndex === 0);
		const target = {
			kind: "pipelineGroup",
			workflow,
			pipelineId: "verification",
			stageIndex: 0,
			phaseIndex: 3,
			runs: stage,
		} as const;
		assert.equal(detailTargetTitle(target), "⋮ Preverjanje · Testi");
		const text = render(target);
		const lines = text.split("\n");
		assert.equal(lines[0], "◈ running · stage 1/2 · 1/2 items");
		assert.equal(lines[1], "2 runs · 1 done · 1 running · 200t tokens · 1.0s");
		assert.doesNotMatch(text, /Preverjanje/, "pipeline identity belongs to the border");
		assert.doesNotMatch(text, /items ×/, "no second summary heading");
		assert.match(text, /^item · Testi · Pregled · progress · duration$/m, "cross-stage grid stays");
		assert.match(text, /^── Items$/m);
		assert.doesNotMatch(text, /^── Testi$/m, "do not repeat the selected stage as a card heading");
		assert.match(text, /^✓ operator · Prijava · 100t · 1\.0s\n {2}Testi prijave so uspešni\.$/m);
		assert.match(text, /^◈ operator · Profil · 1 tool · 100t · 0ms\n {2}bash \| 0ms$/m);
	});

	it("single-stage pipeline skips the grid", () => {
		const single = liveRun({
			id: "solo",
			parentRunId: "fe-2026",
			mode: "single",
			state: "complete",
			startedAt: 1,
			endedAt: 2,
			phaseIndex: 1,
			pipeline: {
				id: "solo-pipe",
				name: "Solo",
				itemIndex: 0,
				itemLabel: "A",
				stageIndex: 0,
				stageCount: 1,
				itemCount: 1,
			},
			finalOutput: "done",
			steps: [{ index: 0, agent: "fixer", status: "complete" }],
		});
		const text = render(
			{ kind: "pipelineGroup", workflow, pipelineId: "solo-pipe", stageIndex: 0, phaseIndex: 1, runs: [single] },
			100,
			[workflow, single],
		);
		assert.doesNotMatch(text, /progress · duration/);
		assert.match(text, /^✓ fixer · A · 1ms\n {2}done$/m);
	});

	it("cards bound long output, mark missing output, and unwrap <output> blocks", () => {
		const base = (id: string, extra: Partial<RunView>): LiveRun =>
			liveRun({
				id,
				parentRunId: "fe-2026",
				mode: "single",
				state: "complete",
				startedAt: 1,
				endedAt: 2,
				phaseIndex: 1,
				steps: [{ index: 0, agent: "explorer", status: "complete" }],
				...extra,
			});
		const long = base("long", {
			label: "long-one",
			finalOutput: Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n"),
		});
		// An older disk record with no captured outputText.
		const silent = base("silent", { label: "quiet" });
		const tagged = base("tagged", {
			label: "tagged",
			finalOutput: 'preamble prose\n<output>{"ok":true}</output>',
		});
		const queued = base("queued", { label: "later", state: "queued", endedAt: undefined });
		const text = render(
			{ kind: "phase", workflow, phaseIndex: 1, title: "Raziskava", children: [long, silent, tagged, queued] },
			100,
			[workflow, long, silent, tagged, queued],
		);
		assert.match(text, /^── Runs$/m, "no pipelines means the runs heading is not 'Loose'");
		assert.match(
			text,
			/^✓ explorer · long-one · 1ms\n {2}line 1\n {2}line 2\n {2}line 3\n {2}line 4\n {2}… \+8 lines$/m,
		);
		assert.doesNotMatch(text, /line 12/);
		assert.match(text, /^✓ explorer · quiet · 1ms\n {2}\(no output\)$/m);
		assert.match(text, /^✓ explorer · tagged · 1ms\n {2}\{\n {4}"ok": true\n {2}\}$/m);
		assert.doesNotMatch(text, /preamble prose/, "the returned value, not the narration, is previewed");
		assert.match(text, /^○ explorer · later\n {2}queued$/m);
	});

	it("run body header names only what the pane border cannot", () => {
		// The header derives the live duration from Date.now(); pin the clock so
		// the running run reads a stable 0ms regardless of test-runner load.
		const now = 1_700_000_000_000;
		mock.timers.enable({ apis: ["Date"], now });
		const labelled = liveRun({
			id: "lab",
			mode: "single",
			state: "running",
			startedAt: now,
			label: "stage-transcript-default",
			currentAgent: "fixer",
			steps: [{ index: 0, agent: "fixer", status: "running" }],
		});
		const withLabel = stripAnsi(buildRightLines(theme, { kind: "run", run: labelled }, 100).join("\n"));
		assert.match(withLabel, /^◈ running · fixer · 0t tokens · 0ms$/m, "label is the border title; agent stays");
		assert.doesNotMatch(withLabel, /stage-transcript-default/);
		const unlabelled = liveRun({ ...labelled.run, id: "nolab", label: undefined });
		const withoutLabel = stripAnsi(buildRightLines(theme, { kind: "run", run: unlabelled }, 100).join("\n"));
		assert.match(withoutLabel, /^◈ running · 0t tokens · 0ms$/m, "agent is the border title, so the body omits it");
		mock.timers.reset();
	});
});

describe("dashboard model evidence line", () => {
	const run = liveRun({
		id: "m",
		mode: "single",
		state: "complete",
		startedAt: 1,
		endedAt: 2,
		steps: [{ index: 0, agent: "fixer", status: "complete" }],
	});

	it("shows nothing without evidence", () => {
		assert.equal(buildModelEvidenceLine(run, [], []), undefined);
		assert.equal(buildModelEvidenceLine(run, [{ messages: [] }], undefined), undefined);
		const text = stripAnsi(buildRightLines(theme, { kind: "run", run }, 100).join("\n"));
		assert.doesNotMatch(text, /model/i);
	});

	it("labels a live session's model and reasoning level as current", () => {
		const session = {
			messages: [assistant("anthropic", "claude-sonnet-4")],
			model: { provider: "anthropic", id: "claude-sonnet-4" },
			thinkingLevel: "medium",
		};
		assert.equal(
			buildModelEvidenceLine(run, [session], undefined),
			"current model: anthropic/claude-sonnet-4 · reasoning: medium",
		);
		// Preview copies point at the original handle through cacheKey.
		const preview = { messages: session.messages, cacheKey: session };
		assert.equal(
			buildModelEvidenceLine(run, [preview], undefined),
			"current model: anthropic/claude-sonnet-4 · reasoning: medium",
		);
	});

	it("flags a mid-run model switch instead of pretending one model produced every message", () => {
		const session = {
			messages: [assistant("anthropic", "claude-sonnet-4"), assistant("openai", "gpt-5")],
			model: { provider: "openai", id: "gpt-5" },
			thinkingLevel: "high",
		};
		assert.equal(
			buildModelEvidenceLine(run, [session], undefined),
			"current model: openai/gpt-5 · reasoning: high · changed during run",
		);
		assert.equal(
			buildModelEvidenceLine(run, undefined, [{ messages: session.messages }]),
			"last model: openai/gpt-5 · changed during run",
		);
	});

	it("falls back to the recorded transcript model, then the persisted step model, labelled last", () => {
		assert.equal(
			buildModelEvidenceLine(run, undefined, [{ messages: [assistant("anthropic", "claude-opus-4")] }]),
			"last model: anthropic/claude-opus-4",
		);
		const persisted = liveRun({
			...run.run,
			steps: [{ index: 0, agent: "fixer", status: "complete", model: "anthropic/claude-opus-4" }],
		});
		assert.equal(buildModelEvidenceLine(persisted, undefined, undefined), "last model: anthropic/claude-opus-4");
		const text = stripAnsi(buildRightLines(theme, { kind: "run", run: persisted }, 100).join("\n"));
		assert.match(text, /^last model: anthropic\/claude-opus-4$/m);
		assert.doesNotMatch(text, /reasoning/, "no persisted reasoning level exists, so none is invented");
	});
});
