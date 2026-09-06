import assert from "node:assert/strict";
import * as fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { type AgentSessionEvent, initTheme } from "@earendil-works/pi-coding-agent";
import type { PersistedRunStatus } from "../../src/protocol/status-types.ts";
import type { AsyncRunSummary } from "../../src/state/async-status.ts";
import { readRunTranscript, RunMessageReader } from "../../src/state/run-transcript.ts";
import type { LiveDashboardSession } from "../../src/surfaces/dashboard-detail-renderer.ts";
import { sortLiveRuns } from "../../src/surfaces/dashboard-row-model.ts";
import { SubagentsStatusComponent } from "../../src/surfaces/subagents-status.ts";

initTheme();
const theme = { fg: (_name: string, text: string) => text, bg: (_name: string, text: string) => text } as never;

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function selectedLeftLine(component: SubagentsStatusComponent, width = 120): string {
	const lines = component.render(width).map(stripAnsi);
	const selected = lines.map((line) => line.split("│")[1] ?? "").find((cell) => cell.trimStart().startsWith(">"));
	assert.ok(selected !== undefined, `expected a selected row:\n${lines.join("\n")}`);
	return selected.trim();
}

function makeRun(id: string, asyncDir: string, startedAt: number, sessionId?: string): AsyncRunSummary {
	return {
		id,
		...(sessionId ? { rootSessionId: sessionId } : {}),
		asyncDir,
		state: "complete",
		mode: "single",
		startedAt,
		endedAt: startedAt + 1000,
		label: `label ${id}`,
		steps: [{ index: 0, agent: "fixer", status: "complete" }],
	};
}

function createComponent(
	runs: AsyncRunSummary[],
	options: {
		sessionId?: string;
		reader?: unknown;
		tui?: unknown;
		getLiveSessions?: (runId: string) => LiveDashboardSession[];
	} = {},
): SubagentsStatusComponent {
	return new SubagentsStatusComponent(
		(options.tui ?? { requestRender: () => {}, terminal: { rows: 32 } }) as never,
		theme,
		() => {},
		{
			listRunsForOverlay: () => ({ active: runs, recent: [] }),
			getOwnedRunViews: () => new Map(),
			rendererCatalog: { getToolDefinition: () => undefined },
			runMessageReader: (options.reader ?? new RunMessageReader()) as never,
			...(options.getLiveSessions ? { getLiveSessions: options.getLiveSessions } : {}),
			selectionSettleMs: 5,
			refreshMs: 60_000,
			...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
		},
	);
}

describe("dashboard selection restore across reopen", () => {
	const runsFor = (sessionId: string) => [
		makeRun("run-a", "/missing/a", 3000, sessionId),
		makeRun("run-b", "/missing/b", 2000, sessionId),
		makeRun("run-c", "/missing/c", 1000, sessionId),
	];

	it("reopening in the same host session lands on the last selected row", () => {
		const runs = runsFor("sess-restore-same");
		const first = createComponent(runs, { sessionId: "sess-restore-same" });
		try {
			first.handleInput("j");
			first.handleInput("j");
			assert.match(selectedLeftLine(first), /label run-c/);
		} finally {
			first.dispose();
		}
		const reopened = createComponent(runs, { sessionId: "sess-restore-same" });
		try {
			assert.match(selectedLeftLine(reopened), /label run-c/, "reopen restores the last selection");
			reopened.handleInput("k");
			assert.match(selectedLeftLine(reopened), /label run-b/, "navigation continues from the restored row");
		} finally {
			reopened.dispose();
		}
	});

	it("does not leak the remembered selection into a different host session", () => {
		const first = createComponent(runsFor("sess-leak-a"), { sessionId: "sess-leak-a" });
		try {
			first.handleInput("G");
			assert.match(selectedLeftLine(first), /label run-c/);
		} finally {
			first.dispose();
		}
		const other = createComponent(runsFor("sess-leak-b"), { sessionId: "sess-leak-b" });
		try {
			assert.match(selectedLeftLine(other), /label run-a/, "a different session starts from the top");
		} finally {
			other.dispose();
		}
	});

	it("falls back to the first row when the remembered row is gone", () => {
		const runs = runsFor("sess-restore-gone");
		const first = createComponent(runs, { sessionId: "sess-restore-gone" });
		try {
			first.handleInput("G");
		} finally {
			first.dispose();
		}
		const reopened = createComponent(runs.slice(0, 2), { sessionId: "sess-restore-gone" });
		try {
			assert.match(selectedLeftLine(reopened), /label run-a/);
			reopened.handleInput("j");
			assert.match(selectedLeftLine(reopened), /label run-b/);
		} finally {
			reopened.dispose();
		}
		const empty = createComponent([], { sessionId: "sess-restore-gone" });
		try {
			assert.match(stripAnsi(empty.render(120).join("\n")), /No subagent runs/);
		} finally {
			empty.dispose();
		}
	});
});

describe("nested sibling ordering", () => {
	function mk(
		id: string,
		parent: string | undefined,
		state: AsyncRunSummary["state"],
		startedAt: number,
		extra: Partial<AsyncRunSummary> = {},
	): AsyncRunSummary {
		return {
			id,
			mode: "single",
			state,
			startedAt,
			...(parent ? { parentRunId: parent } : {}),
			steps: [],
			...extra,
		};
	}
	const order = (runs: AsyncRunSummary[]) =>
		sortLiveRuns([], runs)
			.map((run) => run.run.id)
			.join(",");

	it("keeps grandchildren in dispatch order across activity, terminal state and input order changes", () => {
		const parent = mk("p", undefined, "running", 1000);
		const child = mk("c", "p", "running", 1100);
		const g1 = mk("g1", "c", "running", 1200);
		const g2 = mk("g2", "c", "running", 1200);
		const g3 = mk("g3", "c", "running", 1200);
		const before = order([parent, child, g1, g2, g3]);
		assert.equal(before, "p,c,g1,g2,g3");
		const g2Done = { ...g2, state: "complete" as const, endedAt: 1300, lastUpdate: 1300 };
		assert.equal(order([parent, child, g1, g2Done, g3]), before, "a completed sibling stays in place");
		assert.equal(
			order([
				parent,
				child,
				{ ...g1, displayState: "tool_running" },
				g2Done,
				{ ...g3, displayState: "needs_attention" },
			]),
			before,
			"activity states do not reorder siblings",
		);
		assert.equal(order([parent, child, g3, g1, g2]), before, "registry read order does not reorder siblings");
		assert.equal(
			order([
				parent,
				child,
				mk("g3", "c", "running", 1250),
				mk("g1", "c", "running", 1210),
				mk("g2", "c", "running", 1230),
			]),
			"p,c,g1,g2,g3",
			"distinct start times order by dispatch time",
		);
	});

	it("preserves top-level priority ordering (needs attention first, then newest)", () => {
		const a = mk("a", undefined, "running", 1000);
		const b = mk("b", undefined, "running", 2000);
		const c = mk("c", undefined, "running", 1500, { displayState: "needs_attention" });
		assert.equal(order([a, b, c]), "c,b,a");
		assert.equal(
			order([mk("a", undefined, "complete", 1000, { endedAt: 5000 }), mk("b", undefined, "running", 2000)]),
			"b,a",
		);
	});
});

function writeLargeRun(dir: string, runId: string, toolCalls: number): void {
	const status: PersistedRunStatus = {
		runId,
		mode: "single",
		state: "complete",
		startedAt: 1000,
		endedAt: 900000,
		lastUpdate: 900000,
		steps: [{ agent: "fixer", status: "complete", startedAt: 1000, endedAt: 900000, durationMs: 899000 }],
	};
	fs.mkdirSync(path.join(dir, "run-0"), { recursive: true });
	fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify(status));
	const records: string[] = [
		JSON.stringify({ type: "session", version: 3, id: runId, timestamp: "2026-05-20T00:00:00.000Z", cwd: dir }),
		JSON.stringify({
			type: "message",
			timestamp: "2026-05-20T00:00:00.050Z",
			message: { role: "user", content: [{ type: "text", text: `prompt for ${runId}` }], timestamp: 1 },
		}),
	];
	const payload = "x".repeat(1500);
	for (let i = 0; i < toolCalls; i++) {
		const ts = new Date(1000 + i * 100).toISOString();
		records.push(
			JSON.stringify({
				type: "message",
				timestamp: ts,
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: `Looking at file ${i}` },
						{ type: "toolCall", id: `t${i}`, name: "read", arguments: { path: `/abs/file${i}.ts` } },
					],
					timestamp: 1000 + i * 100,
				},
			}),
			JSON.stringify({
				type: "message",
				timestamp: ts,
				message: {
					role: "toolResult",
					toolCallId: `t${i}`,
					toolName: "read",
					content: [{ type: "text", text: payload }],
					isError: false,
					timestamp: 1000 + i * 100 + 50,
				},
			}),
		);
	}
	records.push(
		JSON.stringify({
			type: "message",
			timestamp: "2026-05-20T00:10:00.000Z",
			message: { role: "assistant", content: [{ type: "text", text: `## Done ${runId}` }], timestamp: 900000 },
		}),
	);
	fs.writeFileSync(path.join(dir, "run-0", "session.jsonl"), `${records.join("\n")}\n`);
}

interface FsSpy {
	sessionReads: number;
	bytes: number;
	reset(): void;
	restore(): void;
}

/** Count reads/opens of the heavy session transcript files through the CJS fs
 * binding (readFileSync for the transcript parser, openSync for the host
 * SessionManager); syncBuiltinESMExports propagates the patch to ESM consumers. */
function spyOnSessionReads(): FsSpy {
	const realFs = createRequire(import.meta.url)("node:fs") as typeof fs;
	const original = realFs.readFileSync;
	const originalOpen = realFs.openSync;
	const spy: FsSpy = {
		sessionReads: 0,
		bytes: 0,
		reset() {
			spy.sessionReads = 0;
			spy.bytes = 0;
		},
		restore() {
			realFs.readFileSync = original;
			realFs.openSync = originalOpen;
			syncBuiltinESMExports();
		},
	};
	const patched: typeof fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
		const result = original(...args);
		if (String(args[0]).endsWith("session.jsonl")) {
			spy.sessionReads++;
			spy.bytes += typeof result === "string" ? result.length : result.byteLength;
		}
		return result;
	}) as typeof fs.readFileSync;
	realFs.readFileSync = patched;
	realFs.openSync = ((...args: Parameters<typeof fs.openSync>) => {
		if (String(args[0]).endsWith("session.jsonl")) spy.sessionReads++;
		return originalOpen(...args);
	}) as typeof fs.openSync;
	syncBuiltinESMExports();
	return spy;
}

const tmpRoots: string[] = [];
afterEach(() => {
	for (const root of tmpRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("rapid selection changes over large transcripts", () => {
	it("disk-backed: intermediate rows never read or parse full transcripts; only the settled row does", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-selection-perf-"));
		tmpRoots.push(root);
		const count = 12;
		const runs: AsyncRunSummary[] = [];
		for (let i = 0; i < count; i++) {
			const dir = path.join(root, `run-${String(i).padStart(2, "0")}`);
			writeLargeRun(dir, `run-${i}`, 1500);
			runs.push(makeRun(`run-${i}`, dir, 1000 + (count - i)));
		}
		// Reference cost: what one crossed row used to pay before the fix — a full
		// synchronous parse of its transcript (both the compact event parser used by
		// the old tool counter and the typed-message reader used on settle).
		const parseStart = performance.now();
		readRunTranscript(runs[0]!.asyncDir!);
		new RunMessageReader().read(runs[0]!.asyncDir!);
		const singleParseMs = performance.now() - parseStart;

		const reader = new RunMessageReader();
		const readCalls: string[] = [];
		const originalRead = reader.read.bind(reader);
		reader.read = (dir: string) => {
			readCalls.push(dir);
			return originalRead(dir);
		};
		let renders = 0;
		const spy = spyOnSessionReads();
		const component = createComponent(runs, {
			reader,
			tui: { requestRender: () => renders++, terminal: { rows: 40 } },
		});
		try {
			component.render(160);
			await delay(15);
			component.render(160);
			spy.reset();
			readCalls.length = 0;
			const stepTimes: number[] = [];
			for (let i = 1; i < count; i++) {
				const start = performance.now();
				component.handleInput("j");
				const painted = stripAnsi(component.render(160).join("\n"));
				stepTimes.push(performance.now() - start);
				assert.match(painted, new RegExp(`> .*label run-${i}\\b`), "selection paints immediately");
				assert.match(painted, /Loading transcript/, "intermediate row shows the loading placeholder");
			}
			const navSessionReads = spy.sessionReads;
			const navReadCalls = [...readCalls];
			await delay(20);
			const settledSessionReads = spy.sessionReads;
			const settled = stripAnsi(component.render(160).join("\n"));
			const avgStepMs = stepTimes.reduce((sum, ms) => sum + ms, 0) / stepTimes.length;
			// Median: the first step after a settled row also pays the host overlay's
			// synchronous detail re-render of the previously promoted transcript at the
			// new width (text wrapping, no IO); every following step is ~1ms.
			const medianStepMs = [...stepTimes].sort((a, b) => a - b)[Math.floor(stepTimes.length / 2)]!;
			const maxStepMs = Math.max(...stepTimes);
			console.log(
				JSON.stringify({
					singleParseMs: Math.round(singleParseMs * 10) / 10,
					avgStepMs: Math.round(avgStepMs * 10) / 10,
					medianStepMs: Math.round(medianStepMs * 10) / 10,
					maxStepMs: Math.round(maxStepMs * 10) / 10,
					navSessionReads,
					navBytes: spy.bytes,
					settledSessionReads,
				}),
			);
			assert.equal(navSessionReads, 0, "no full transcript read while the selection is moving");
			assert.deepEqual(navReadCalls, [], "no reader.read while the selection is moving");
			assert.deepEqual(readCalls, [runs[count - 1]!.asyncDir], "only the settled selection loads its transcript");
			assert.ok(settledSessionReads > 0, "the settled selection opens its transcript");
			assert.match(settled, new RegExp(`Done run-${count - 1}`), "settled row promotes to the full transcript");
			assert.match(settled, /1500 tools/, "tool count comes from the settled transcript");
			assert.ok(renders >= 1, "settle requests a repaint");
			assert.ok(
				medianStepMs < singleParseMs,
				`a typical selection step (${medianStepMs.toFixed(1)}ms) must cost less than one full transcript parse (${singleParseMs.toFixed(1)}ms)`,
			);
		} finally {
			component.dispose();
			spy.restore();
		}
	});

	it("disk-backed: a stale settle cannot promote a row the user already left, and close drops pending work", async () => {
		const loaded = new Map<string, Array<{ messages: LiveDashboardSession["messages"] }>>();
		const reads: string[] = [];
		const reader = {
			readPreview: (dir: string) => [
				{ messages: [{ role: "user" as const, content: `preview ${dir}`, timestamp: 1 }] },
			],
			peek: (dir: string) => loaded.get(dir),
			read: (dir: string) => {
				reads.push(dir);
				const sessions = [{ messages: [{ role: "user" as const, content: `full ${dir}`, timestamp: 2 }] }];
				loaded.set(dir, sessions);
				return sessions;
			},
		};
		const runs = [
			makeRun("s-a", "/preview/a", 3000),
			makeRun("s-b", "/preview/b", 2000),
			makeRun("s-c", "/preview/c", 1000),
		];
		const component = createComponent(runs, { reader });
		try {
			component.render(120);
			await delay(15);
			assert.deepEqual(reads, ["/preview/a"]);
			component.handleInput("j");
			component.render(120);
			await delay(3);
			component.handleInput("j");
			component.render(120);
			await delay(15);
			assert.deepEqual(reads, ["/preview/a", "/preview/c"], "the abandoned middle row never loads");
			const painted = stripAnsi(component.render(120).join("\n"));
			assert.match(painted, /full \/preview\/c/);
			assert.doesNotMatch(painted, /full \/preview\/b/);
			component.handleInput("k");
			component.render(120);
		} finally {
			component.dispose();
		}
		await delay(15);
		assert.deepEqual(reads, ["/preview/a", "/preview/c"], "a pending settle is dropped on close");
	});

	it("live: intermediate rows render only the bounded tail and never settle", async () => {
		const count = 8;
		const runs: AsyncRunSummary[] = [];
		const sessions = new Map<string, LiveDashboardSession>();
		const messageReads = new Map<string, number>();
		for (let i = 0; i < count; i++) {
			const id = `live-${i}`;
			runs.push({ ...makeRun(id, `/missing/${id}`, 1000 + (count - i)), state: "running" });
			const messages: LiveDashboardSession["messages"] = [];
			for (let m = 0; m < 200; m++) messages.push({ role: "user", content: `msg ${m} of ${id}`, timestamp: m });
			sessions.set(id, {
				get messages() {
					messageReads.set(id, (messageReads.get(id) ?? 0) + 1);
					return messages;
				},
				subscribe: (_listener: (event?: AgentSessionEvent) => void) => () => {},
			});
		}
		const component = createComponent(runs, { getLiveSessions: (runId) => [sessions.get(runId)!] });
		try {
			component.render(120);
			await delay(15);
			component.render(120);
			messageReads.clear();
			for (let i = 1; i < count; i++) {
				component.handleInput("j");
				const rendered = component.render(120);
				const painted = stripAnsi(rendered.join("\n"));
				assert.match(painted, new RegExp(`> .*label live-${i}\\b`), "selection paints immediately");
				assert.match(
					painted,
					new RegExp(`msg 199 of live-${i}`),
					"tail of the live transcript paints immediately",
				);
				// Scroll the detail pane to the top: the preview tail must not reach the
				// start of the transcript, and the primary selection is untouched.
				component.handleInput("\t");
				component.handleInput("g");
				const top = stripAnsi(component.render(120).join("\n"));
				assert.doesNotMatch(
					top,
					new RegExp(`msg 0 of live-${i}\\b`),
					"intermediate row shows only the bounded tail",
				);
				component.handleInput("\t");
			}
			for (let i = 1; i < count - 1; i++) {
				assert.ok(
					(messageReads.get(`live-${i}`) ?? 0) <= 2,
					`crossed live row live-${i} reads its messages at most twice`,
				);
			}
			await delay(20);
			component.handleInput("\t");
			component.handleInput("g");
			const settled = stripAnsi(component.render(120).join("\n"));
			assert.match(
				settled,
				new RegExp(`msg 0 of live-${count - 1}\\b`),
				"settled live row promotes to the full transcript",
			);
		} finally {
			component.dispose();
		}
	});
});
