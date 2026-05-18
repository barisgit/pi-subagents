import * as fs from "node:fs";
import * as path from "node:path";
import { ASYNC_DIR, type AsyncStatus } from "../../types.ts";

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
	const dir = path.join(ASYNC_DIR, id);
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
	fs.writeFileSync(path.join(dir, "events.jsonl"), (opts.events ?? []).map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
	return dir;
}

export function rmRun(id: string): void {
	fs.rmSync(path.join(ASYNC_DIR, id), { recursive: true, force: true });
}

export function tool(toolName: string, args: Record<string, unknown>, ts = 1_100): Record<string, unknown> {
	return { type: "tool_execution_start", subagentStepIndex: 0, toolName, toolCallId: `${toolName}-${ts}`, args, observedAt: ts };
}
