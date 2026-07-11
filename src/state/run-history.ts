import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

interface RunEntry {
	agent: string;
	task: string;
	ts: number;
	status: "ok" | "error";
	duration: number;
	exit?: number;
}

const HISTORY_PATH = path.join(getAgentDir(), "run-history.jsonl");

export function recordRun(agent: string, task: string, exitCode: number, durationMs: number): void {
	try {
		const entry: RunEntry = {
			agent,
			task: task.slice(0, 200),
			ts: Math.floor(Date.now() / 1000),
			status: exitCode === 0 ? "ok" : "error",
			duration: durationMs,
			...(exitCode !== 0 ? { exit: exitCode } : {}),
		};
		fs.mkdirSync(path.dirname(HISTORY_PATH), { recursive: true });
		fs.appendFileSync(HISTORY_PATH, `${JSON.stringify(entry)}\n`);
	} catch {
		// Best-effort — never crash the execution flow for history recording
	}
}
