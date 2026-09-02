import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SubagentNotifyNoticeComponent } from "../../src/surfaces/message-renderers.ts";
import { renderNestedChild } from "../../src/surfaces/render-inline.ts";
import { buildWidgetLines } from "../../src/surfaces/render-widget.ts";
import { stateKey } from "../../src/surfaces/row-line.ts";
import { rmRun, writeRun } from "./inline-nested-helpers.ts";

type NoticeTheme = ExtensionContext["ui"]["theme"];

const runId = "surface-row-state-parity";

afterEach(() => rmRun(runId));

function recordingTheme(): { theme: NoticeTheme; glyphColors: string[] } {
	const glyphColors: string[] = [];
	const theme = {
		fg: (color: string, text: string) => {
			if (text === "✗") glyphColors.push(color);
			return text;
		},
		bg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as NoticeTheme;
	return { theme, glyphColors };
}

describe("cross-surface row state parity", () => {
	it("uses the same state key for failed widget, notice, and inline rows", () => {
		const state = "failed" as const;
		const expected = stateKey(state);
		writeRun(runId, { state, agent: "worker", label: "check parity" });

		const widget = recordingTheme();
		buildWidgetLines(
			[{ asyncId: runId, asyncDir: "/tmp/parity", status: state, agents: ["worker"] }],
			widget.theme,
			120,
		);

		const notice = recordingTheme();
		new SubagentNotifyNoticeComponent(
			{ agent: "worker", status: state, resultPreview: "failed" },
			{ expanded: false },
			notice.theme,
		).render(80);

		const inline = recordingTheme();
		renderNestedChild(runId, 1, undefined, new Set(), inline.theme);

		assert.deepEqual(
			[widget.glyphColors[0], notice.glyphColors[0], inline.glyphColors[0]],
			[expected, expected, expected],
		);
	});
});
