import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { AsyncRunSummary } from "../../src/state/async-status.ts";
import { buildRightLines, humanizeToolArgs } from "../../src/surfaces/dashboard-detail-renderer.ts";
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
	"keep the step-end separators and the final markdown block intact.",
	"Verify with unit tests that feed a synthetic transcript and assert the clipping,",
	"humanization, narration, and final block behavior all hold under a narrow width.",
].join(" ");

const RUN_CODE = '\nconst lessons = await r("lessons.md");\nout(lessons.value);\nreturn { ok: true };\n';

function makeRun(id: string, asyncDir: string): AsyncRunSummary {
	return {
		id,
		asyncDir,
		state: "complete",
		mode: "single",
		startedAt: 1000,
		steps: [{ index: 0, agent: "fixer", status: "complete" }],
	};
}

function writeStatus(dir: string, runId: string): void {
	const status: PersistedRunStatus = {
		runId,
		mode: "single",
		state: "complete",
		startedAt: 1000,
		endedAt: 5000,
		lastUpdate: 5000,
		steps: [
			{
				agent: "fixer",
				status: "complete",
				startedAt: 1000,
				endedAt: 5000,
				durationMs: 4000,
				tokens: { input: 100, output: 200, total: 300 },
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
	it("clips the prompt, renders every tool call on its own line, and keeps the final block", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), `detail-render-${randomUUID()}-`));
		try {
			writeStatus(dir, "run-detail");
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
			const joined = lines.join("\n");

			// Prompt: preview + marker, never the whole wall of prose.
			const promptIdx = lines.findIndex((line) => line === "prompt:");
			assert.ok(promptIdx >= 0, `prompt label missing:\n${joined}`);
			assert.ok(
				lines.some((line) => /^\s*… \(\d+ more lines\)\s*$/.test(line)),
				`prompt clip marker missing:\n${joined}`,
			);
			assert.doesNotMatch(joined, /final block behavior/, "full prompt tail must be hidden");

			// NO ×N grouping: all 15 run calls render their own card. Line 1 of each
			// card is the tool name + duration; the humanized arg hint follows on its
			// own line inside the card instead of being clipped onto the title.
			const runLines = lines.filter((line) => line.startsWith("→ run"));
			assert.equal(runLines.length, 15, `expected 15 individual run cards:\n${joined}`);
			assert.doesNotMatch(joined, /×\d/, "consecutive same-tool calls must NOT collapse");
			for (const line of runLines) {
				assert.match(line, /^→ run · \d+ms/);
			}
			const hintArgLines = lines.filter((line) => line.includes("const lessons = await r("));
			assert.equal(hintArgLines.length, 15, `expected one arg-hint line per card:\n${joined}`);
			assert.doesNotMatch(joined, /[{}]|\\n|\\"/, "no raw JSON braces or escapes in the pane");

			// Result hints: each tool line is followed by a dim "↳" preview.
			const hintLines = lines.filter((line) => line.trimStart().startsWith("↳"));
			assert.equal(hintLines.length, 15, `expected one result hint per tool line:\n${joined}`);
			assert.match(hintLines[0]!, /↳ ok/);

			// Step separator and bordered final markdown block stay intact.
			assert.match(joined, /─── Step 1: fixer ───/);
			assert.match(joined, /─── done · complete · 300t · 4000ms ───/);
			assert.match(joined, /Verdict/);
			assert.match(joined, /All good\./);
			const border = "─".repeat(60);
			assert.equal(lines.filter((line) => line === border).length, 2, "final block keeps both borders");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("interleaves assistant narration between tool lines, before the final block", () => {
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
			const joined = lines.join("\n");

			const narr1 = lines.findIndex((line) => line.includes("Let me look at the failing test first."));
			const tool1 = lines.findIndex((line) => line.startsWith("→ read"));
			const arg1 = lines.findIndex((line) => line.trim() === "/abs/test.ts");
			const hint1 = lines.findIndex((line) => line.trimStart().startsWith("↳ 34 matches"));
			const narr2 = lines.findIndex((line) => line.includes("The assertion is inverted; patching now."));
			const tool2 = lines.findIndex((line) => line.startsWith("→ edit"));
			const finalIdx = lines.findIndex((line) => line.includes("Fixed the inverted assertion."));
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
			// Breathing room: a blank line separates the tool card from the narration
			// before and after it.
			assert.equal(lines[tool1 - 1], "", "blank line before the tool card");
			assert.equal(lines[hint1 + 1], "", "blank line after the tool card");
			// The last assistant text is the FINAL block (bordered), not narration:
			// it appears exactly once.
			assert.equal(
				lines.filter((line) => line.includes("Fixed the inverted assertion.")).length,
				1,
				"final text must not double as narration",
			);
			const border = "─".repeat(80);
			assert.equal(lines.filter((line) => line === border).length, 2, "final block bordered");
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

describe("dashboard detail pane tool cards", () => {
	it("renders tool calls as multi-line bg cards: padded width, closed bg, wrapped args, inner result hint", () => {
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
			const joined = lines.join("\n");

			// Success card: green bg, title line with duration, arg hint WRAPPED onto
			// following lines (not clipped into the title), result hint inside the card.
			const successCard = lines.filter((line) => line.startsWith(BG_OPEN.toolSuccessBg!));
			assert.ok(successCard.length >= 3, `expected a multi-line success card:\n${joined}`);
			assert.match(successCard[0]!, /→ run · \d+ms/);
			assert.match(successCard[1]!, /const lessons = await r\(/);
			assert.ok(
				successCard.some((line) => line.includes("↳ ok")),
				`result hint must render inside the bg card:\n${joined}`,
			);
			// Arg hint wraps to a bounded number of lines instead of one hard clip.
			const argLines = successCard.filter((line) => !/→ run/.test(line) && !line.includes("↳"));
			assert.ok(argLines.length >= 1 && argLines.length <= 2, `arg hint wraps to ≤2 lines:\n${joined}`);

			// Error card: the toolResult isError flag flips the palette to toolErrorBg.
			const errorCard = lines.filter((line) => line.startsWith(BG_OPEN.toolErrorBg!));
			assert.ok(errorCard.length >= 2, `expected an error card for the failed bash call:\n${joined}`);
			assert.match(errorCard[0]!, /→ bash · \d+ms/);
			assert.ok(errorCard.some((line) => line.includes("↳ FAIL 3 tests")));

			// Prompt block renders on the host's user-message background.
			const promptCard = lines.filter((line) => line.startsWith(BG_OPEN.userMessageBg!));
			assert.equal(promptCard.length, 4, `3 preview lines + clip marker on userMessageBg:\n${joined}`);

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
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("humanizeToolArgs", () => {
	it("maps builtins to path/pattern hints", () => {
		assert.equal(humanizeToolArgs("read", { path: "/tmp/a.ts", offset: 5 }), "/tmp/a.ts");
		assert.equal(humanizeToolArgs("edit", { path: "/tmp/a.ts", oldText: "a", newText: "b" }), "/tmp/a.ts");
		assert.equal(humanizeToolArgs("grep", { pattern: "foo|bar", path: "/tmp/src" }), "foo|bar /tmp/src");
		assert.equal(humanizeToolArgs("find", { pattern: "**/*.ts" }), "**/*.ts");
		assert.equal(humanizeToolArgs("ls", { path: "/tmp" }), "/tmp");
	});
	it("extracts the first meaningful line for code/command tools", () => {
		assert.equal(humanizeToolArgs("run", { code: "\n\n  const x = 1;\nreturn x;" }), "const x = 1;");
		assert.equal(humanizeToolArgs("bash", { command: "  \n npm test\nmore" }), "npm test");
	});
	it("maps extension tools to their salient fields", () => {
		assert.equal(
			humanizeToolArgs("subagent", { run: [], agent: "scout", task: "find tests\nand more" }),
			"scout find tests",
		);
		assert.equal(humanizeToolArgs("subagent", { action: "status", id: "r-1" }), "status r-1");
		assert.equal(humanizeToolArgs("workflow", { script: "\nphase('scope');\nmore" }), "phase('scope');");
		assert.equal(humanizeToolArgs("process", { action: "start", name: "dev-server" }), "start dev-server");
		assert.equal(humanizeToolArgs("fetch", { url: "https://x.dev/a" }), "https://x.dev/a");
		assert.equal(humanizeToolArgs("ast_grep", { pattern: "foo($X)" }), "foo($X)");
		assert.equal(humanizeToolArgs("mcp", { tool: "exa_web_search", args: { q: "x" } }), "exa_web_search");
		assert.equal(humanizeToolArgs("task", { action: "create", creates: [] }), "create");
		assert.equal(humanizeToolArgs("apply_patch", { path: "src/a.ts", patch: "@@" }), "src/a.ts");
	});
	it("falls back to salient keys then first short string for unknown tools — never raw JSON", () => {
		assert.equal(humanizeToolArgs("imagegen", { prompt: "a red fox\nsitting" }), "a red fox");
		assert.equal(humanizeToolArgs("charter", { action: "list" }), "list");
		assert.equal(humanizeToolArgs("mystery", { count: 3, flag: true }), "");
		assert.equal(humanizeToolArgs("mystery", undefined), "");
	});
});
