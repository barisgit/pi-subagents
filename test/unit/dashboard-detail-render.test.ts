import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, it } from "node:test";
import { initTheme, type AgentSessionEvent, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AsyncRunSummary } from "../../src/state/async-status.ts";
import {
	buildRightLines,
	type LiveDashboardSession,
	LiveSessionRenderCache,
	LiveToolComponentStore,
	selectToolArg,
} from "../../src/surfaces/dashboard-detail-renderer.ts";
import {
	type LiveToolProgress,
	LiveSessionDirectory,
	publishLiveSession,
} from "../../src/shared/live-session-relay.ts";
import {
	buildSelectedRunStatusBox,
	type LiveRun,
	SubagentsStatusComponent,
} from "../../src/surfaces/subagents-status.ts";
import { Text, visibleWidth } from "@earendil-works/pi-tui";
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
	it("falls back to the persisted transcript when retained live sessions render no lines", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), `detail-empty-live-${randomUUID()}-`));
		try {
			writeStatus(dir, "run-empty-live");
			writeSession(dir, [user("2026-05-20T00:00:00.000Z", [{ type: "text", text: "Persisted fallback text" }])]);
			const run: LiveRun = { ownership: "live", run: makeRun("run-empty-live", dir) };
			const output = stripAnsi(
				buildRightLines(theme, run, 80, [], {
					sessions: [{ messages: [], subscribe: () => () => {} }],
					tui: { requestRender: () => {} } as never,
				}).join("\n"),
			);

			assert.match(output, /Persisted fallback text/);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("defers full persisted transcript reads until selection settles and cancels crossed rows", async () => {
		const runA = makeRun("run-deferred-a", "/preview/a");
		const runB = makeRun("run-deferred-b", "/preview/b");
		const loaded = new Map<string, Array<{ messages: LiveDashboardSession["messages"] }>>();
		const reads: string[] = [];
		const reader = {
			readPreview: (dir: string) =>
				dir === "/preview/a" ? [{ messages: [{ role: "user", content: "preview A", timestamp: 1 }] }] : [],
			peek: (dir: string) => loaded.get(dir),
			read: (dir: string) => {
				reads.push(dir);
				const sessions = [{ messages: [{ role: "user" as const, content: `full ${dir}`, timestamp: 2 }] }];
				loaded.set(dir, sessions);
				return sessions;
			},
		};
		const component = new SubagentsStatusComponent(
			{ requestRender: () => {}, terminal: { rows: 32 } } as never,
			theme,
			() => {},
			{
				listRunsForOverlay: () => ({ active: [runA, runB], recent: [] }),
				getOwnedRunViews: () => new Map(),
				rendererCatalog: { getToolDefinition: () => undefined },
				runMessageReader: reader as never,
				selectionSettleMs: 5,
				refreshMs: 60000,
			},
		);

		try {
			assert.match(stripAnsi(component.render(120).join("\n")), /preview A/);
			assert.deepEqual(reads, []);
			component.handleInput("j");
			const crossed = stripAnsi(component.render(120).join("\n"));
			assert.match(crossed, /Loading transcript/);
			assert.deepEqual(reads, []);
			await delay(15);
			assert.deepEqual(reads, ["/preview/b"]);
			assert.match(stripAnsi(component.render(120).join("\n")), /full \/preview\/b/);
			assert.doesNotMatch(stripAnsi(component.render(120).join("\n")), /full \/preview\/a/);
		} finally {
			component.dispose();
		}

		const cancelled = new SubagentsStatusComponent(
			{ requestRender: () => {}, terminal: { rows: 32 } } as never,
			theme,
			() => {},
			{
				listRunsForOverlay: () => ({ active: [runA], recent: [] }),
				getOwnedRunViews: () => new Map(),
				rendererCatalog: { getToolDefinition: () => undefined },
				runMessageReader: reader as never,
				selectionSettleMs: 5,
				refreshMs: 60000,
			},
		);
		cancelled.dispose();
		await delay(15);
		assert.deepEqual(reads, ["/preview/b"], "dispose clears a pending settled-selection load");
	});

	it("crossing twenty preview rows loads only the final selected transcript", async () => {
		const runs = Array.from({ length: 20 }, (_, index) => makeRun(`run-preview-${index}`, `/preview/${index}`));
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
		const component = new SubagentsStatusComponent(
			{ requestRender: () => {}, terminal: { rows: 32 } } as never,
			theme,
			() => {},
			{
				listRunsForOverlay: () => ({ active: runs, recent: [] }),
				getOwnedRunViews: () => new Map(),
				rendererCatalog: { getToolDefinition: () => undefined },
				runMessageReader: reader as never,
				selectionSettleMs: 5,
				refreshMs: 60_000,
			},
		);

		try {
			component.render(120);
			for (let index = 1; index < runs.length; index++) {
				component.handleInput("j");
				assert.match(stripAnsi(component.render(120).join("\n")), new RegExp(`preview \\/preview\\/${index}`));
			}
			assert.deepEqual(reads, [], "crossed rows remain preview-only");
			await delay(15);
			assert.deepEqual(reads, ["/preview/19"]);
			assert.match(stripAnsi(component.render(120).join("\n")), /full \/preview\/19/);
		} finally {
			component.dispose();
		}
	});

	it("renders retained live sessions and refreshes when the selected session updates", () => {
		const run = makeRun("run-live", "/missing/run-live");
		let stableContentReads = 0;
		const stableMessage: LiveDashboardSession["messages"][number] = {
			role: "user",
			get content() {
				stableContentReads++;
				return "Live prompt text";
			},
			timestamp: 1,
		};
		const messages: LiveDashboardSession["messages"] = [stableMessage];
		let listener: ((event?: AgentSessionEvent) => void) | undefined;
		let transcriptReads = 0;
		const session: LiveDashboardSession = {
			get messages() {
				transcriptReads++;
				return messages;
			},
			subscribe(next) {
				listener = next;
				return () => {
					listener = undefined;
				};
			},
		};
		let renders = 0;
		const tui = { requestRender: () => renders++, terminal: { rows: 32 } } as never;
		const component = new SubagentsStatusComponent(tui, theme, () => {}, {
			listRunsForOverlay: () => ({ active: [run], recent: [] }),
			getOwnedRunViews: () => new Map([[run.id, run]]),
			getLiveSessions: () => [session],
			refreshMs: 60000,
		});

		try {
			assert.match(stripAnsi(component.render(120).join("\n")), /Live prompt text/);
			component.render(120);
			assert.equal(transcriptReads, 1, "an unchanged repaint reuses the rendered transcript");
			const stableReadsAfterInitialRender = stableContentReads;
			messages.push({ role: "user", content: "Streamed update text", timestamp: 2 });
			listener?.({ type: "message_start", message: messages[1]! });
			assert.equal(renders, 1);
			assert.match(stripAnsi(component.render(120).join("\n")), /Streamed update text/);
			assert.equal(
				stableContentReads,
				stableReadsAfterInitialRender,
				"a tail update reuses previously rendered history",
			);
		} finally {
			component.dispose();
		}
		assert.equal(listener, undefined);
	});

	it("keeps direct-parent partial tool progress live across selection and display rebuilds", () => {
		const run = makeRun("run-live-tool-progress", "/missing/run-live-tool-progress");
		const otherRun = makeRun("run-other-live", "/missing/run-other-live");
		// Pi completes the assistant tool-call message before emitting execution events,
		// so start/update state always has a pending tool card to attach to here.
		const messages: LiveDashboardSession["messages"] = [
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "call-progress", name: "progress_tool", arguments: {} }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: 1,
			},
		];
		let resultRenders = 0;
		const rendererStates: object[] = [];
		const toolDefinition: ToolDefinition = {
			name: "progress_tool",
			label: "Progress tool",
			description: "Test partial rendering",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "unused" }], details: undefined }),
			renderShell: "self",
			renderCall: (_args, _theme, context) => {
				rendererStates.push(context.state);
				return new Text(context.executionStarted ? "running progress call" : "pending progress call", 0, 0);
			},
			renderResult: (result, options, _theme, context) => {
				resultRenders++;
				rendererStates.push(context.state);
				const details = typeof result.details === "object" && result.details !== null ? result.details : {};
				const marker = "marker" in details && typeof details.marker === "string" ? details.marker : "missing";
				const text = result.content.find((content) => content.type === "text")?.text ?? "";
				return new Text(`${options.isPartial ? "partial" : "final"} ${marker} ${text}`, 0, 0);
			},
		};
		const listeners = new Set<(event: AgentSessionEvent) => void>();
		const session: LiveDashboardSession = {
			messages,
			getToolDefinition: () => toolDefinition,
			subscribe(next) {
				listeners.add(next);
				return () => listeners.delete(next);
			},
		};
		const emit = (event: AgentSessionEvent) => {
			for (const listener of listeners) listener(event);
		};
		const otherSession: LiveDashboardSession = {
			messages: [{ role: "user", content: "Other live run", timestamp: 1 }],
			subscribe: () => () => {},
		};
		const liveToolComponents = new LiveToolComponentStore();
		const directory = new LiveSessionDirectory(liveToolComponents);
		const unpublish = publishLiveSession({ runId: run.id, stepIndex: 0, session: session as never });
		let renderRequests = 0;
		let component = new SubagentsStatusComponent(
			{ requestRender: () => renderRequests++, terminal: { rows: 32 } } as never,
			theme,
			() => {},
			{
				listRunsForOverlay: () => ({ active: [run, otherRun], recent: [] }),
				getOwnedRunViews: () => new Map(),
				getLiveSessions: (runId) => (runId === run.id ? [session] : [otherSession]),
				getLiveToolProgress: (liveSession) => directory.toolProgress(liveSession as never),
				liveToolComponents,
				refreshMs: 60000,
			},
		);
		const render = () => stripAnsi(component.render(120).join("\n"));

		try {
			assert.match(render(), /pending progress call/);
			const rendersBeforeClosedFinal = resultRenders;
			emit({
				type: "tool_execution_start",
				toolCallId: "call-progress",
				toolName: "progress_tool",
				args: {},
			});
			assert.match(render(), /running progress call/);
			emit({
				type: "tool_execution_update",
				toolCallId: "call-progress",
				toolName: "progress_tool",
				args: {},
				partialResult: {
					content: [
						{ type: "text", text: "first text" },
						{ type: "image", data: "not-an-image", mimeType: "image/png" },
					],
					details: { marker: "first" },
				},
			});
			const firstPartial = render();
			assert.match(firstPartial, /partial first first text/);
			assert.doesNotMatch(firstPartial, /not-an-image/);
			emit({
				type: "tool_execution_update",
				toolCallId: "call-progress",
				toolName: "progress_tool",
				args: {},
				partialResult: { content: [{ type: "text", text: "second text" }], details: { marker: "second" } },
			});
			assert.match(render(), /partial second second text/);
			const rendersAfterUpdate = resultRenders;
			render();
			assert.equal(resultRenders, rendersAfterUpdate, "an ordinary repaint reuses the partial tail");
			assert.equal(renderRequests, 3);

			component.handleInput("j");
			assert.match(render(), /Other live run/);
			const requestsWhileBSelected = renderRequests;
			emit({
				type: "tool_execution_update",
				toolCallId: "call-progress",
				toolName: "progress_tool",
				args: {},
				partialResult: { content: [{ type: "text", text: "late text" }], details: { marker: "late" } },
			});
			assert.equal(renderRequests, requestsWhileBSelected, "unselected updates are retained without repainting");
			component.handleInput("k");
			const reselected = render();
			assert.match(reselected, /partial late late text/);
			assert.doesNotMatch(reselected, /pending progress call/);
			component.handleInput("\x0f");
			assert.match(render(), /partial late late text/);
			assert.match(stripAnsi(component.render(100).join("\n")), /partial late late text/);

			component.dispose();
			const rendersBeforeClosedUpdate = resultRenders;
			emit({
				type: "tool_execution_update",
				toolCallId: "call-progress",
				toolName: "progress_tool",
				args: {},
				partialResult: { content: [{ type: "text", text: "closed text" }], details: { marker: "closed" } },
			});
			assert.deepEqual(directory.toolProgress(session as never).get("call-progress")?.partialResult?.details, {
				marker: "closed",
			});
			assert.ok(resultRenders > rendersBeforeClosedUpdate, "closed updates reach the retained component");
			assert.ok(rendererStates.length > 1);
			assert.ok(
				rendererStates.every((state) => state === rendererStates[0]),
				"closed updates keep renderer state",
			);

			messages.push({
				role: "toolResult",
				toolCallId: "call-progress",
				toolName: "progress_tool",
				content: [{ type: "text", text: "final text" }],
				details: { marker: "persisted" },
				isError: false,
				timestamp: 2,
			});
			emit({
				type: "tool_execution_end",
				toolCallId: "call-progress",
				toolName: "progress_tool",
				result: { content: [{ type: "text", text: "final text" }], details: { marker: "persisted" } },
				isError: false,
			});
			assert.ok(resultRenders > rendersBeforeClosedFinal, "closed completion finalizes the component");
			assert.ok(
				rendererStates.every((state) => state === rendererStates[0]),
				"closed finalization uses renderer state",
			);
			component = new SubagentsStatusComponent(
				{ requestRender: () => renderRequests++, terminal: { rows: 32 } } as never,
				theme,
				() => {},
				{
					listRunsForOverlay: () => ({ active: [run, otherRun], recent: [] }),
					getOwnedRunViews: () => new Map(),
					getLiveSessions: (runId) => (runId === run.id ? [session] : [otherSession]),
					getLiveToolProgress: (liveSession) => directory.toolProgress(liveSession as never),
					liveToolComponents,
					refreshMs: 60000,
				},
			);
			const finalOutput = render();
			assert.match(finalOutput, /final persisted final text/);
			assert.doesNotMatch(finalOutput, /partial second/);
		} finally {
			component.dispose();
			unpublish();
			directory.dispose();
			liveToolComponents.dispose();
		}
	});

	it("reconciles listed live-session subscriptions without listener churn", () => {
		const runA = makeRun("run-subscription-a", "/missing/run-subscription-a");
		const runB = makeRun("run-subscription-b", "/missing/run-subscription-b");
		const toolDefinition: ToolDefinition = {
			name: "delegation",
			label: "Delegation",
			description: "Test open delegation rendering",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "unused" }], details: undefined }),
			renderCall: (_args, _theme, context) =>
				new Text(context.executionStarted ? "delegation running" : "delegation pending", 0, 0),
			renderResult: (result) =>
				new Text(result.content.find((content) => content.type === "text")?.text ?? "", 0, 0),
		};
		const listeners = new Map<string, ((event?: AgentSessionEvent) => void) | undefined>();
		const subscribeCounts = new Map<string, number>();
		const unsubscribeCounts = new Map<string, number>();
		const session = (name: string, messages: LiveDashboardSession["messages"]): LiveDashboardSession => ({
			messages,
			getToolDefinition: () => toolDefinition,
			subscribe(listener) {
				subscribeCounts.set(name, (subscribeCounts.get(name) ?? 0) + 1);
				listeners.set(name, listener);
				return () => {
					unsubscribeCounts.set(name, (unsubscribeCounts.get(name) ?? 0) + 1);
				};
			},
		});
		const sessionA = session("a", [
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "same-call", name: "delegation", arguments: {} }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: 1,
			},
		]);
		const sessionB = session("b", [{ role: "user", content: "Run B transcript", timestamp: 1 }]);
		const progressA = new Map<string, LiveToolProgress>();
		let runs = [runA, runB];
		let throwForA = false;
		let renders = 0;
		const component = new SubagentsStatusComponent(
			{ requestRender: () => renders++, terminal: { rows: 32 } } as never,
			theme,
			() => {},
			{
				listRunsForOverlay: () => ({ active: runs, recent: [] }),
				getOwnedRunViews: () => new Map(),
				getLiveSessions: (runId) => {
					if (runId === runA.id && throwForA) throw new Error("transient lookup miss");
					return runId === runA.id ? [sessionA] : [sessionB];
				},
				getLiveToolProgress: (liveSession) => (liveSession === sessionA ? progressA : new Map()),
				refreshMs: 60000,
			},
		);
		const render = () => stripAnsi(component.render(120).join("\n"));

		try {
			progressA.set("same-call", { startedAt: Date.now() });
			progressA.set("same-call", {
				startedAt: Date.now(),
				partialResult: {
					content: [{ type: "text", text: "nested child still running" }],
					details: undefined,
					isError: false,
				},
			});
			listeners.get("a")?.({
				type: "tool_execution_start",
				toolCallId: "same-call",
				toolName: "delegation",
				args: {},
			});
			listeners.get("a")?.({
				type: "tool_execution_update",
				toolCallId: "same-call",
				toolName: "delegation",
				args: {},
				partialResult: { content: [{ type: "text", text: "nested child still running" }] },
			});
			assert.match(render(), /nested child still running/);
			component.handleInput("j");
			component.setShowAllSessions(true);
			throwForA = true;
			component.setShowAllSessions(false);
			assert.deepEqual(
				[...subscribeCounts.entries()],
				[
					["a", 1],
					["b", 1],
				],
			);
			assert.equal(unsubscribeCounts.size, 0);
			component.handleInput("k");
			assert.match(render(), /nested child still running/);

			const staleAListener = listeners.get("a");
			runs = [runB];
			component.setShowAllSessions(true);
			assert.equal(unsubscribeCounts.get("a"), 1);
			assert.equal(unsubscribeCounts.get("b"), undefined);
			const rendersAfterRemoval = renders;
			staleAListener?.({
				type: "tool_execution_update",
				toolCallId: "same-call",
				toolName: "delegation",
				args: {},
				partialResult: { content: [{ type: "text", text: "ignored late update" }] },
			});
			assert.equal(renders, rendersAfterRemoval);
		} finally {
			component.dispose();
		}
		assert.equal(unsubscribeCounts.get("b"), 1);
	});

	it("returns a foreign run to historical native rendering after its relayed session disappears", () => {
		const run = makeRun("run-relay-fallback", "/missing/run-relay-fallback");
		const liveSession: LiveDashboardSession = {
			messages: [{ role: "user", content: "live relayed transcript", timestamp: 1 }],
			subscribe: () => () => {},
		};
		const historicalSession = {
			messages: [{ role: "user", content: "historical disk transcript", timestamp: 1 }],
		};
		let published = true;
		const component = new SubagentsStatusComponent(
			{ requestRender: () => {}, terminal: { rows: 32 } } as never,
			theme,
			() => {},
			{
				listRunsForOverlay: () => ({ active: [run], recent: [] }),
				getOwnedRunViews: () => new Map(),
				getLiveSessions: () => (published ? [liveSession] : []),
				rendererCatalog: { getToolDefinition: () => undefined },
				runMessageReader: {
					peek: () => [historicalSession],
					readPreview: () => [],
					read: () => [historicalSession],
				} as never,
				refreshMs: 60000,
			},
		);

		try {
			assert.match(stripAnsi(component.render(120).join("\n")), /live relayed transcript/);
			published = false;
			component.setShowAllSessions(true);
			const historical = stripAnsi(component.render(120).join("\n"));
			assert.match(historical, /historical disk transcript/);
			assert.doesNotMatch(historical, /live relayed transcript/);
		} finally {
			component.dispose();
		}
	});

	it("reflows cached live messages when the detail width changes", () => {
		const run: LiveRun = { ownership: "live", run: makeRun("run-width", "/missing/run-width") };
		const session: LiveDashboardSession = {
			messages: [
				{
					role: "user",
					content:
						"A long live message that must wrap differently when the dashboard detail pane becomes narrow.",
					timestamp: 1,
				},
			],
			subscribe: () => () => {},
		};
		const cache = new LiveSessionRenderCache();
		const renderAt = (width: number) =>
			buildRightLines(theme, run, width, [], {
				sessions: [session],
				tui: { requestRender: () => {} } as never,
				cache,
			});

		const wide = renderAt(80);
		const narrow = renderAt(30);

		assert.ok(narrow.length > wide.length, "a width change rebuilds and reflows cached message components");
	});

	it("repaints an async custom tool preview after its promise settles", async () => {
		const run: LiveRun = { ownership: "live", run: makeRun("run-async-preview", "/missing/async-preview") };
		let settlePreview = () => {};
		const previewReady = new Promise<void>((resolve) => {
			settlePreview = resolve;
		});
		let previewScheduled = false;
		const toolDefinition: ToolDefinition = {
			name: "async_preview_tool",
			label: "Async preview tool",
			description: "Test async preview rendering",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "unused" }], details: undefined }),
			renderShell: "self",
			renderCall: (_args, _theme, context) => {
				const component =
					context.lastComponent instanceof Text ? context.lastComponent : new Text("pending preview", 0, 0);
				if (!previewScheduled) {
					previewScheduled = true;
					void previewReady.then(() => {
						component.setText("settled preview");
						context.invalidate();
					});
				}
				return component;
			},
		};
		const session: LiveDashboardSession = {
			messages: [
				{
					role: "assistant",
					content: [
						{ type: "toolCall", id: "call-async-preview", name: "async_preview_tool", arguments: {} },
					],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "test",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: 1,
				},
			],
			getToolDefinition: () => toolDefinition,
			subscribe: () => () => {},
		};
		const cache = new LiveSessionRenderCache();
		let renderRequests = 0;
		const render = () =>
			stripAnsi(
				buildRightLines(theme, run, 100, [], {
					sessions: [session],
					tui: { requestRender: () => renderRequests++ } as never,
					cache,
				}).join("\n"),
			);

		assert.match(render(), /pending preview/);
		settlePreview();
		await previewReady;
		assert.equal(renderRequests, 1, "the settled preview requests a dashboard repaint without a session event");
		assert.match(render(), /settled preview/);
	});

	it("preserves builtin bash elapsed time and clears its interval on completion", () => {
		const originalDateNow = Date.now;
		const originalSetInterval = globalThis.setInterval;
		const originalClearInterval = globalThis.clearInterval;
		let now = 1000;
		let nextTimerId = 1;
		const activeTimers = new Set<number>();
		Date.now = () => now;
		Object.defineProperty(globalThis, "setInterval", {
			configurable: true,
			value: () => {
				const id = nextTimerId++;
				activeTimers.add(id);
				return id;
			},
		});
		Object.defineProperty(globalThis, "clearInterval", {
			configurable: true,
			value: (timer: number) => activeTimers.delete(timer),
		});

		try {
			const run: LiveRun = { ownership: "live", run: makeRun("run-bash-elapsed", "/missing/run-bash-elapsed") };
			const messages: LiveDashboardSession["messages"] = [
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "bash-call", name: "bash", arguments: { command: "sleep 5" } }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "test",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: 1,
				},
			];
			const session: LiveDashboardSession = { messages, subscribe: () => () => {} };
			const liveToolComponents = new LiveToolComponentStore();
			let cache = new LiveSessionRenderCache(liveToolComponents);
			const progress = new Map<string, LiveToolProgress>([
				[
					"bash-call",
					{
						partialResult: {
							content: [{ type: "text", text: "working" }],
							details: undefined,
							isError: false,
						},
					},
				],
			]);
			const render = () =>
				stripAnsi(
					buildRightLines(theme, run, 100, [], {
						sessions: [session],
						tui: { requestRender: () => {} } as never,
						cache,
						toolProgress: new Map([[session, progress]]),
					}).join("\n"),
				);

			assert.match(render(), /Elapsed 0\.0s/);
			assert.equal(activeTimers.size, 1);
			cache.dispose();
			cache = new LiveSessionRenderCache(liveToolComponents);
			now = 6000;
			progress.set("bash-call", {
				partialResult: {
					content: [{ type: "text", text: "still working" }],
					details: undefined,
					isError: false,
				},
			});
			cache.invalidate(session, {
				type: "tool_execution_update",
				toolCallId: "bash-call",
				toolName: "bash",
				args: { command: "sleep 5" },
				partialResult: progress.get("bash-call")!.partialResult!,
			});
			assert.match(render(), /Elapsed 5\.0s/);
			assert.equal(activeTimers.size, 1);

			progress.delete("bash-call");
			messages.push({
				role: "toolResult",
				toolCallId: "bash-call",
				toolName: "bash",
				content: [{ type: "text", text: "done" }],
				isError: false,
				timestamp: 2,
			});
			cache.invalidate(session, {
				type: "tool_execution_end",
				toolCallId: "bash-call",
				toolName: "bash",
				result: messages[1],
				isError: false,
			});
			assert.match(render(), /Took 5\.0s/);
			assert.equal(activeTimers.size, 0);
			const firstAssistant = messages[0];
			assert.equal(firstAssistant?.role, "assistant");
			if (firstAssistant?.role === "assistant") {
				messages.push({
					...firstAssistant,
					content: [
						{ type: "toolCall", id: "bash-call-cleanup", name: "bash", arguments: { command: "sleep 5" } },
					],
					timestamp: 3,
				});
			}
			progress.set("bash-call-cleanup", {
				partialResult: { content: [{ type: "text", text: "working" }], details: undefined, isError: false },
			});
			cache.invalidate(session);
			assert.match(render(), /Elapsed 0\.0s/);
			assert.equal(activeTimers.size, 1);
			liveToolComponents.handleSessionEvent(session as never, { type: "compaction_end" } as AgentSessionEvent);
			assert.equal(activeTimers.size, 0, "compaction finalizes pending native tools while closed");
			messages.pop();
			messages.push({
				...firstAssistant!,
				content: [
					{ type: "toolCall", id: "bash-call-dispose", name: "bash", arguments: { command: "sleep 5" } },
				],
				timestamp: 4,
			});
			progress.delete("bash-call-cleanup");
			progress.set("bash-call-dispose", {
				partialResult: { content: [{ type: "text", text: "working" }], details: undefined, isError: false },
			});
			cache.invalidate(session);
			assert.match(render(), /Elapsed 0\.0s/);
			assert.equal(activeTimers.size, 1);
			liveToolComponents.dispose();
			assert.equal(activeTimers.size, 0, "activation cleanup finalizes pending native tools");
		} finally {
			Date.now = originalDateNow;
			Object.defineProperty(globalThis, "setInterval", { configurable: true, value: originalSetInterval });
			Object.defineProperty(globalThis, "clearInterval", { configurable: true, value: originalClearInterval });
		}
	});

	it("preserves custom renderer state per session across partial cache rebuilds", () => {
		const run: LiveRun = { ownership: "live", run: makeRun("run-renderer-state", "/missing/run-renderer-state") };
		const seenStates: object[] = [];
		const seenComponents: object[] = [];
		const toolDefinition: ToolDefinition = {
			name: "stateful_tool",
			label: "Stateful tool",
			description: "Test renderer identity",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "unused" }], details: undefined }),
			renderCall: (_args, _theme, context) => {
				seenStates.push(context.state);
				const component = context.lastComponent ?? new Text("", 0, 0);
				seenComponents.push(component);
				if (component instanceof Text) component.setText("stateful call");
				return component;
			},
			renderResult: (result, options, _theme, context) => {
				seenStates.push(context.state);
				const component = context.lastComponent ?? new Text("", 0, 0);
				seenComponents.push(component);
				const text = result.content.find((content) => content.type === "text")?.text ?? "";
				if (component instanceof Text) component.setText(`${options.isPartial ? "partial" : "final"} ${text}`);
				return component;
			},
		};
		const messages: LiveDashboardSession["messages"] = [
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "shared-id", name: "stateful_tool", arguments: {} }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: 1,
			},
		];
		const sessionA: LiveDashboardSession = {
			messages,
			getToolDefinition: () => toolDefinition,
			subscribe: () => () => {},
		};
		const sessionB: LiveDashboardSession = {
			messages,
			getToolDefinition: () => toolDefinition,
			subscribe: () => () => {},
		};
		const cache = new LiveSessionRenderCache();
		const progressA = new Map<string, LiveToolProgress>([
			[
				"shared-id",
				{ partialResult: { content: [{ type: "text", text: "first" }], details: undefined, isError: false } },
			],
		]);
		const render = (session: LiveDashboardSession, progress: Map<string, LiveToolProgress>, revision: number) =>
			stripAnsi(
				buildRightLines(theme, run, 100, [], {
					sessions: [session],
					tui: { requestRender: () => {} } as never,
					cache,
					toolProgress: new Map([[session, progress]]),
					display: { revision, toolsExpanded: false, hideThinking: false },
				}).join("\n"),
			);

		assert.match(render(sessionA, progressA, 0), /partial first/);
		progressA.set("shared-id", {
			partialResult: { content: [{ type: "text", text: "second" }], details: undefined, isError: false },
		});
		cache.invalidate(sessionA);
		assert.match(render(sessionA, progressA, 1), /partial second/);
		assert.ok(seenStates.length > 2);
		assert.equal(new Set(seenStates).size, 1, "one renderer state object survives the rebuild");
		assert.equal(new Set(seenComponents).size, 2, "call and result components are each reused");

		const progressB = new Map<string, LiveToolProgress>([
			[
				"shared-id",
				{
					partialResult: {
						content: [{ type: "text", text: "other session" }],
						details: undefined,
						isError: false,
					},
				},
			],
		]);
		assert.match(render(sessionB, progressB, 0), /partial other session/);
		assert.equal(new Set(seenStates).size, 2, "the same tool call id does not collide across sessions");
		cache.clear(sessionA);
		cache.invalidate(sessionA);
		assert.match(render(sessionA, progressA, 0), /partial second/);
		assert.equal(new Set(seenStates).size, 3, "clearing one session drops only its pending component map");
		cache.dispose();
		cache.invalidate(sessionB);
		assert.match(render(sessionB, progressB, 0), /partial other session/);
		assert.equal(new Set(seenStates).size, 4, "disposing the cache drops remaining pending component maps");
	});

	it("renders every retained step session in order", () => {
		const run: LiveRun = { ownership: "live", run: makeRun("run-parallel", "/missing/run-parallel") };
		const session = (text: string): LiveDashboardSession => ({
			messages: [{ role: "user", content: text, timestamp: 1 }],
			subscribe: () => () => {},
		});
		const output = stripAnsi(
			buildRightLines(theme, run, 80, [], {
				sessions: [session("First live step"), session("Second live step")],
				tui: { requestRender: () => {} } as never,
			}).join("\n"),
		);

		assert.match(output, /Step 1[\s\S]*First live step[\s\S]*Step 2[\s\S]*Second live step/);
	});

	it("renders live tool results and bash messages with Pi components", () => {
		const run: LiveRun = { ownership: "live", run: makeRun("run-tools", "/missing/run-tools") };
		const messages: LiveDashboardSession["messages"] = [
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "call-1", name: "custom_tool", arguments: { path: "notes.txt" } }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: 1,
			},
		];
		const cache = new LiveSessionRenderCache();
		let renderRequests = 0;
		const session: LiveDashboardSession = { messages, subscribe: () => () => {} };
		const render = () =>
			stripAnsi(
				buildRightLines(theme, run, 100, [], {
					sessions: [session],
					tui: { requestRender: () => renderRequests++ } as never,
					cache,
				}).join("\n"),
			);
		render();
		messages.push(
			{
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "custom_tool",
				content: [{ type: "text", text: "tool result body" }],
				isError: false,
				timestamp: 2,
			},
			{
				role: "bashExecution",
				command: "printf hello",
				output: "bash output body",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				timestamp: 3,
			},
		);
		cache.invalidate(session, {
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "custom_tool",
			result: messages[1],
			isError: false,
		});
		const output = render();

		assert.equal(renderRequests, 0, "rendering a completed transcript must not schedule another render");
		assert.match(output, /tool result body/);
		assert.match(output, /printf hello/);
		assert.match(output, /bash output body/);
	});

	it("uses extension tool renderers for retained live sessions", () => {
		const run: LiveRun = { ownership: "live", run: makeRun("run-extension-tool", "/missing/run-extension-tool") };
		const toolDefinition: ToolDefinition = {
			name: "custom_tool",
			label: "Custom tool",
			description: "Test custom rendering",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "unused" }], details: undefined }),
			renderShell: "self",
			renderCall: () => new Text("compact custom call", 0, 0),
			renderResult: () => new Text("compact custom result", 0, 0),
		};
		const session: LiveDashboardSession = {
			messages: [
				{
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "call-custom",
							name: "custom_tool",
							arguments: { rawMarker: "RAW_ARGS" },
						},
					],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "test",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: 1,
				},
				{
					role: "toolResult",
					toolCallId: "call-custom",
					toolName: "custom_tool",
					content: [{ type: "text", text: "FULL_RESULT_MARKER" }],
					isError: false,
					timestamp: 2,
				},
			],
			subscribe: () => () => {},
			getToolDefinition: (name) => (name === "custom_tool" ? toolDefinition : undefined),
		};

		const output = stripAnsi(
			buildRightLines(theme, run, 100, [], {
				sessions: [session],
				tui: { requestRender: () => {} } as never,
			}).join("\n"),
		);

		assert.match(output, /compact custom call/);
		assert.match(output, /compact custom result/);
		assert.doesNotMatch(output, /RAW_ARGS|FULL_RESULT_MARKER/);
	});

	it("rebuilds native transcript rows when dashboard display modes change", () => {
		const run: LiveRun = { ownership: "live", run: makeRun("run-display-modes", "/missing/display-modes") };
		const expandedValues: boolean[] = [];
		const toolDefinition: ToolDefinition = {
			name: "custom_tool",
			label: "Custom tool",
			description: "Test display modes",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "unused" }], details: undefined }),
			renderResult: (_result, options) => {
				expandedValues.push(options.expanded);
				return new Text(options.expanded ? "EXPANDED_RESULT" : "COLLAPSED_RESULT", 0, 0);
			},
		};
		const session: LiveDashboardSession = {
			messages: [
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "THINKING_MARKER" },
						{ type: "toolCall", id: "call-display", name: "custom_tool", arguments: {} },
					],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "test",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: 1,
				},
				{
					role: "toolResult",
					toolCallId: "call-display",
					toolName: "custom_tool",
					content: [{ type: "text", text: "result" }],
					isError: false,
					timestamp: 2,
				},
			],
			subscribe: () => () => {},
			getToolDefinition: () => toolDefinition,
		};
		const cache = new LiveSessionRenderCache();
		const render = (revision: number, toolsExpanded: boolean, hideThinking: boolean) =>
			stripAnsi(
				buildRightLines(theme, run, 100, [], {
					sessions: [session],
					tui: { requestRender: () => {} } as never,
					cache,
					display: { revision, toolsExpanded, hideThinking },
				}).join("\n"),
			);

		const initial = render(0, false, false);
		assert.match(initial, /COLLAPSED_RESULT/);
		assert.match(initial, /THINKING_MARKER/);
		assert.deepEqual(expandedValues, [false]);

		render(0, true, true);
		assert.deepEqual(expandedValues, [false], "ordinary repaint at the same revision stays cached");

		const expanded = render(1, true, true);
		assert.match(expanded, /EXPANDED_RESULT/);
		assert.doesNotMatch(expanded, /THINKING_MARKER/);
		assert.deepEqual(expandedValues, [false, true]);

		const restored = render(2, false, false);
		assert.match(restored, /COLLAPSED_RESULT/);
		assert.match(restored, /THINKING_MARKER/);
		assert.deepEqual(expandedValues, [false, true, false]);
	});

	it("renders ordered persisted messages with native components and the shared tool catalog", () => {
		const run: LiveRun = { ownership: "foreign", run: makeRun("run-persisted-native", "/missing/native") };
		const toolDefinition: ToolDefinition = {
			name: "custom_tool",
			label: "Custom tool",
			description: "Test persisted custom rendering",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "unused" }], details: undefined }),
			renderShell: "self",
			renderCall: () => new Text("persisted custom call\x1b]0;unsafe\x07", 0, 0),
			renderResult: () => new Text("persisted custom result", 0, 0),
		};
		const assistantMessage: LiveDashboardSession["messages"][number] = {
			role: "assistant",
			content: [
				{ type: "text", text: "Native assistant text" },
				{ type: "toolCall", id: "call-persisted", name: "custom_tool", arguments: { rawMarker: "RAW_ARGS" } },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 2,
		};
		const output = stripAnsi(
			buildRightLines(theme, run, 100, [], undefined, {
				sessions: [
					{
						stepIndex: 0,
						messages: [
							{ role: "user", content: "Persisted user text", timestamp: 1 },
							assistantMessage,
							{
								role: "toolResult",
								toolCallId: "call-persisted",
								toolName: "custom_tool",
								content: [{ type: "text", text: "FULL_RESULT_MARKER" }],
								isError: false,
								timestamp: 3,
							},
						],
					},
					{
						stepIndex: 1,
						messages: [
							{
								role: "bashExecution",
								command: "printf nested",
								output: "nested output",
								exitCode: 0,
								cancelled: false,
								truncated: false,
								timestamp: 4,
							},
						],
					},
				],
				tui: { requestRender: () => {} } as never,
				getToolDefinition: (name) => (name === "custom_tool" ? toolDefinition : undefined),
			}).join("\n"),
		);

		assert.match(
			output,
			/Step 1[\s\S]*Persisted user text[\s\S]*Native assistant text[\s\S]*persisted custom call[\s\S]*persisted custom result[\s\S]*Step 2[\s\S]*printf nested[\s\S]*nested output/,
		);
		assert.doesNotMatch(output, /RAW_ARGS|FULL_RESULT_MARKER|unsafe/);
	});

	it("marks completed persisted tool arguments complete before rendering their result", () => {
		const run: LiveRun = { ownership: "foreign", run: makeRun("run-persisted-args", "/missing/persisted-args") };
		const toolDefinition: ToolDefinition = {
			name: "args_gated_tool",
			label: "Args-gated tool",
			description: "Test completed argument rendering",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "unused" }], details: undefined }),
			renderShell: "self",
			renderCall: (_args, _theme, context) =>
				new Text(context.argsComplete ? "completed input fallback" : "", 0, 0),
			renderResult: () => new Text("persisted result", 0, 0),
		};
		const messages: LiveDashboardSession["messages"] = [
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "call-persisted-args", name: "args_gated_tool", arguments: {} }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: 1,
			},
			{
				role: "toolResult",
				toolCallId: "call-persisted-args",
				toolName: "args_gated_tool",
				content: [{ type: "text", text: "raw result" }],
				isError: false,
				timestamp: 2,
			},
		];

		const output = stripAnsi(
			buildRightLines(theme, run, 100, [], undefined, {
				sessions: [{ stepIndex: 0, messages }],
				tui: { requestRender: () => {} } as never,
				getToolDefinition: () => toolDefinition,
			}).join("\n"),
		);

		assert.match(output, /completed input fallback/);
		assert.match(output, /persisted result/);
	});

	it("reuses a completed persisted tool component when its args-gated async preview settles", async () => {
		const run: LiveRun = { ownership: "foreign", run: makeRun("run-settled-args", "/missing/settled-args") };
		const scheduledStates = new WeakSet<object>();
		let componentsCreated = 0;
		const toolDefinition: ToolDefinition = {
			name: "settled_args_tool",
			label: "Settled args tool",
			description: "Test settled persisted rendering",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "unused" }], details: undefined }),
			renderShell: "self",
			renderCall: (_args, _theme, context) => {
				const component =
					context.lastComponent instanceof Text
						? context.lastComponent
						: new Text("pending persisted preview", 0, 0);
				if (!context.lastComponent) componentsCreated++;
				if (context.argsComplete && !scheduledStates.has(context.state)) {
					scheduledStates.add(context.state);
					void Promise.resolve().then(() => {
						component.setText("settled persisted preview");
						context.invalidate();
					});
				}
				return component;
			},
			renderResult: () => new Text("persisted result", 0, 0),
		};
		const messages: LiveDashboardSession["messages"] = [
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "call-settled-args", name: "settled_args_tool", arguments: {} }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: 1,
			},
			{
				role: "toolResult",
				toolCallId: "call-settled-args",
				toolName: "settled_args_tool",
				content: [{ type: "text", text: "raw result" }],
				isError: false,
				timestamp: 2,
			},
		];
		const session = { stepIndex: 0, messages };
		const cache = new LiveSessionRenderCache();
		let repaintRequests = 0;
		let output = "";
		const render = () => {
			output = stripAnsi(
				buildRightLines(theme, run, 100, [], undefined, {
					sessions: [session],
					tui: {
						requestRender: () => {
							repaintRequests++;
							if (repaintRequests <= 5) queueMicrotask(render);
						},
					} as never,
					cache,
					getToolDefinition: () => toolDefinition,
				}).join("\n"),
			);
		};

		render();
		for (let turn = 0; turn < 12; turn++) await Promise.resolve();

		assert.equal(repaintRequests, 1, "the settled preview converges after one repaint");
		assert.equal(componentsCreated, 1, "cache rebuilds reuse the completed tool component");
		assert.match(output, /settled persisted preview/);
	});

	it("applies dashboard display modes to persisted native sessions", () => {
		const run: LiveRun = { ownership: "foreign", run: makeRun("run-persisted-display", "/missing/persisted") };
		const expandedValues: boolean[] = [];
		const toolDefinition: ToolDefinition = {
			name: "custom_tool",
			label: "Custom tool",
			description: "Test persisted display modes",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "unused" }], details: undefined }),
			renderResult: (_result, options) => {
				expandedValues.push(options.expanded);
				return new Text(options.expanded ? "PERSISTED_EXPANDED" : "PERSISTED_COLLAPSED", 0, 0);
			},
		};
		const messages: LiveDashboardSession["messages"] = [
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "PERSISTED_THINKING" },
					{ type: "toolCall", id: "call-persisted-display", name: "custom_tool", arguments: {} },
				],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: 1,
			},
			{
				role: "toolResult",
				toolCallId: "call-persisted-display",
				toolName: "custom_tool",
				content: [{ type: "text", text: "result" }],
				isError: false,
				timestamp: 2,
			},
		];
		const render = (revision: number, toolsExpanded: boolean, hideThinking: boolean) =>
			stripAnsi(
				buildRightLines(theme, run, 100, [], undefined, {
					sessions: [{ stepIndex: 0, messages }],
					tui: { requestRender: () => {} } as never,
					cache: new LiveSessionRenderCache(),
					getToolDefinition: () => toolDefinition,
					display: { revision, toolsExpanded, hideThinking },
				}).join("\n"),
			);

		const initial = render(0, false, false);
		assert.match(initial, /PERSISTED_COLLAPSED/);
		assert.match(initial, /PERSISTED_THINKING/);
		const toggled = render(1, true, true);
		assert.match(toggled, /PERSISTED_EXPANDED/);
		assert.doesNotMatch(toggled, /PERSISTED_THINKING/);
		assert.deepEqual(expandedValues, [false, true]);
	});

	it("removes terminal-executable controls from retained live rows", () => {
		const run: LiveRun = { ownership: "live", run: makeRun("run-terminal-safe", "/missing/run-terminal-safe") };
		let componentRenders = 0;
		const toolDefinition: ToolDefinition = {
			name: "unsafe_tool",
			label: "Unsafe tool",
			description: "Test terminal-safe rendering",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "unused" }], details: undefined }),
			renderShell: "self",
			renderCall: () => {
				componentRenders++;
				return new Text("styled \x1b[31mΩ call\x1b[0m\x1b]133;A\x07\x1b[2B", 0, 0);
			},
			renderResult: () => {
				componentRenders++;
				return new Text(
					"progress 10%\rprogress 20%\b\v\f done\x1b[H\x1b[2J\x1b]0;title\x07\x1bPpayload\x1b\\\x1b_hidden\x1b\\",
					0,
					0,
				);
			},
		};
		const session: LiveDashboardSession = {
			messages: [
				{ role: "user", content: "first CRLF\r\nsecond Unicode λ", timestamp: 1 },
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "call-unsafe", name: "unsafe_tool", arguments: {} }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "test",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: 2,
				},
				{
					role: "toolResult",
					toolCallId: "call-unsafe",
					toolName: "unsafe_tool",
					content: [{ type: "text", text: "raw result" }],
					isError: false,
					timestamp: 3,
				},
			],
			subscribe: () => () => {},
			getToolDefinition: () => toolDefinition,
		};

		const cache = new LiveSessionRenderCache();
		const render = () =>
			buildRightLines(theme, run, 100, [], {
				sessions: [session],
				tui: { requestRender: () => {} } as never,
				cache,
			});
		const lines = render();
		const rendersAfterFirstPass = componentRenders;
		const cachedLines = render();

		for (const line of [...lines, ...cachedLines]) {
			for (const character of stripAnsi(line)) {
				const code = character.charCodeAt(0);
				assert.ok(code > 0x1f && (code < 0x7f || code > 0x9f));
			}
		}
		assert.equal(
			componentRenders,
			rendersAfterFirstPass,
			"cached rows do not rerun native or custom component renderers",
		);
		const output = lines.join("\n");
		assert.ok(output.includes("\x1b[31mΩ call\x1b[0m"));
		assert.match(stripAnsi(output), /first CRLF[\s\S]*second Unicode λ/);
		assert.match(stripAnsi(output), /progress 10%progress 20% done/);
	});

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
	customMessageBg: "\x1b[45m",
};
const styledTheme = {
	fg: (name: string, text: string) => (name === "customMessageText" ? `\x1b[37m${text}\x1b[39m` : text),
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

describe("dashboard selected-run status section", () => {
	it("renders a compact separator section without background bleed", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), `detail-render-${randomUUID()}-`));
		try {
			const runId = "123e4567-e89b-12d3-a456-426614174000";
			const startedAt = new Date(2026, 6, 5, 14, 0).getTime();
			const now = new Date(2026, 6, 6, 15, 0).getTime();
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
				...makeRun(runId, dir, "polish dashboard"),
				mode: "parallel",
				startedAt,
				endedAt: startedAt + 838449,
				totalTokens: { input: 1_000_000, output: 3_240_235, total: 4_240_235 },
			};
			const width = 44;
			const lines = buildSelectedRunStatusBox(
				statusTheme,
				{ ownership: "foreign", run: summary } satisfies LiveRun,
				width,
				now,
			);
			const plainLines = lines.map(stripAnsi);
			const joined = plainLines.join("\n");

			assert.equal(lines.length, 4, "status section wraps metadata without padding");
			assert.match(plainLines[0]!, /^polish dashboard +complete · 13m58s$/);
			assert.doesNotMatch(plainLines[0]!, /─/, "status header carries no rule dashes");
			assert.match(plainLines[1]!, /^ {2}2 tools · 4\.2Mt · 13m58s$/);
			assert.match(plainLines[2]!, /^ {2}parallel · started Jul 5 14:00$/);
			assert.match(plainLines[3]!, new RegExp(`^ {2}id ${runId}$`));
			assert.doesNotMatch(joined, /123e4567\.\.\./, "full run id is not truncated");
			const narrowLines = buildSelectedRunStatusBox(
				statusTheme,
				{ ownership: "foreign", run: summary } satisfies LiveRun,
				28,
				now,
			).map(stripAnsi);
			assert.equal(narrowLines.length, 5, "narrow status section uses the full row budget");
			assert.equal(
				narrowLines
					.slice(3)
					.map((line) => line.trim())
					.join(""),
				`id ${runId}`,
				"full run id wraps instead of truncating",
			);
			assert.doesNotMatch(joined, /[╭╮╰╯│]/, "status section is not boxed");
			for (const line of lines) {
				assert.ok(
					visibleWidth(line) <= width,
					`status section line must fit sidebar width: ${JSON.stringify(line)}`,
				);
				assert.doesNotMatch(
					line,
					/\x1b\[(?:4[0-9]|10[0-7]|49)m/,
					`status section must use fg only, no bg bleed: ${JSON.stringify(line)}`,
				);
			}
			assert.equal(visibleWidth(lines[0]!), width, "header fills the sidebar width");
			assert.match(lines[0]!, /\x1b\[32mpolish dashboard\x1b\[39m/, `label is success-colored:\n${joined}`);
			assert.match(
				lines[0]!,
				/\x1b\[32mcomplete · 13m58s\x1b\[39m/,
				`complete tail is success-colored:\n${joined}`,
			);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps today's start time short when the id fits on one metadata line", () => {
		const runId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
		const startedAt = new Date(2026, 6, 6, 9, 5).getTime();
		const summary: AsyncRunSummary = {
			...makeRun(runId, "/tmp/status-box-today", "today run"),
			startedAt,
			endedAt: startedAt + 1000,
		};
		const lines = buildSelectedRunStatusBox(
			statusTheme,
			{ ownership: "foreign", run: summary } satisfies LiveRun,
			80,
			new Date(2026, 6, 6, 12, 0).getTime(),
		).map(stripAnsi);

		assert.equal(lines.length, 3, "wide status section stays compact");
		assert.match(lines[2]!, new RegExp(`^ {2}single · id ${runId} · started 09:05$`));
		assert.doesNotMatch(lines[2]!, /Jul 6/);
	});

	it("treats lost as authoritative over a stale current phase", () => {
		const now = new Date(2026, 6, 6, 12, 0).getTime();
		const summary: AsyncRunSummary = {
			...makeRun("lost-stale-phase", "/tmp/status-box-lost", "stale phase"),
			state: "running",
			displayState: "lost",
			startedAt: now - 60_000,
			lastUpdate: now - 10_000,
			phase: "streaming_text",
			phaseStartedAt: now - 41_900,
		};
		const lines = buildSelectedRunStatusBox(
			statusTheme,
			{ ownership: "foreign", run: summary } satisfies LiveRun,
			80,
			now,
		).map(stripAnsi);

		assert.match(lines[0]!, /^stale phase +lost ·/);
		assert.doesNotMatch(lines.join("\n"), /now writing/);
	});
});

describe("dashboard detail pane tool cards", () => {
	it("renders compact final output as a full-width panel while preserving narration", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), `detail-output-${randomUUID()}-`));
		try {
			writeStatus(dir, "run-output");
			writeSession(dir, [
				assistant("2026-05-20T00:00:01.000Z", [
					{
						type: "text",
						text: 'Before the result.\n<output>{"ok":true,"items":[1,2]}</output>\nAfter the result.',
					},
				]),
			]);
			const width = 44;
			const lines = buildRightLines(
				styledTheme,
				{ ownership: "foreign", run: makeRun("run-output", dir) },
				width,
			);
			const plain = lines.map(stripAnsi).join("\n");
			const panel = lines.filter((line) => line.startsWith(BG_OPEN.customMessageBg!));

			assert.match(plain, /Before the result\./);
			assert.match(plain, /After the result\./);
			assert.match(
				panel.map((line) => stripAnsi(line).trimEnd()).join("\n"),
				/\{\n[\s\S]*"ok": true,[\s\S]*"items": \[/,
			);
			assert.doesNotMatch(plain, /<\/?output>/);
			assert.ok(panel.length >= 3);
			const panelStart = lines.findIndex((line) => line.startsWith(BG_OPEN.customMessageBg!));
			assert.equal(lines[panelStart - 1], "");
			for (const line of panel) {
				assert.equal(visibleWidth(line), width);
				assert.ok(line.endsWith("\x1b[49m"));
				assert.ok(line.includes("\x1b[37m"));
			}
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("panelizes each completed compact output turn while leaving tool-call samples raw", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), `detail-output-resume-${randomUUID()}-`));
		try {
			writeStatus(dir, "run-output-resume");
			writeSession(dir, [
				assistant("2026-05-20T00:00:01.000Z", [
					{ type: "text", text: "First attempt.\n<output>EARLIER</output>" },
				]),
				user("2026-05-20T00:00:02.000Z", [{ type: "text", text: "Continue" }]),
				assistant("2026-05-20T00:00:03.000Z", [
					{ type: "text", text: "Example: <output>sample only</output>" },
					{ type: "tool_use", id: "sample-tool", name: "run", input: { code: "return 1" } },
				]),
				user("2026-05-20T00:00:04.000Z", [{ type: "tool_result", tool_use_id: "sample-tool", content: "ok" }]),
				assistant("2026-05-20T00:00:05.000Z", [
					{ type: "text", text: "Second attempt.\n<output>LATER</output>" },
				]),
			]);
			const lines = buildRightLines(
				styledTheme,
				{ ownership: "foreign", run: makeRun("run-output-resume", dir) },
				48,
			);
			const plain = stripAnsi(lines.join("\n"));

			assert.match(plain, /EARLIER/);
			assert.match(plain, /LATER/);
			assert.match(plain, /Example: <output>sample only<\/output>/);
			assert.doesNotMatch(plain, /<output>EARLIER|<output>LATER/);
			assert.ok(lines.filter((line) => line.startsWith(BG_OPEN.customMessageBg!)).length >= 6);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("uses the same output panel for retained live and persisted typed assistant messages", () => {
		const run = {
			ownership: "foreign",
			run: makeRun("run-native-output", "/missing/native-output"),
		} satisfies LiveRun;
		const message: LiveDashboardSession["messages"][number] = {
			role: "assistant",
			content: [
				{
					type: "text",
					text: "Narration before.\n<output>## Result\n\nPlain **Markdown**.</output>\nNarration after.",
				},
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 1,
		};
		const liveSession: LiveDashboardSession = { messages: [message], subscribe: () => () => {} };
		const historicalSession = { stepIndex: 0, messages: [message] };
		const liveLines = buildRightLines(styledTheme, run, 40, [], {
			sessions: [liveSession],
			tui: { requestRender: () => {} } as never,
		});
		const persistedLines = buildRightLines(styledTheme, run, 40, [], undefined, {
			sessions: [historicalSession],
			tui: { requestRender: () => {} } as never,
			getToolDefinition: () => undefined,
		});

		for (const lines of [liveLines, persistedLines]) {
			const plain = stripAnsi(lines.join("\n"));
			assert.match(plain, /Narration before\./);
			assert.match(plain, /Result/);
			assert.match(plain, /Plain Markdown\./);
			assert.match(plain, /Narration after\./);
			assert.doesNotMatch(plain, /<\/?output>/);
			assert.ok(lines.some((line) => line.startsWith(BG_OPEN.customMessageBg!)));
		}
	});

	it("leaves incomplete output markup unchanged", () => {
		const run = { ownership: "foreign", run: makeRun("run-incomplete", "/missing/incomplete") } satisfies LiveRun;
		const message: LiveDashboardSession["messages"][number] = {
			role: "assistant",
			content: [{ type: "text", text: "<output>complete</output>\nThen <output>unfinished" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 1,
		};
		const lines = buildRightLines(styledTheme, run, 40, [], {
			sessions: [{ messages: [message], subscribe: () => () => {} }],
			tui: { requestRender: () => {} } as never,
		});

		assert.match(stripAnsi(lines.join("\n")), /<output>complete<\/output>[\s\S]*<output>unfinished/);
		assert.ok(lines.every((line) => !line.startsWith(BG_OPEN.customMessageBg!)));
	});

	it("panelizes completed output turns consistently with and without the live render cache", () => {
		const run = {
			ownership: "foreign",
			run: makeRun("run-output-resume", "/missing/output-resume"),
		} satisfies LiveRun;
		const completedOutput = (
			text: string,
			timestamp: number,
		): Extract<LiveDashboardSession["messages"][number], { role: "assistant" }> => ({
			role: "assistant",
			content: [{ type: "text", text }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp,
		});
		const sampleWithToolCall: LiveDashboardSession["messages"][number] = {
			...completedOutput("", 3),
			content: [
				{ type: "text", text: "Example: <output>sample only</output>" },
				{ type: "toolCall", id: "sample-tool", name: "run", arguments: { code: "return 1" } },
			],
		};
		const toolResult: LiveDashboardSession["messages"][number] = {
			role: "toolResult",
			toolCallId: "sample-tool",
			toolName: "run",
			content: [{ type: "text", text: "ok" }],
			isError: false,
			timestamp: 4,
		};
		const messages: LiveDashboardSession["messages"] = [
			completedOutput("First attempt.\n<output>EARLIER</output>", 1),
			{ role: "user", content: "Continue the run", timestamp: 2 },
			sampleWithToolCall,
			toolResult,
			completedOutput("Second attempt.\n<output>LATER</output>", 5),
		];
		const session: LiveDashboardSession = { messages, subscribe: () => () => {} };
		const render = (cache?: LiveSessionRenderCache) =>
			buildRightLines(styledTheme, run, 40, [], {
				sessions: [session],
				tui: { requestRender: () => {} } as never,
				...(cache ? { cache } : {}),
			});
		const uncached = render();
		const cached = render(new LiveSessionRenderCache());

		assert.deepEqual(cached, uncached, "cache grouping cannot change output-block presentation");
		const plain = stripAnsi(cached.join("\n"));
		assert.match(plain, /EARLIER/);
		assert.match(plain, /LATER/);
		assert.match(plain, /Example: <output>sample only<\/output>/);
		assert.doesNotMatch(plain, /<output>EARLIER|<output>LATER/);
		assert.ok(cached.filter((line) => line.startsWith(BG_OPEN.customMessageBg!)).length >= 6);
	});

	it("renders assistant stop metadata once after a split output panel", () => {
		const run = {
			ownership: "foreign",
			run: makeRun("run-output-stop-metadata", "/missing/output-stop-metadata"),
		} satisfies LiveRun;
		const cases = [
			{ stopReason: "error" as const, errorMessage: "boom", marker: "Error: boom" },
			{ stopReason: "aborted" as const, errorMessage: "stopped by user", marker: "stopped by user" },
			{
				stopReason: "length" as const,
				marker: "Error: Model stopped because it reached the maximum output token limit.",
			},
		];
		type AssistantContent = Extract<LiveDashboardSession["messages"][number], { role: "assistant" }>["content"];
		const variants: Array<{ label: string; content: AssistantContent; lastContent: string }> = [
			{
				label: "suffix narration",
				content: [
					{
						type: "text",
						text: "Narration before.\n<output>Result body.</output>\nNarration after.",
					},
				],
				lastContent: "Narration after.",
			},
			{
				label: "trailing output",
				content: [{ type: "text", text: "Narration before.\n<output>Result body.</output>" }],
				lastContent: "Result body.",
			},
			{
				label: "thinking before trailing output",
				content: [
					{ type: "thinking", thinking: "Private reasoning." },
					{ type: "text", text: "<output>Result body.</output>" },
				],
				lastContent: "Result body.",
			},
		];

		for (const [index, testCase] of cases.entries()) {
			for (const [variantIndex, variant] of variants.entries()) {
				const message: LiveDashboardSession["messages"][number] = {
					role: "assistant",
					content: variant.content,
					api: "anthropic-messages",
					provider: "anthropic",
					model: "test",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					...testCase,
					timestamp: index * variants.length + variantIndex + 1,
				};
				const lines = buildRightLines(styledTheme, run, 50, [], {
					sessions: [{ messages: [message], subscribe: () => () => {} }],
					tui: { requestRender: () => {} } as never,
				});
				const plain = stripAnsi(lines.join("\n"));
				const normalized = plain.replace(/\s+/g, " ");

				assert.equal(
					normalized.split(testCase.marker).length - 1,
					1,
					`${testCase.stopReason} footer appears once for ${variant.label}`,
				);
				assert.ok(
					normalized.lastIndexOf(testCase.marker) > normalized.lastIndexOf(variant.lastContent),
					`${testCase.stopReason} footer follows ${variant.label}: ${normalized}`,
				);
			}
		}
	});

	it("pretty-prints valid JSON without interpreting Markdown inside string values", () => {
		const run = { ownership: "foreign", run: makeRun("run-output-json", "/missing/output-json") } satisfies LiveRun;
		const message: LiveDashboardSession["messages"][number] = {
			role: "assistant",
			content: [
				{
					type: "text",
					text: '<output>{"note":"**bold** and # head","list":"- a"}</output>',
				},
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 1,
		};
		const lines = buildRightLines(styledTheme, run, 60, [], {
			sessions: [{ messages: [message], subscribe: () => () => {} }],
			tui: { requestRender: () => {} } as never,
		});
		const panel = stripAnsi(lines.filter((line) => line.startsWith(BG_OPEN.customMessageBg!)).join("\n"));

		assert.match(panel, /"note": "\*\*bold\*\* and # head"/);
		assert.match(panel, /"list": "- a"/);
	});

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
