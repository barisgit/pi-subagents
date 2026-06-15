import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildWidgetLines } from "../../src/surfaces/render-widget.ts";
import { deriveDisplayRows, isPendingDelivery } from "../../src/surfaces/dashboard-row-model.ts";
import type { LiveRun } from "../../src/surfaces/subagents-status.ts";
import type { AsyncRunSummary } from "../../src/state/async-status.ts";

function createTaggingTheme() {
	return {
		fg: (token: string, text: string) => `<${token}>${text}</${token}>`,
		bg: (_token: string, text: string) => text,
	} as unknown as Parameters<typeof buildWidgetLines>[1];
}

interface AsyncSeed {
	id: string;
	mode?: "single" | "parallel";
	state?: AsyncRunSummary["state"];
	label?: string;
	parentRunId?: string;
	agent?: string;
	startedAt: number;
}

function asyncRun(seed: AsyncSeed): LiveRun {
	const state = seed.state ?? "running";
	return {
		ownership: "foreign",
		run: {
			id: seed.id,
			asyncDir: `/tmp/${seed.id}`,
			mode: seed.mode ?? "single",
			state,
			startedAt: seed.startedAt,
			lastUpdate: seed.startedAt + 1,
			steps: seed.agent ? [{ index: 0, agent: seed.agent, status: state, startedAt: seed.startedAt }] : [],
			...(seed.label ? { label: seed.label } : {}),
			...(seed.parentRunId ? { parentRunId: seed.parentRunId } : {}),
		} as unknown as AsyncRunSummary,
	};
}

describe("dashboard parallel flat presentation", () => {
	it("flattens a parallel container into top-level child rows with batch markers and pending delivery", () => {
		const runs: LiveRun[] = [
			asyncRun({ id: "batch", mode: "parallel", label: "parallel group", startedAt: 1000 }),
			asyncRun({ id: "done", agent: "explorer", parentRunId: "batch", state: "complete", startedAt: 1100 }),
			asyncRun({ id: "live", agent: "qa", parentRunId: "batch", state: "running", startedAt: 1200 }),
		];

		const rows = deriveDisplayRows(runs, new Set());

		// The parallel CONTAINER is never emitted as its own row.
		assert.equal(
			rows.some((row) => row.kind === "run" && row.run.run.id === "batch"),
			false,
		);

		// Both children render flat (depth 0) with the parallel batch marker.
		const done = rows.find((row) => row.kind === "run" && row.run.run.id === "done");
		const live = rows.find((row) => row.kind === "run" && row.run.run.id === "live");
		assert.ok(done && done.kind === "run", "expected complete child row");
		assert.ok(live && live.kind === "run", "expected running child row");
		assert.equal(done.depth, 0);
		assert.equal(live.depth, 0);
		assert.equal(done.parallelMarker, true);
		assert.equal(live.parallelMarker, true);

		// A child that completed while its group is still open is pending delivery.
		const doneRun = runs.find((run) => run.run.id === "done")!;
		const liveRun = runs.find((run) => run.run.id === "live")!;
		assert.equal(isPendingDelivery(runs, doneRun), true);
		assert.equal(isPendingDelivery(runs, liveRun), false);
	});

	it("hides parallel containers in the widget while keeping children at top-level depth", () => {
		const theme = createTaggingTheme();
		const lines = buildWidgetLines(
			[
				{
					asyncId: "batch",
					status: "running",
					mode: "parallel",
					agents: ["explorer", "qa"],
					currentAgent: "qa",
					startedAt: Date.now() - 1000,
				},
				{
					asyncId: "child-a",
					parentRunId: "batch",
					status: "running",
					mode: "single",
					agents: ["explorer"],
					currentAgent: "explorer",
					startedAt: Date.now() - 500,
				},
				{
					asyncId: "child-b",
					parentRunId: "batch",
					status: "running",
					mode: "single",
					agents: ["qa"],
					currentAgent: "qa",
					startedAt: Date.now() - 400,
				},
			] as any,
			theme,
			120,
		);

		const body = lines.join("\n");
		assert.doesNotMatch(body, /parallel/);
		assert.match(body, /explorer/);
		assert.match(body, /qa/);
		for (const line of lines.filter((line) => /explorer|qa/.test(line))) {
			assert.doesNotMatch(line, / {2}[├└]─/);
		}
	});
});
