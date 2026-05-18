import * as fs from "node:fs";
import * as path from "node:path";
import { appendJsonl } from "./artifacts.ts";
import { ASYNC_DIR, type AsyncStatus, type TokenUsage } from "./types.ts";

const MIN_UPDATE_INTERVAL_MS = 250;
const lastWriteByRun = new Map<string, number>();

export interface SyncRunStepInit {
	agent: string;
	label?: string;
	task?: string;
}

export function ensureSyncRunDir(runId: string): string {
	const dir = path.join(ASYNC_DIR, runId);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

function statusPath(runId: string): string {
	return path.join(ensureSyncRunDir(runId), "status.json");
}

function writeStatus(runId: string, status: AsyncStatus): void {
	fs.writeFileSync(statusPath(runId), JSON.stringify(status, null, 2), "utf-8");
	lastWriteByRun.set(runId, Date.now());
}

function readStatus(runId: string): AsyncStatus {
	return JSON.parse(fs.readFileSync(statusPath(runId), "utf-8")) as AsyncStatus;
}

function mergeValue(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
	for (const [key, value] of Object.entries(source)) {
		if (value === undefined) continue;
		if (Array.isArray(value)) {
			const existing = Array.isArray(target[key]) ? [...(target[key] as unknown[])] : [];
			for (let i = 0; i < value.length; i++) {
				const next = value[i];
				if (next && typeof next === "object" && !Array.isArray(next) && existing[i] && typeof existing[i] === "object" && !Array.isArray(existing[i])) {
					existing[i] = mergeValue({ ...(existing[i] as Record<string, unknown>) }, next as Record<string, unknown>);
				} else if (next !== undefined) {
					existing[i] = next;
				}
			}
			target[key] = existing;
		} else if (value && typeof value === "object" && !Array.isArray(value) && target[key] && typeof target[key] === "object" && !Array.isArray(target[key])) {
			target[key] = mergeValue({ ...(target[key] as Record<string, unknown>) }, value as Record<string, unknown>);
		} else {
			target[key] = value;
		}
	}
	return target;
}

export function writeSyncRunStatusStart(runId: string, init: {
	mode: AsyncStatus["mode"];
	startedAt?: number;
	cwd?: string;
	label?: string;
	parentRunId?: string;
	steps: SyncRunStepInit[];
}): void {
	const startedAt = init.startedAt ?? Date.now();
	// charter nested-subagent-display: sync runs now enter the async status pipeline.
	writeStatus(runId, {
		runId,
		...(init.parentRunId ? { parentRunId: init.parentRunId } : {}),
		mode: init.mode,
		...(init.label ? { label: init.label } : {}),
		state: "running",
		startedAt,
		lastUpdate: startedAt,
		runnerHeartbeatAt: startedAt,
		pid: process.pid,
		...(init.cwd ? { cwd: init.cwd } : {}),
		currentStep: 0,
		steps: init.steps.map((step) => ({
			agent: step.agent,
			...(step.label ? { label: step.label } : {}),
			status: "pending",
		})),
	});
}

export function writeSyncRunStatusUpdate(runId: string, patch: Partial<AsyncStatus>, options: { flush?: boolean } = {}): void {
	let current: AsyncStatus;
	try {
		current = readStatus(runId);
	} catch {
		return;
	}
	const now = Date.now();
	const terminal = patch.state === "complete" || patch.state === "failed" || patch.state === "paused";
	const lastWrite = lastWriteByRun.get(runId) ?? 0;
	if (!options.flush && !terminal && lastWrite > 0 && now - lastWrite < MIN_UPDATE_INTERVAL_MS) return;
	const merged = mergeValue({ ...current }, { ...patch, lastUpdate: patch.lastUpdate ?? now, runnerHeartbeatAt: patch.runnerHeartbeatAt ?? now }) as AsyncStatus;
	writeStatus(runId, merged);
}

export function writeSyncRunStatusEnd(runId: string, end: {
	state?: "complete" | "failed";
	steps?: Array<Partial<NonNullable<AsyncStatus["steps"]>[number]>>;
	totalTokens?: TokenUsage;
	sessionFile?: string;
}): void {
	let current: AsyncStatus;
	try {
		current = readStatus(runId);
	} catch {
		return;
	}
	const endedAt = Date.now();
	const steps = (current.steps ?? []).map((step, index) => {
		const patch = end.steps?.[index] ?? {};
		const status = patch.status ?? (end.state === "failed" ? "failed" : step.status === "failed" ? "failed" : "complete");
		const startedAt = patch.startedAt ?? step.startedAt ?? current.startedAt;
		return {
			...step,
			...patch,
			status,
			endedAt: patch.endedAt ?? endedAt,
			durationMs: patch.durationMs ?? (startedAt ? endedAt - startedAt : undefined),
		};
	});
	writeStatus(runId, {
		...current,
		state: end.state ?? "complete",
		activityState: undefined,
		currentTool: undefined,
		currentToolStartedAt: undefined,
		endedAt,
		lastUpdate: endedAt,
		runnerHeartbeatAt: endedAt,
		steps,
		...(end.totalTokens ? { totalTokens: end.totalTokens } : {}),
		...(end.sessionFile ? { sessionFile: end.sessionFile } : {}),
	});
}

function eventsPath(runId: string): string {
	return path.join(ensureSyncRunDir(runId), "events.jsonl");
}

export function appendSyncRunStepStart(runId: string, stepIndex: number, agent: string, ts = Date.now(), task?: string, label?: string): void {
	appendJsonl(eventsPath(runId), JSON.stringify({ type: "subagent.step.started", ts, runId, stepIndex, agent, ...(task ? { task } : {}), ...(label ? { label } : {}) }));
}

export function appendSyncRunTool(runId: string, stepIndex: number, toolName: string, rawArgs: Record<string, unknown> | undefined, ts = Date.now(), durationMs?: number): void {
	const toolCallId = `${stepIndex}:${toolName}:${ts}`;
	appendJsonl(eventsPath(runId), JSON.stringify({ type: "tool_execution_start", observedAt: ts, subagentRunId: runId, subagentStepIndex: stepIndex, toolCallId, toolName, args: rawArgs ?? {} }));
	if (durationMs !== undefined) {
		appendJsonl(eventsPath(runId), JSON.stringify({ type: "tool_execution_end", observedAt: ts + durationMs, subagentRunId: runId, subagentStepIndex: stepIndex, toolCallId, toolName }));
	}
}

export function appendSyncRunStepEnd(runId: string, stepIndex: number, agent: string, ts = Date.now(), status?: string, tokens?: TokenUsage, durationMs?: number): void {
	appendJsonl(eventsPath(runId), JSON.stringify({ type: status === "failed" ? "subagent.step.failed" : "subagent.step.completed", ts, runId, stepIndex, agent, ...(status ? { status } : {}), ...(tokens ? { tokens } : {}), ...(durationMs !== undefined ? { durationMs } : {}) }));
}

export function appendSyncRunFinalText(runId: string, stepIndex: number, agent: string, text: string): void {
	if (!text) return;
	appendJsonl(eventsPath(runId), JSON.stringify({ type: "message_end", subagentRunId: runId, subagentStepIndex: stepIndex, subagentAgent: agent, message: { role: "assistant", content: [{ type: "text", text }] } }));
}
