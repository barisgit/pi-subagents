import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { AsyncRunSummary } from "../../src/state/async-status.ts";
import { buildRightLines, selectToolArg } from "../../src/surfaces/dashboard-detail-renderer.ts";
import { buildSelectedRunStatusBox, type LiveRun } from "../../src/surfaces/subagents-status.ts";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { PersistedRunStatus } from "../../src/protocol/status-types.ts";

// The final-text and narration blocks render through pi-tui Markdown, whose
// heading styles read the pi theme singleton; initialize it once for the suite.
initTheme();

const theme = { fg: (_name: string, text: string) => text, bg: (_name: string, text: string) => text } as never;

const LONG_PROMPT = [
	"Redesign the dashboard right pane into a simple scannable renderer.",
	"The current pane dumps the full prompt as a wall of muted prose and prints raw JSON args.",
	"Collapse the prompt, humanize tool lines, interleave assistant narration,",
	"keep the step feed chrome-free and the final markdown block intact.",
	"Verify with unit tests that feed a synthetic transcript and assert the clipping,",
	"humanization, narration, and final block behavior all hold under a narrow width.",
].join(" ");

const RUN_CODE = '\nconst lessons = await r("lessons.md");\nout(lessons.value);\nreturn { ok: true };\n';

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function makeRun(id: string, asyncDir: string, label?: string): AsyncRunSummary {
	return {
		id,
		asyncDir,
		state: "complete",
		mode: "single",
		startedAt: 1000,
		...(label ? { label } : {}),
		steps: [{ index: 0, agent: "fixer", status: "complete" }],
	};
}

function writeStatus(
	dir: string,
	runId: string,
	options: { label?: string; stepLabel?: string; tokens?: number; durationMs?: number } = {},
): void {
	const totalTokens = options.tokens ?? 300;
	const durationMs = options.durationMs ?? 4000;
	const status: PersistedRunStatus = {
		runId,
		mode: "single",
		...(options.label ? { label: options.label } : {}),
		state: "complete",
		startedAt: 1000,
		endedAt: 1000 + durationMs,
		lastUpdate: 1000 + durationMs,
		steps: [
			{
				agent: "fixer",
				...(options.stepLabel ? { label: options.stepLabel } : {}),
				status: "complete",
				startedAt: 1000,
				endedAt: 1000 + durationMs,
				durationMs,
				tokens: { input: 100, output: Math.max(0, totalTokens - 100), total: totalTokens },
			},
		],
	};
	fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify(status), "utf-8");
}

function writeSession(dir: string, records: Array<Record<string, unknown>>): void {
	const runDir = path.join(dir, "run-0");
	fs.mkdirSync(runDir, { recursive: true });
	const session = { type: "session", version: 3, id: "s1", timestamp: "2026-05-20T00:00:00.000Z", cwd: dir };
	fs.writeFileSync(
		path.join(runDir, "session.jsonl"),
		[session, ...records].map((record) => JSON.stringify(record)).join("\n") + "\n",
		"utf-8",
	);
}

function assistant(iso: string, content: unknown[]): Record<string, unknown> {
	return { type: "message", timestamp: iso, message: { role: "assistant", content } };
}

function user(iso: string, content: unknown[]): Record<string, unknown> {
	return { type: "message", timestamp: iso, message: { role: "user", content } };
}

describe("dashboard detail pane redesign", () => {
	it("renders the full prompt, every tool call on its own card, and keeps the final block", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), `detail-render-${randomUUID()}-`));
		try {
			writeStatus(dir, "run-detail", { tokens: 4240235, durationMs: 838449 });
			const records: Array<Record<string, unknown>> = [
				user("2026-05-20T00:00:00.050Z", [{ type: "text", text: LONG_PROMPT }]),
			];
			for (let i = 0; i < 15; i++) {
				const ts = Date.parse("2026-05-20T00:00:01.000Z") + i * 200;
				records.push(
					assistant(new Date(ts).toISOString(), [
						{ type: "tool_use", id: `t${i}`, name: "run", input: { code: RUN_CODE } },
					]),
				);
				records.push(
					user(new Date(ts + 100).toISOString(), [
						{ type: "tool_result", tool_use_id: `t${i}`, content: "ok" },
					]),
				);
			}
			records.push(
				assistant("2026-05-20T00:00:09.000Z", [
					{ type: "text", text: "## Verdict\n\nAll good.\n\n## Risks\n\n- none" },
				]),
			);
			writeSession(dir, records);

			const lines = buildRightLines(theme, { ownership: "foreign", run: makeRun("run-detail", dir) }, 60);
			const plainLines = lines.map(stripAnsi);
			const joined = plainLines.join("\n");

			// Prompt: full text, no label and no clip marker.
			assert.equal(
				plainLines.findIndex((line) => line === "prompt:"),
				-1,
				`prompt label must be hidden:\n${joined}`,
			);
			assert.doesNotMatch(joined, /\(\d+ more lines\)/, "prompt must not show a clip marker");
			assert.match(joined, /final block behavior/, "full prompt tail must be visible");

			// NO ×N grouping: all 15 run calls render their own card. The primary
			// code arg is verbatim multi-line content, not a collapsed first line.
			const runLines = plainLines.filter((line) => line.startsWith("→ run"));
			assert.equal(runLines.length, 15, `expected 15 individual run cards:\n${joined}`);
			assert.doesNotMatch(joined, /×\d/, "consecutive same-tool calls must NOT collapse");
			for (const line of runLines) {
				assert.match(line, /^→ run · \d+ms/);
			}
			const firstCodeLines = plainLines.filter((line) => line.includes("const lessons = await r("));
			const secondCodeLines = plainLines.filter((line) => line.includes("out(lessons.value);"));
			assert.equal(firstCodeLines.length, 15, `expected first verbatim code line per card:\n${joined}`);
			assert.equal(secondCodeLines.length, 15, `expected second verbatim code line per card:\n${joined}`);
			assert.doesNotMatch(joined, /\\n|\\"/, "no raw JSON escapes in the pane");

			// Result hints: each tool card includes a dim "↳" preview.
			const hintLines = plainLines.filter((line) => line.trimStart().startsWith("↳"));
			assert.equal(hintLines.length, 15, `expected one result hint per tool card:\n${joined}`);
			assert.match(hintLines[0]!, /↳ ok/);

			// Deleted step chrome stays out of the feed; the bordered final markdown block remains.
			assert.doesNotMatch(joined, /─── Step 1: fixer ───/);
			assert.doesNotMatch(joined, /15 tools · 4\.2Mt · 13m58s/);
			assert.doesNotMatch(joined, /─── done · complete · 4\.2Mt · 13m58s ───/);
			assert.match(joined, /Verdict/);
			assert.match(joined, /All good\./);
			const border = "─".repeat(60);
			assert.equal(plainLines.filter((line) => line === border).length, 2, "final block keeps both borders");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("removes run and step label chrome from the feed", () => {
		const duplicateDir = fs.mkdtempSync(path.join(os.tmpdir(), `detail-render-${randomUUID()}-`));
		const distinctDir = fs.mkdtempSync(path.join(os.tmpdir(), `detail-render-${randomUUID()}-`));
		try {
			const duplicateLabel = "detail pane v4: full prompt + tab glitch";
			writeStatus(duplicateDir, "run-label-duplicate", { label: duplicateLabel });
			writeSession(duplicateDir, [user("2026-05-20T00:00:00.050Z", [{ type: "text", text: "Fix this." }])]);
			const duplicateLines = buildRightLines(
				theme,
				{ ownership: "foreign", run: makeRun("run-label-duplicate", duplicateDir, duplicateLabel) },
				80,
			).map(stripAnsi);
			assert.equal(
				duplicateLines.findIndex((line) => line === `Label: ${duplicateLabel}`),
				-1,
				`duplicate label must be hidden:\n${duplicateLines.join("\n")}`,
			);

			writeStatus(distinctDir, "run-label-distinct", { label: "run label", stepLabel: "distinct step label" });
			writeSession(distinctDir, [user("2026-05-20T00:00:00.050Z", [{ type: "text", text: "Fix this." }])]);
			const distinctLines = buildRightLines(
				theme,
				{ ownership: "foreign", run: makeRun("run-label-distinct", distinctDir, "run label") },
				80,
			).map(stripAnsi);
			assert.equal(
				distinctLines.findIndex((line) => line === "Label: distinct step label"),
				-1,
				`distinct step label must be hidden:\n${distinctLines.join("\n")}`,
			);
		} finally {
			fs.rmSync(duplicateDir, { recursive: true, force: true });
			fs.rmSync(distinctDir, { recursive: true, force: true });
		}
	});

	it("interleaves assistant narration between tool cards, before the final block", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), `detail-render-${randomUUID()}-`));
		try {
			writeStatus(dir, "run-narrate");
			writeSession(dir, [
				user("2026-05-20T00:00:00.050Z", [{ type: "text", text: "Fix the bug." }]),
				assistant("2026-05-20T00:00:01.000Z", [
					{ type: "text", text: "Let me look at the failing test first." },
					{ type: "tool_use", id: "t1", name: "read", input: { path: "/abs/test.ts" } },
				]),
				user("2026-05-20T00:00:01.200Z", [{ type: "tool_result", tool_use_id: "t1", content: "34 matches" }]),
				assistant("2026-05-20T00:00:02.000Z", [
					{ type: "text", text: "The assertion is inverted; patching now." },
					{ type: "tool_use", id: "t2", name: "edit", input: { path: "/abs/src.ts" } },
				]),
				user("2026-05-20T00:00:02.300Z", [{ type: "tool_result", tool_use_id: "t2", content: "edited" }]),
				assistant("2026-05-20T00:00:03.000Z", [{ type: "text", text: "Fixed the inverted assertion." }]),
			]);

			const lines = buildRightLines(theme, { ownership: "foreign", run: makeRun("run-narrate", dir) }, 80);
			const plainLines = lines.map(stripAnsi);
			const joined = plainLines.join("\n");

			const narr1 = plainLines.findIndex((line) => line.includes("Let me look at the failing test first."));
			const tool1 = plainLines.findIndex((line) => line.startsWith("→ read"));
			const arg1 = plainLines.findIndex((line) => line.trim() === "/abs/test.ts");
			const hint1 = plainLines.findIndex((line) => line.trimStart().startsWith("↳ 34 matches"));
			const narr2 = plainLines.findIndex((line) => line.includes("The assertion is inverted; patching now."));
			const tool2 = plainLines.findIndex((line) => line.startsWith("→ edit"));
			const finalIdx = plainLines.findIndex((line) => line.includes("Fixed the inverted assertion."));
			assert.ok(
				narr1 >= 0 &&
					tool1 > narr1 &&
					arg1 === tool1 + 1 &&
					hint1 === arg1 + 1 &&
					narr2 > hint1 &&
					tool2 > narr2 &&
					finalIdx > tool2,
				`chat order wrong (${narr1}/${tool1}/${arg1}/${hint1}/${narr2}/${tool2}/${finalIdx}):\n${joined}`,
			);
			// Breathing room: outside blank lines separate the padded tool card from
			// narration. The card's own padding lines are width-long whitespace.
			assert.equal(plainLines[tool1 - 2], "", "blank line before the tool card");
			assert.equal(plainLines[hint1 + 2], "", "blank line after the tool card");
			assert.ok(plainLines[tool1 - 1]?.trim() === "" && visibleWidth(plainLines[tool1 - 1]!) === 80);
			assert.ok(plainLines[hint1 + 1]?.trim() === "" && visibleWidth(plainLines[hint1 + 1]!) === 80);
			// The last assistant text is the FINAL block (bordered), not narration:
			// it appears exactly once.
			assert.equal(
				plainLines.filter((line) => line.includes("Fixed the inverted assertion.")).length,
				1,
				"final text must not double as narration",
			);
			const border = "─".repeat(80);
			assert.equal(plainLines.filter((line) => line === border).length, 2, "final block bordered");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

// Background cards: pad-then-wrap like pi-tui's Box.applyBg. A styled theme
// stub with REAL ANSI escapes proves the bg opens at line start, closes at
// line end (no bleed into the next row), and the padded visible width is
// exactly the pane width.
const BG_OPEN: Record<string, string> = {
	toolSuccessBg: "\x1b[42m",
	toolErrorBg: "\x1b[41m",
	userMessageBg: "\x1b[44m",
};
const styledTheme = {
	fg: (_name: string, text: string) => text,
	bg: (name: string, text: string) => `${BG_OPEN[name] ?? "\x1b[40m"}${text}\x1b[49m`,
} as never;

const STATUS_FG: Record<string, string> = {
	dim: "\x1b[2m",
	success: "\x1b[32m",
	accent: "\x1b[36m",
	warning: "\x1b[33m",
	error: "\x1b[31m",
};
const statusTheme = {
	fg: (name: string, text: string) => `${STATUS_FG[name] ?? "\x1b[37m"}${text}\x1b[39m`,
	bg: (_name: string, text: string) => text,
} as never;

describe("dashboard selected-run status box", () => {
	it("renders a compact pi-charter-style box at exact width without background bleed", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), `detail-render-${randomUUID()}-`));
		try {
			writeSession(dir, [
				assistant("2026-05-20T00:00:01.000Z", [
					{ type: "tool_use", id: "t1", name: "read", input: { path: "/abs/test.ts" } },
				]),
				user("2026-05-20T00:00:01.200Z", [{ type: "tool_result", tool_use_id: "t1", content: "ok" }]),
				assistant("2026-05-20T00:00:02.000Z", [
					{ type: "tool_use", id: "t2", name: "edit", input: { path: "/abs/src.ts" } },
				]),
				user("2026-05-20T00:00:02.300Z", [{ type: "tool_result", tool_use_id: "t2", content: "edited" }]),
			]);
			const summary: AsyncRunSummary = {
				...makeRun("run-status-box", dir, "polish dashboard"),
				mode: "parallel",
				endedAt: 1000 + 838449,
				totalTokens: { input: 1_000_000, output: 3_240_235, total: 4_240_235 },
			};
			const width = 44;
			const lines = buildSelectedRunStatusBox(
				statusTheme,
				{ ownership: "foreign", run: summary } satisfies LiveRun,
				width,
			);
			const plainLines = lines.map(stripAnsi);
			const joined = plainLines.join("\n");

			assert.equal(lines.length, 4, "box stays tight");
			assert.match(plainLines[0]!, /^╭─ polish dashboard ─+ complete · 13m58s ─╮$/);
			assert.match(plainLines[1]!, /│ 2 tools · 4\.2Mt · 13m58s +│/);
			assert.match(plainLines[2]!, /│ parallel · id run-stat · started \d\d:\d\d +│/);
			assert.match(plainLines[3]!, /^╰─+╯$/);
			for (const line of lines) {
				assert.equal(
					visibleWidth(line),
					width,
					`status box line must fit sidebar width: ${JSON.stringify(line)}`,
				);
				assert.doesNotMatch(
					line,
					/\x1b\[(?:4[0-9]|10[0-7]|49)m/,
					`status box must use fg only, no bg bleed: ${JSON.stringify(line)}`,
				);
			}
			assert.match(
				lines[0]!,
				/\x1b\[32mcomplete · 13m58s\x1b\[39m/,
				`complete tail is success-colored:\n${joined}`,
			);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("dashboard detail pane tool cards", () => {
	it("renders tool calls as padded multi-line bg cards with verbatim args and inner result hints", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), `detail-render-${randomUUID()}-`));
		try {
			writeStatus(dir, "run-cards");
			writeSession(dir, [
				user("2026-05-20T00:00:00.050Z", [{ type: "text", text: LONG_PROMPT }]),
				assistant("2026-05-20T00:00:01.000Z", [
					{ type: "text", text: "Reading the lessons file." },
					{ type: "tool_use", id: "t1", name: "run", input: { code: RUN_CODE } },
				]),
				user("2026-05-20T00:00:01.200Z", [{ type: "tool_result", tool_use_id: "t1", content: "ok" }]),
				// Failed call recorded via the host's dedicated toolResult message shape.
				assistant("2026-05-20T00:00:02.000Z", [
					{ type: "tool_use", id: "t2", name: "bash", input: { command: "npm test" } },
				]),
				{
					type: "message",
					timestamp: "2026-05-20T00:00:02.500Z",
					message: {
						role: "toolResult",
						toolCallId: "t2",
						toolName: "bash",
						content: [{ type: "text", text: "FAIL 3 tests" }],
						isError: true,
					},
				},
				assistant("2026-05-20T00:00:03.000Z", [{ type: "text", text: "Done." }]),
			]);

			const width = 48;
			const lines = buildRightLines(styledTheme, { ownership: "foreign", run: makeRun("run-cards", dir) }, width);
			const plainLines = lines.map(stripAnsi);
			const joined = plainLines.join("\n");

			// Success card: green bg, empty top/bottom padding, title, verbatim code
			// lines, and result hint inside the card.
			const successCard = lines.filter((line) => line.startsWith(BG_OPEN.toolSuccessBg!));
			const successPlain = successCard.map(stripAnsi);
			assert.ok(successCard.length >= 6, `expected a multi-line success card:\n${joined}`);
			assert.equal(visibleWidth(successCard[0]!), width);
			assert.equal(successPlain[0]!.trim(), "", "first success card line is empty padded content");
			assert.ok(successCard[0]!.endsWith("\x1b[49m"));
			assert.match(successPlain[1]!, /→ run · \d+ms/);
			assert.ok(successPlain.some((line) => line.includes("const lessons = await r(")));
			assert.ok(successPlain.some((line) => line.includes("out(lessons.value);")));
			assert.ok(
				successPlain.some((line) => line.includes("↳ ok")),
				`result hint must render inside the bg card:\n${joined}`,
			);
			assert.equal(successPlain.at(-1)!.trim(), "", "last success card line is empty padded content");
			assert.equal(visibleWidth(successCard.at(-1)!), width);
			assert.ok(successCard.at(-1)!.endsWith("\x1b[49m"));

			// Error card: the toolResult isError flag flips the palette to toolErrorBg.
			const errorCard = lines.filter((line) => line.startsWith(BG_OPEN.toolErrorBg!));
			const errorPlain = errorCard.map(stripAnsi);
			assert.ok(errorCard.length >= 5, `expected an error card for the failed bash call:\n${joined}`);
			assert.equal(errorPlain[0]!.trim(), "", "first error card line is empty padded content");
			assert.match(errorPlain[1]!, /→ bash · \d+ms/);
			assert.ok(errorPlain.some((line) => line.includes("npm test")));
			assert.ok(errorPlain.some((line) => line.includes("↳ FAIL 3 tests")));
			assert.equal(errorPlain.at(-1)!.trim(), "", "last error card line is empty padded content");

			// Prompt block renders on the host's user-message background with empty
			// top/bottom padding, matching tool-card padding.
			const promptCard = lines.filter((line) => line.startsWith(BG_OPEN.userMessageBg!));
			const promptPlain = promptCard.map(stripAnsi);
			assert.ok(promptCard.length > 4, `full prompt + padding on userMessageBg:\n${joined}`);
			assert.equal(promptPlain[0]!.trim(), "", "first prompt card line is empty padded content");
			assert.equal(promptPlain.at(-1)!.trim(), "", "last prompt card line is empty padded content");
			assert.match(promptPlain.join("\n"), /final block behavior/);

			// ANSI hygiene for EVERY bg line: padded to exactly the pane width and the
			// bg reset is the line's final escape — no bleed into the next row.
			for (const line of [...successCard, ...errorCard, ...promptCard]) {
				assert.equal(visibleWidth(line), width, `bg line must pad to pane width: ${JSON.stringify(line)}`);
				assert.ok(line.endsWith("\x1b[49m"), `bg must close at line end: ${JSON.stringify(line)}`);
			}

			// Blank separator lines between cards and narration carry NO background.
			assert.ok(
				lines.some((line) => line === ""),
				"cards are separated by plain blank lines",
			);

			assert.doesNotMatch(joined, /─── done · complete/, "step footer must be removed");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("normalizes tabs before padding bg lines", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), `detail-render-${randomUUID()}-`));
		try {
			writeStatus(dir, "run-tabs");
			writeSession(dir, [
				user("2026-05-20T00:00:00.050Z", [{ type: "text", text: "Fix\tthis prompt with\ttabs." }]),
				assistant("2026-05-20T00:00:01.000Z", [
					{ type: "tool_use", id: "t1", name: "run", input: { code: "if (ok) {\n\treturn 1;\n}" } },
				]),
				user("2026-05-20T00:00:01.200Z", [
					{
						type: "tool_result",
						tool_use_id: "t1",
						content: "\x1b[31mred\tresult\x1b[39m\nplain\tline",
					},
				]),
			]);

			const width = 36;
			const lines = buildRightLines(styledTheme, { ownership: "foreign", run: makeRun("run-tabs", dir) }, width);
			const bgLines = lines.filter(
				(line) => line.startsWith(BG_OPEN.userMessageBg!) || line.startsWith(BG_OPEN.toolSuccessBg!),
			);
			const plainLines = bgLines.map(stripAnsi);
			const joined = plainLines.join("\n");

			assert.ok(joined.includes("Fix this prompt"), `prompt tabbed text missing:\n${joined}`);
			assert.ok(joined.includes("    return 1;"), `code tab not expanded:\n${joined}`);
			assert.ok(joined.includes("↳ red    result"), `ANSI result tab not expanded:\n${joined}`);
			assert.doesNotMatch(joined, /\t/, "tabs must not reach bg-rendered lines");

			const codeIdx = plainLines.findIndex((line) => line.includes("return 1;"));
			const resultIdx = plainLines.findIndex((line) => line.includes("↳ red    result"));
			assert.ok(codeIdx >= 0 && resultIdx > codeIdx, `result hint must follow code block:\n${joined}`);

			for (const line of bgLines) {
				assert.equal(visibleWidth(line), width, `bg line must pad to pane width: ${JSON.stringify(line)}`);
				assert.ok(line.endsWith("\x1b[49m"), `bg must close at line end: ${JSON.stringify(line)}`);
			}
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("folds long arg and result blocks with line-count markers", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), `detail-render-${randomUUID()}-`));
		try {
			writeStatus(dir, "run-fold");
			const longCode = [
				"const one = 1;",
				"const two = 2;",
				"const three = 3;",
				"const four = 4;",
				"const five = 5;",
				"return one + two + three + four + five;",
			].join("\n");
			writeSession(dir, [
				user("2026-05-20T00:00:00.050Z", [{ type: "text", text: "Run a long command." }]),
				assistant("2026-05-20T00:00:01.000Z", [
					{ type: "tool_use", id: "t1", name: "run", input: { code: longCode } },
				]),
				user("2026-05-20T00:00:01.200Z", [
					{ type: "tool_result", tool_use_id: "t1", content: "alpha\nbeta\ngamma\ndelta\nepsilon" },
				]),
			]);

			const lines = buildRightLines(theme, { ownership: "foreign", run: makeRun("run-fold", dir) }, 90).map(
				stripAnsi,
			);
			const joined = lines.join("\n");
			assert.match(joined, /const one = 1;/);
			assert.match(joined, /const four = 4;/);
			assert.doesNotMatch(joined, /const five = 5;/);
			assert.ok(
				lines.some((line) => line.trim() === "… (+2 lines)"),
				`arg fold marker missing:\n${joined}`,
			);

			const resultStart = lines.findIndex((line) => line.trimStart().startsWith("↳ alpha"));
			assert.ok(resultStart >= 0, `result start missing:\n${joined}`);
			assert.equal(lines[resultStart + 1]!.trim(), "beta");
			assert.equal(lines[resultStart + 2]!.trim(), "gamma");
			assert.equal(lines[resultStart + 3]!.trim(), "… (+2 lines)");
			assert.doesNotMatch(joined, /delta|epsilon/);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("selectToolArg", () => {
	it("maps builtins to path/pattern hints", () => {
		assert.deepEqual(selectToolArg("read", { path: "/tmp/a.ts", offset: 5 }), { text: "/tmp/a.ts" });
		assert.deepEqual(selectToolArg("edit", { path: "/tmp/a.ts", oldText: "a", newText: "b" }), {
			text: "/tmp/a.ts",
		});
		assert.deepEqual(selectToolArg("grep", { pattern: "foo|bar", path: "/tmp/src" }), { text: "foo|bar /tmp/src" });
		assert.deepEqual(selectToolArg("find", { pattern: "**/*.ts" }), { text: "**/*.ts" });
		assert.deepEqual(selectToolArg("ls", { path: "/tmp" }), { text: "/tmp" });
	});
	it("selects full verbatim code/command values with key-based languages", () => {
		assert.deepEqual(selectToolArg("run", { code: "\n\n  const x = 1;\nreturn x;" }), {
			text: "\n\n  const x = 1;\nreturn x;",
			lang: "javascript",
		});
		assert.deepEqual(selectToolArg("bash", { command: "  \n npm test\nmore" }), {
			text: "  \n npm test\nmore",
			lang: "bash",
		});
		assert.deepEqual(selectToolArg("workflow", { script: "\nphase('scope');\nmore" }), {
			text: "\nphase('scope');\nmore",
			lang: "javascript",
		});
	});
	it("maps extension tools to their salient fields", () => {
		assert.deepEqual(selectToolArg("subagent", { run: [], agent: "scout", task: "find tests\nand more" }), {
			text: "scout find tests\nand more",
		});
		assert.deepEqual(selectToolArg("subagent", { action: "status", id: "r-1" }), { text: "status r-1" });
		assert.deepEqual(selectToolArg("process", { action: "start", name: "dev-server" }), {
			text: "start dev-server",
		});
		assert.deepEqual(selectToolArg("fetch", { url: "https://x.dev/a" }), { text: "https://x.dev/a" });
		assert.deepEqual(selectToolArg("ast_grep", { pattern: "foo($X)" }), { text: "foo($X)" });
		assert.deepEqual(selectToolArg("mcp", { tool: "exa_web_search", args: { q: "x" } }), {
			text: "exa_web_search",
		});
		assert.deepEqual(selectToolArg("task", { action: "create", creates: [] }), { text: "create" });
		assert.deepEqual(selectToolArg("apply_patch", { path: "src/a.ts", patch: "@@" }), { text: "src/a.ts" });
	});
	it("falls back to salient keys then first short string for unknown tools — never raw JSON", () => {
		assert.deepEqual(selectToolArg("imagegen", { prompt: "a red fox\nsitting" }), { text: "a red fox\nsitting" });
		assert.deepEqual(selectToolArg("unknown", { command: "npm test\nagain" }), {
			text: "npm test\nagain",
			lang: "bash",
		});
		assert.deepEqual(selectToolArg("charter", { action: "list" }), { text: "list" });
		assert.deepEqual(selectToolArg("mystery", { count: 3, flag: true }), { text: "" });
		assert.deepEqual(selectToolArg("mystery", undefined), { text: "" });
	});
});
