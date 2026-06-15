import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { renderSubagentResult } from "../../src/surfaces/render-result.ts";
import { appendRunEntry, setRegistryPathForTests } from "../../src/state/runs-registry.ts";
import type { PersistedRunStatus } from "../../src/protocol/status-types.ts";
import { RUNS_DIR } from "../../src/shared/runtime-paths.ts";

const ids = [
	"inline-wired-parent-single",
	"inline-wired-child-running",
	"inline-wired-parent-multi",
	"inline-wired-child-complete",
];
const theme = {
	fg: (_name: string, text: string) => text,
	bold: (text: string) => text,
} as never;
const usage = { input: 0, output: 0, total: 0 };
const registryPath = path.join(os.tmpdir(), `pi-inline-wired-registry-${process.pid}.jsonl`);

function rmRun(id: string): void {
	fs.rmSync(path.join(RUNS_DIR, id), { recursive: true, force: true });
	setRegistryPathForTests(null);
}

function writeRun(
	id: string,
	opts: {
		parentRunId?: string;
		state?: PersistedRunStatus["state"];
		agent?: string;
		label?: string;
		startedAt?: number;
		endedAt?: number;
		tokens?: number;
		events?: Array<Record<string, unknown>>;
	} = {},
): void {
	setRegistryPathForTests(registryPath);
	const dir = path.join(RUNS_DIR, id);
	fs.mkdirSync(dir, { recursive: true });
	const startedAt = opts.startedAt ?? Date.now() - 1_500;
	const endedAt = opts.endedAt ?? Date.now();
	const state = opts.state ?? "running";
	const status: PersistedRunStatus = {
		runId: id,
		...(opts.parentRunId ? { parentRunId: opts.parentRunId } : {}),
		mode: "single",
		...(opts.label ? { label: opts.label } : {}),
		state,
		startedAt,
		lastUpdate: endedAt,
		...(state === "running" ? {} : { endedAt }),
		steps: [
			{
				agent: opts.agent ?? "fixer",
				status: state === "running" ? "running" : state,
				tokens: opts.tokens ? { input: 0, output: opts.tokens, total: opts.tokens } : undefined,
			},
		],
		...(opts.tokens ? { totalTokens: { input: 0, output: opts.tokens, total: opts.tokens } } : {}),
	};
	fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify(status), "utf-8");
	const sessionDir = path.join(dir, "run-0");
	fs.mkdirSync(sessionDir, { recursive: true });
	const messages = (opts.events ?? [])
		.filter((event) => event.type === "tool_execution_start")
		.map((event) => ({
			type: "message",
			timestamp: new Date(typeof event.observedAt === "number" ? event.observedAt : Date.now()).toISOString(),
			message: {
				role: "assistant",
				content: [{ type: "tool_use", id: event.toolCallId, name: event.toolName, input: event.args }],
			},
		}));
	fs.writeFileSync(
		path.join(sessionDir, "session.jsonl"),
		[
			{ type: "session", version: 3, id, timestamp: new Date(startedAt).toISOString(), cwd: process.cwd() },
			...messages,
		]
			.map((event) => JSON.stringify(event))
			.join("\n") + "\n",
		"utf-8",
	);
	appendRunEntry({
		runId: id,
		runRecordDir: dir,
		mode: "single",
		source: "sync",
		agentName: opts.agent ?? "fixer",
		...(opts.label ? { label: opts.label } : {}),
		...(opts.parentRunId ? { parentRunId: opts.parentRunId } : {}),
		cwd: process.cwd(),
		startedAt,
	});
}

function tool(toolName: string, args: Record<string, unknown>, ts = 1_100): Record<string, unknown> {
	return {
		type: "tool_execution_start",
		subagentStepIndex: 0,
		toolName,
		toolCallId: `${toolName}-${ts}`,
		args,
		observedAt: ts,
	};
}

afterEach(() => ids.forEach(rmRun));

describe("inline nested live feed compact wiring", () => {
	it("renders a running child through the single compact path without the plain spawn line", () => {
		const childTask = "You are the nested SYNC child. Read /Users/example/live.txt";
		writeRun(ids[1]!, {
			parentRunId: ids[0],
			agent: "fixer",
			label: "live child",
			tokens: 1200,
			events: [tool("read", { path: "/Users/example/live.txt" })],
		});

		const widget = renderSubagentResult(
			{
				content: [{ type: "text", text: "(running...)" }],
				details: {
					mode: "single",
					runId: ids[0],
					results: [
						{
							agent: "parent",
							task: "parent task",
							exitCode: 0,
							messages: [],
							usage,
							progress: {
								index: 0,
								agent: "parent",
								status: "running",
								task: "parent task",
								recentTools: [
									{
										tool: "subagent",
										args: childTask,
										rawArgs: { agent: "fixer", task: childTask, label: "live child" },
										endMs: Date.now(),
									},
								],
								recentOutput: [],
								toolCount: 1,
								tokens: 0,
								durationMs: 100,
							},
						},
					],
				},
			},
			{ expanded: false },
			theme,
		);

		const text = widget.render(140).join("\n");
		assert.match(text, /◇ subagent: fixer · live child · 1 tools · 1\.2k tok/);
		assert.doesNotMatch(text, /← subagent: You are the nested SYNC child/);
	});

	it("renders a terminal child through the multi compact path without the plain spawn line", () => {
		const childTask = "You are the nested SYNC child. Finish /Users/example/done.txt";
		writeRun(ids[3]!, {
			parentRunId: ids[2],
			state: "complete",
			agent: "explorer",
			label: "done child",
			tokens: 512,
			startedAt: 1_000,
			endedAt: 2_250,
			events: [tool("bash", { command: "echo done" })],
		});

		const widget = renderSubagentResult(
			{
				content: [{ type: "text", text: "done" }],
				details: {
					mode: "parallel",
					runId: ids[2],
					results: [
						{
							agent: "parent",
							task: "parent task",
							exitCode: 0,
							messages: [],
							usage,
							progress: {
								index: 0,
								agent: "parent",
								status: "completed",
								task: "parent task",
								recentTools: [
									{
										tool: "subagent",
										args: childTask,
										rawArgs: { agent: "explorer", task: childTask, label: "done child" },
										endMs: 2_250,
									},
								],
								recentOutput: [],
								toolCount: 1,
								tokens: 0,
								durationMs: 1_250,
							},
						},
					],
				},
			},
			{ expanded: false },
			theme,
		);

		const text = widget.render(140).join("\n");
		assert.match(text, /Agent 1: parent · 1 tool use · 1\.3s · 1 subagent/);
		assert.doesNotMatch(text, /← subagent: You are the nested SYNC child/);
	});
});
