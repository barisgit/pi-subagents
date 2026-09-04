import assert from "node:assert/strict";
import * as fs from "node:fs";
import { describe, it } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { buildRightLines } from "../../src/surfaces/dashboard-detail-renderer.ts";
import { SubagentsStatusComponent } from "../../src/surfaces/subagents-status.ts";
import { fe2026LiveRuns, fe2026Runs } from "../fixtures/dashboard/phase-first-fe-2026.ts";

initTheme();

type StatusTui = ConstructorParameters<typeof SubagentsStatusComponent>[0];
type StatusTheme = ConstructorParameters<typeof SubagentsStatusComponent>[1];

const theme = {
	fg: (_token: string, text: string) => text,
	bg: (_token: string, text: string) => text,
} as StatusTheme;

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function fixture(name: "tree" | "chain"): string {
	return fs
		.readFileSync(new URL(`../fixtures/dashboard/phase-first-fe-2026.${name}.txt`, import.meta.url), "utf8")
		.trimEnd();
}

function renderTree(): string {
	const tui = { requestRender: () => {}, terminal: { rows: 48 } } as StatusTui;
	const component = new SubagentsStatusComponent(tui, theme, () => {}, {
		listRunsForOverlay: () => ({ active: [], recent: [] }),
		listForegroundRuns: () => fe2026Runs,
		refreshMs: 0,
	});
	try {
		const rows: string[] = [];
		for (const line of component.render(220).slice(1)) {
			const left = stripAnsi(line).slice(1).split("│")[0]?.trimEnd() ?? "";
			if (left.startsWith("─")) break;
			if (left.trim()) rows.push(left.replace(/\s+@\d{2}:\d{2}$/, ""));
		}
		return rows.join("\n");
	} finally {
		component.dispose();
	}
}

describe("FE-2026 phase-first render fixture", () => {
	it("renders the expanded workflow tree", () => {
		assert.equal(renderTree(), fixture("tree"));
	});

	it("renders one pipeline item as a cross-stage chain", () => {
		const selected = fe2026LiveRuns.find((run) => run.run.id === "draft-build-b");
		assert.ok(selected);
		const rendered = stripAnsi(
			buildRightLines(theme, { kind: "run", run: selected }, 110, fe2026LiveRuns, undefined, undefined, {
				pipelineChain: true,
			}).join("\n"),
		)
			.split("\n")
			.map((line) => line.trimEnd())
			.join("\n")
			.trimEnd();
		assert.equal(rendered, fixture("chain"), "the explicit chain view keeps the cross-stage fixture");
	});
});
