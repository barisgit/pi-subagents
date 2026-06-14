import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { appendRunEntry, setRegistryPathForTests } from "../../src/state/runs-registry.ts";
import { type AsyncStatus } from "../../src/protocol/types.ts";
import { RUNS_DIR } from "../../src/shared/runtime-paths.ts";

const registryPath = path.join(os.tmpdir(), `pi-inline-registry-${process.pid}.jsonl`);

function useInlineRegistry(): void {
	setRegistryPathForTests(registryPath);
}

export function writeRun(id: string, opts: {
	parentRunId?: string;
	state?: AsyncStatus["state"];
	agent?: string;
	label?: string;
	startedAt?: number;
	endedAt?: number;
	tokens?: number;
	events?: Array<Record<string, unknown>>;
} = {}): string {
	useInlineRegistry();
	const dir = path.join(RUNS_DIR, id);
	fs.mkdirSync(dir, { recursive: true });
	const startedAt = opts.startedAt ?? Date.now() - 1_500;
	const endedAt = opts.endedAt ?? Date.now();
	const state = opts.state ?? "running";
	const status: AsyncStatus = {
		runId: id,
		...(opts.parentRunId ? { parentRunId: opts.parentRunId } : {}),
		mode: "single",
		...(opts.label ? { label: opts.label } : {}),
		state,
		startedAt,
		lastUpdate: endedAt,
		...(state === "running" ? {} : { endedAt }),
		steps: [{ agent: opts.agent ?? "fixer", status: state === "running" ? "running" : state, tokens: opts.tokens ? { input: 0, output: opts.tokens, total: opts.tokens } : undefined }],
		...(opts.tokens ? { totalTokens: { input: 0, output: opts.tokens, total: opts.tokens } } : {}),
	};
	fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify(status), "utf-8");
	const sessionDir = path.join(dir, "run-0");
	fs.mkdirSync(sessionDir, { recursive: true });
	const messages = (opts.events ?? []).filter((event) => event.type === "tool_execution_start").map((event) => ({
		type: "message",
		timestamp: new Date(typeof event.observedAt === "number" ? event.observedAt : Date.now()).toISOString(),
		message: { role: "assistant", content: [{ type: "tool_use", id: event.toolCallId, name: event.toolName, input: event.args }] },
	}));
	fs.writeFileSync(path.join(sessionDir, "session.jsonl"), [{ type: "session", version: 3, id, timestamp: new Date(startedAt).toISOString(), cwd: process.cwd() }, ...messages].map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
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
	return dir;
}

export function rmRun(id: string): void {
	fs.rmSync(path.join(RUNS_DIR, id), { recursive: true, force: true });
	setRegistryPathForTests(null);
}

export function tool(toolName: string, args: Record<string, unknown>, ts = 1_100): Record<string, unknown> {
	return { type: "tool_execution_start", subagentStepIndex: 0, toolName, toolCallId: `${toolName}-${ts}`, args, observedAt: ts };
}
