import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { AsyncRunSummary } from "../../src/state/async-status.ts";
import { buildRightLines, humanizeToolArgs } from "../../src/surfaces/dashboard-detail-renderer.ts";
import type { PersistedRunStatus } from "../../src/protocol/status-types.ts";

// The final-text block renders through pi-tui Markdown, whose heading styles
// read the pi theme singleton; initialize it once for the suite.
initTheme();

const theme = { fg: (_name: string, text: string) => text, bg: (_name: string, text: string) => text } as never;

const LONG_PROMPT = [
	"Redesign the dashboard right pane into a simple scannable renderer.",
	"The current pane dumps the full prompt as a wall of muted prose and prints raw JSON args.",
	"Collapse the prompt, humanize tool lines, group consecutive same-tool calls,",
	"keep the step-end separators and the final markdown block intact.",
	"Verify with unit tests that feed a synthetic transcript and assert the clipping,",
	"humanization, grouping, and final block behavior all hold under a narrow width.",
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

function writeRunRecord(dir: string, runToolCalls: number): void {
	const status: PersistedRunStatus = {
		runId: "run-detail",
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
	const records: Array<Record<string, unknown>> = [
		{ type: "session", version: 3, id: "s1", timestamp: "2026-05-20T00:00:00.000Z", cwd: dir },
		{
			type: "message",
			timestamp: "2026-05-20T00:00:00.050Z",
			message: { role: "user", content: [{ type: "text", text: LONG_PROMPT }] },
		},
	];
	for (let i = 0; i < runToolCalls; i++) {
		const ts = new Date(Date.parse("2026-05-20T00:00:01.000Z") + i * 200);
		records.push({
			type: "message",
			timestamp: ts.toISOString(),
			message: {
				role: "assistant",
				content: [{ type: "tool_use", id: `t${i}`, name: "run", input: { code: RUN_CODE } }],
			},
		});
		records.push({
			type: "message",
			timestamp: new Date(ts.getTime() + 100).toISOString(),
			message: { role: "user", content: [{ type: "tool_result", tool_use_id: `t${i}`, content: "ok" }] },
		});
	}
	records.push({
		type: "message",
		timestamp: "2026-05-20T00:00:09.000Z",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "## Verdict\n\nAll good.\n\n## Risks\n\n- none" }],
		},
	});
	const runDir = path.join(dir, "run-0");
	fs.mkdirSync(runDir, { recursive: true });
	fs.writeFileSync(
		path.join(runDir, "session.jsonl"),
		records.map((record) => JSON.stringify(record)).join("\n") + "\n",
		"utf-8",
	);
}

describe("dashboard detail pane redesign", () => {
	it("clips the prompt, groups run calls with a humanized hint, and keeps the final block", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), `detail-render-${randomUUID()}-`));
		try {
			writeRunRecord(dir, 15);
			const lines = buildRightLines(theme, { ownership: "foreign", run: makeRun("run-detail", dir) }, 60);
			const joined = lines.join("\n");

			// Prompt: preview + marker, never the whole wall of prose.
			const promptIdx = lines.findIndex((line) => line === "prompt:");
			assert.ok(promptIdx >= 0, `prompt label missing:\n${joined}`);
			const marker = lines.find((line) => /^… \(\d+ more lines\)$/.test(line));
			assert.ok(marker, `prompt clip marker missing:\n${joined}`);
			assert.doesNotMatch(joined, /final markdown block behavior/, "full prompt tail must be hidden");

			// Activity gist near the header (before the prompt/tool feed).
			const gistIdx = lines.findIndex((line) => /^15 tools · 300t · /.test(line));
			assert.ok(gistIdx >= 0 && gistIdx < promptIdx, `activity gist missing or misplaced:\n${joined}`);

			// 15 consecutive run calls collapse into ONE grouped line with a
			// humanized hint (first meaningful code line), no braces/escapes.
			const grouped = lines.filter((line) => line.startsWith("→ run"));
			assert.equal(grouped.length, 1, `expected one grouped run line:\n${joined}`);
			assert.match(grouped[0]!, /^→ run ×15 const lessons = await r\(/);
			assert.doesNotMatch(joined, /[{}]|\\n|\\"/, "no raw JSON braces or escapes in the pane");

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

	it("keeps short different-tool sequences one line each, humanized per tool", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), `detail-render-${randomUUID()}-`));
		try {
			const status: PersistedRunStatus = {
				runId: "run-mixed",
				mode: "single",
				state: "running",
				startedAt: 1000,
				lastUpdate: 2000,
				steps: [{ agent: "fixer", status: "running", startedAt: 1000 }],
			};
			fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify(status), "utf-8");
			const mk = (i: number, name: string, input: Record<string, unknown>) => ({
				type: "message",
				timestamp: new Date(Date.parse("2026-05-20T00:00:01.000Z") + i * 100).toISOString(),
				message: { role: "assistant", content: [{ type: "tool_use", id: `x${i}`, name, input }] },
			});
			const records = [
				{ type: "session", version: 3, id: "s2", timestamp: "2026-05-20T00:00:00.000Z", cwd: dir },
				mk(0, "bash", { command: "  \n  npm run typecheck && npm test\nmore" }),
				mk(1, "read", { path: "/abs/deep/file.ts" }),
				mk(2, "grep", { pattern: "TODO|FIXME", path: "/abs/src" }),
				mk(3, "edit", { path: "/abs/deep/file.ts", oldText: "a", newText: "b" }),
			];
			const runDir = path.join(dir, "run-0");
			fs.mkdirSync(runDir, { recursive: true });
			fs.writeFileSync(
				path.join(runDir, "session.jsonl"),
				records.map((record) => JSON.stringify(record)).join("\n") + "\n",
				"utf-8",
			);
			const lines = buildRightLines(theme, { ownership: "foreign", run: makeRun("run-mixed", dir) }, 80);
			const joined = lines.join("\n");
			assert.match(joined, /→ bash npm run typecheck && npm test/);
			assert.match(joined, /→ read \/abs\/deep\/file\.ts/);
			assert.match(joined, /→ grep TODO\|FIXME \/abs\/src/);
			assert.match(joined, /→ edit \/abs\/deep\/file\.ts/);
			assert.doesNotMatch(joined, /[{}]/, "no JSON braces in tool lines");
			assert.doesNotMatch(joined, /×\d/, "short mixed sequences are not grouped");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("humanizeToolArgs", () => {
	it("extracts the first meaningful line from code/command args", () => {
		assert.equal(humanizeToolArgs({ code: "\n\n  const x = 1;\nreturn x;" }), "const x = 1;");
		assert.equal(humanizeToolArgs({ command: "echo hi" }), "echo hi");
		assert.equal(humanizeToolArgs({ cmd: "ls -la" }), "ls -la");
	});
	it("prefers pattern+path for search tools and path for file tools", () => {
		assert.equal(humanizeToolArgs({ pattern: "foo", path: "/tmp/src" }), "foo /tmp/src");
		assert.equal(humanizeToolArgs({ path: "/tmp/a.ts", offset: 5 }), "/tmp/a.ts");
	});
	it("falls back to the first non-empty string value, else empty", () => {
		assert.equal(humanizeToolArgs({ action: "list" }), "list");
		assert.equal(humanizeToolArgs({ count: 3 }), "");
		assert.equal(humanizeToolArgs(undefined), "");
	});
});
