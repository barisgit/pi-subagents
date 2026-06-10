import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import type { SubagentToolInput as SubagentParamsLike, Task } from "./schemas.ts";
import type { SlashSubagentResponse, SlashSubagentUpdate } from "./slash-bridge.ts";
import { type Details, type SingleResult, type Usage, SLASH_RESULT_TYPE } from "./types.ts";

export interface SlashMessageDetails {
	requestId: string;
	result: AgentToolResult<Details>;
}

interface SlashSnapshot {
	result: AgentToolResult<Details>;
	version: number;
}

const liveSnapshots = new Map<string, SlashSnapshot>();
const finalSnapshots = new Map<string, SlashSnapshot>();
let versionCounter = 1;

const EMPTY_MESSAGES: Message[] = [];
const EMPTY_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	cost: 0,
	turns: 0,
};

function nextVersion(): number {
	return versionCounter++;
}

function cloneUsage(): Usage {
	return { ...EMPTY_USAGE };
}

function createPlaceholderResult(
	agent: string,
	task: string,
	status: "pending" | "running",
	index?: number,
): SingleResult {
	return {
		agent,
		task,
		exitCode: 0,
		messages: EMPTY_MESSAGES,
		usage: cloneUsage(),
		progress: {
			...(index !== undefined ? { index } : {}),
			agent,
			status,
			task,
			recentTools: [],
			recentOutput: [],
			toolCount: 0,
			tokens: 0,
			durationMs: 0,
		},
	};
}

function applySharedMessage(message: string | undefined, task: string): string {
	if (!message) return task;
	return message.includes("{in}") ? message.replace("{in}", task) : `${message}\n\n${task}`;
}

function taskWithMessage(task: Task, message: string | undefined): Task {
	return { ...task, task: applySharedMessage(message, task.task) };
}

function runTasks(params: SubagentParamsLike): Task[] {
	return (params.run ?? []).filter((step): step is Task => !Array.isArray(step)).map((task) => taskWithMessage(task, params.message));
}

function runContext(params: SubagentParamsLike): "fresh" | "fork" | undefined {
	return (params.run ?? []).find((task) => task.context !== undefined)?.context;
}

function buildParallelInitialResult(params: SubagentParamsLike): AgentToolResult<Details> {
	const tasks = runTasks(params);
	return {
		content: [{ type: "text", text: tasks.map((task) => `${task.agent}: ${task.task}`).join("\n\n") }],
		details: {
			mode: "parallel",
			...(runContext(params) ? { context: runContext(params) } : {}),
			results: tasks.map((task, index) => createPlaceholderResult(task.agent, task.task, "running", index)),
			progress: tasks.map((task, index) => ({
				index,
				agent: task.agent,
				status: "running" as const,
				task: task.task,
				recentTools: [],
				recentOutput: [],
				toolCount: 0,
				tokens: 0,
				durationMs: 0,
			})),
		},
	};
}

function buildSingleInitialResult(params: SubagentParamsLike): AgentToolResult<Details> {
	const first = runTasks(params)[0];
	const agent = first?.agent ?? "subagent";
	const task = first?.task ?? "";
	return {
		content: [{ type: "text", text: task }],
		details: {
			mode: "single",
			...(runContext(params) ? { context: runContext(params) } : {}),
			results: [createPlaceholderResult(agent, task, "running")],
			progress: [{
				agent,
				status: "running",
				task,
				recentTools: [],
				recentOutput: [],
				toolCount: 0,
				tokens: 0,
				durationMs: 0,
			}],
		},
	};
}

export function buildSlashInitialResult(requestId: string, params: SubagentParamsLike): SlashMessageDetails {
	const run = params.run ?? [];
	const result = run.length > 1
		? buildParallelInitialResult(params)
		: buildSingleInitialResult(params);
	liveSnapshots.set(requestId, { result, version: nextVersion() });
	finalSnapshots.delete(requestId);
	return { requestId, result };
}

function cloneResultsWithProgress(
	results: SingleResult[],
	progress: NonNullable<Details["progress"]> | undefined,
): SingleResult[] {
	return results.map((result, index) => {
		const nextProgress = progress?.find((entry) => entry.index === index)
			?? progress?.[index]
			?? result.progress;
		return nextProgress ? { ...result, progress: nextProgress } : result;
	});
}

export function applySlashUpdate(requestId: string, update: SlashSubagentUpdate): void {
	const snapshot = liveSnapshots.get(requestId);
	if (!snapshot) return;
	const progress = update.progress;
	if (!progress || !snapshot.result.details) return;
	const nextDetails: Details = {
		...snapshot.result.details,
		progress,
		results: cloneResultsWithProgress(snapshot.result.details.results, progress),
	};
	liveSnapshots.set(requestId, {
		result: {
			...snapshot.result,
			details: nextDetails,
		},
		version: nextVersion(),
	});
}

export function finalizeSlashResult(response: SlashSubagentResponse): SlashMessageDetails {
	const snapshot = {
		result: response.result,
		version: nextVersion(),
	};
	finalSnapshots.set(response.requestId, snapshot);
	liveSnapshots.delete(response.requestId);
	return {
		requestId: response.requestId,
		result: response.result,
	};
}

export function failSlashResult(requestId: string, params: SubagentParamsLike, message: string): SlashMessageDetails {
	const initial = buildSlashInitialResult(requestId, params).result;
	const failedResults = initial.details.results.map((result) => ({
		...result,
		exitCode: 1,
		error: message,
		progress: result.progress ? { ...result.progress, status: "failed" as const } : result.progress,
	}));
	const result: AgentToolResult<Details> = {
		content: [{ type: "text", text: message }],
		details: {
			...initial.details,
			results: failedResults,
			progress: failedResults.map((entry) => entry.progress!).filter(Boolean),
		},
	};
	const snapshot = { result, version: nextVersion() };
	finalSnapshots.set(requestId, snapshot);
	liveSnapshots.delete(requestId);
	return { requestId, result };
}

function isSlashMessageDetails(value: unknown): value is SlashMessageDetails {
	if (!value || typeof value !== "object") return false;
	const v = value as { requestId?: string; result?: { content?: unknown; details?: { results?: unknown } } };
	if (typeof v.requestId !== "string" || !v.requestId) return false;
	if (!v.result || !Array.isArray(v.result.content)) return false;
	return !!v.result.details && Array.isArray(v.result.details.results);
}

export function resolveSlashMessageDetails(value: unknown): SlashMessageDetails | undefined {
	return isSlashMessageDetails(value) ? value : undefined;
}

export function getSlashRenderableSnapshot(details: SlashMessageDetails): SlashSnapshot {
	return finalSnapshots.get(details.requestId)
		?? liveSnapshots.get(details.requestId)
		?? { result: details.result, version: 0 };
}

export function restoreSlashFinalSnapshots(entries: unknown[]): void {
	liveSnapshots.clear();
	finalSnapshots.clear();
	for (const entry of entries) {
		const e = entry as { type?: string; customType?: string; details?: unknown };
		if (e?.type !== "custom_message" || e.customType !== SLASH_RESULT_TYPE) continue;
		const details = resolveSlashMessageDetails(e.details);
		if (!details) continue;
		finalSnapshots.set(details.requestId, { result: details.result, version: nextVersion() });
	}
}

export function clearSlashSnapshots(): void {
	liveSnapshots.clear();
	finalSnapshots.clear();
}
