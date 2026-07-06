import * as fs from "node:fs";
import * as path from "node:path";
import type { PersistedRunStatus } from "../protocol/status-types.ts";
import { extractOutputBlockForDisplay } from "../protocol/output-contract.ts";

export type TranscriptLine =
	| { kind: "step-start"; stepIndex: number; agent: string; ts: number; task?: string; label?: string }
	| {
			kind: "tool";
			stepIndex: number;
			toolName: string;
			argsPreview: string;
			rawArgs?: Record<string, unknown>;
			durationMs?: number;
			resultHint?: string;
			resultLineCount?: number;
			isError?: boolean;
			ts: number;
	  }
	| { kind: "assistant-text"; stepIndex: number; text: string; ts: number }
	| {
			kind: "step-end";
			stepIndex: number;
			agent: string;
			ts: number;
			durationMs?: number;
			tokens?: number;
			status?: string;
	  }
	| { kind: "final-text"; stepIndex: number; agent: string; text: string };

interface CacheFileStat {
	filePath: string;
	mtimeMs: number;
	size: number;
}

interface CacheEntry {
	files: CacheFileStat[];
	lines: TranscriptLine[];
}

const cache = new Map<string, CacheEntry>();
const ARGS_PREVIEW_MAX = 60;

export function previewArgs(args: unknown, maxLength = ARGS_PREVIEW_MAX): string {
	if (args === undefined || args === null) return "";
	let json: string;
	try {
		json = JSON.stringify(args);
	} catch {
		return "";
	}
	if (!json) return "";
	const limit = Math.max(1, maxLength);
	if (json.length <= limit) return json;
	return `${json.slice(0, Math.max(0, limit - 1))}…`;
}

function readJsonFile<T>(filePath: string): T | undefined {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
	} catch {
		return undefined;
	}
}

function fileStat(filePath: string): CacheFileStat | undefined {
	try {
		const stat = fs.statSync(filePath);
		return { filePath, mtimeMs: stat.mtimeMs, size: stat.size };
	} catch {
		return undefined;
	}
}

function sameFileStats(a: CacheFileStat[], b: CacheFileStat[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		const left = a[i]!;
		const right = b[i]!;
		if (left.filePath !== right.filePath || left.mtimeMs !== right.mtimeMs || left.size !== right.size)
			return false;
	}
	return true;
}

function discoverSessionFiles(
	runRecordDir: string,
	status?: PersistedRunStatus,
): Array<{ stepIndex: number; filePath: string }> {
	// 1. Prefer explicit per-step sessionFile recorded in status.json. This is the
	//    only correct path when fork-reuse runs share the parent's session file
	//    (which lives outside <runRecordDir>/run-N/).
	const fromStatus: Array<{ stepIndex: number; filePath: string }> = [];
	const stepSlots = status?.steps;
	if (Array.isArray(stepSlots)) {
		for (let i = 0; i < stepSlots.length; i++) {
			const raw = stepSlots[i]?.sessionFile;
			if (typeof raw === "string" && raw && fs.existsSync(raw)) {
				fromStatus.push({ stepIndex: i, filePath: raw });
			}
		}
	}
	if (fromStatus.length > 0) return fromStatus.sort((a, b) => a.stepIndex - b.stepIndex);

	// 2. Fall back to scanning <runRecordDir>/run-N/session.jsonl for older runs
	//    written before the sessionFile field was added to status.json.
	let entries: string[];
	try {
		entries = fs.readdirSync(runRecordDir);
	} catch {
		return [];
	}
	return entries
		.map((entry) => {
			const match = /^run-(\d+)$/.exec(entry);
			if (!match) return undefined;
			const stepIndex = Number(match[1]);
			if (!Number.isInteger(stepIndex) || stepIndex < 0) return undefined;
			const filePath = path.join(runRecordDir, entry, "session.jsonl");
			return fs.existsSync(filePath) ? { stepIndex, filePath } : undefined;
		})
		.filter((entry): entry is { stepIndex: number; filePath: string } => Boolean(entry))
		.sort((a, b) => a.stepIndex - b.stepIndex);
}

function timestampMs(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "string") return undefined;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function recordTimestamp(record: Record<string, unknown>): number {
	return timestampMs(record.timestamp) ?? 0;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function rawArgsFrom(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

// First result lines for the dim "↳ …" hint the detail pane renders under
// each tool card. Trim only blank edge lines; content lines stay verbatim.
const RESULT_HINT_MAX = 400;
function resultPreview(text: string): { hint: string; lineCount: number } | undefined {
	const lines = text.split("\n");
	while (lines.length > 0 && lines[0]?.trim() === "") lines.shift();
	while (lines.length > 0 && lines[lines.length - 1]?.trim() === "") lines.pop();
	if (lines.length === 0) return undefined;
	const shown = lines
		.slice(0, 3)
		.map((line) => (line.length > RESULT_HINT_MAX ? `${line.slice(0, RESULT_HINT_MAX - 1)}…` : line));
	return { hint: shown.join("\n"), lineCount: lines.length };
}

function textFromToolResultContent(value: unknown): string {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return "";
	const texts: string[] = [];
	for (const part of value) {
		const record = objectRecord(part);
		if (!record) continue;
		const text = record.text;
		if (typeof text === "string") texts.push(text);
	}
	return texts.join("");
}

// Resolve a tool result against its pending tool_use entry: duration, first
// result line for the ↳ hint, and the error flag when the record carries one.
function resolveToolResult(
	out: TranscriptLine[],
	toolStartIndex: Map<string, number>,
	id: string,
	ts: number,
	content: unknown,
	isError: unknown,
): void {
	const idx = toolStartIndex.get(id);
	if (idx === undefined) return;
	const start = out[idx];
	if (start?.kind === "tool") {
		start.durationMs = Math.max(0, ts - start.ts);
		const preview = resultPreview(textFromToolResultContent(content));
		if (preview) {
			start.resultHint = preview.hint;
			start.resultLineCount = preview.lineCount;
		}
		if (isError === true) start.isError = true;
	}
	toolStartIndex.delete(id);
}

function stepInfo(
	status: PersistedRunStatus | undefined,
	stepIndex: number,
): NonNullable<PersistedRunStatus["steps"]>[number] | undefined {
	return status?.steps?.[stepIndex];
}

function isTerminalStepStatus(status: string | undefined): boolean {
	return (
		status === "complete" ||
		status === "completed" ||
		status === "failed" ||
		status === "skipped" ||
		status === "paused" ||
		status === "lost"
	);
}

function parseSessionFile(input: {
	filePath: string;
	stepIndex: number;
	status?: PersistedRunStatus;
}): TranscriptLine[] {
	let raw: string;
	try {
		raw = fs.readFileSync(input.filePath, "utf-8");
	} catch {
		return [];
	}
	const out: TranscriptLine[] = [];
	const toolStartIndex = new Map<string, number>();
	let lastAssistantTextIndex = -1;
	let firstMessageTs: number | undefined;
	// First user-role message's plain text is the initial prompt the subagent received.
	// Captured once and threaded onto step-start so the right pane can render it.
	let initialPrompt: string | undefined;

	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let record: Record<string, unknown>;
		try {
			record = JSON.parse(trimmed) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (record.type !== "message") continue;
		const ts = recordTimestamp(record);
		firstMessageTs ??= ts;
		const message = objectRecord(record.message);
		if (!message) continue;
		const role = message.role;
		const content = Array.isArray(message.content) ? message.content : [];
		if (role === "assistant") {
			for (const part of content) {
				const item = objectRecord(part);
				if (!item) continue;
				const type = item.type;
				if (type === "text") {
					const text = item.text;
					if (typeof text === "string" && text.trim()) {
						// Every non-empty assistant text survives as narration; the LAST one
						// is peeled off below as the run's final-text.
						out.push({ kind: "assistant-text", stepIndex: input.stepIndex, text, ts });
						lastAssistantTextIndex = out.length - 1;
					}
					continue;
				}
				if (type === "tool_use" || type === "toolUse" || type === "toolCall") {
					const id =
						typeof item.id === "string"
							? item.id
							: typeof item.toolCallId === "string"
								? item.toolCallId
								: "";
					const toolName = typeof item.name === "string" ? item.name : "";
					if (!toolName) continue;
					const rawArgs = rawArgsFrom(item.input) ?? rawArgsFrom(item.arguments);
					const entry: TranscriptLine = {
						kind: "tool",
						stepIndex: input.stepIndex,
						toolName,
						argsPreview: previewArgs(rawArgs),
						...(rawArgs ? { rawArgs } : {}),
						ts,
					};
					out.push(entry);
					if (id) toolStartIndex.set(id, out.length - 1);
				}
			}
			continue;
		}
		// Real pi session files persist tool results as dedicated `toolResult`
		// messages (toolCallId + content + isError) rather than user-role
		// tool_result parts; resolve them through the same funnel.
		if (role === "toolResult") {
			const id = typeof message.toolCallId === "string" ? message.toolCallId : "";
			if (id) resolveToolResult(out, toolStartIndex, id, ts, message.content, message.isError);
			continue;
		}

		if (role === "user") {
			if (initialPrompt === undefined) {
				const texts: string[] = [];
				for (const part of content) {
					const item = objectRecord(part);
					if (!item) continue;
					if (item.type === "text" && typeof item.text === "string" && item.text.trim())
						texts.push(item.text);
				}
				if (texts.length > 0) initialPrompt = texts.join("\n\n").trim();
			}
			for (const part of content) {
				const item = objectRecord(part);
				if (!item) continue;
				const type = item.type;
				if (type !== "tool_result" && type !== "toolResult") continue;
				const id =
					typeof item.tool_use_id === "string"
						? item.tool_use_id
						: typeof item.toolUseId === "string"
							? item.toolUseId
							: typeof item.toolCallId === "string"
								? item.toolCallId
								: typeof item.id === "string"
									? item.id
									: "";
				if (!id) continue;
				resolveToolResult(out, toolStartIndex, id, ts, item.content, item.isError ?? item.is_error);
			}
		}
	}

	// The LAST assistant text is the run's final message: peel it out of the feed
	// so final-text semantics stay unchanged and narration is never doubled.
	let finalText = "";
	if (lastAssistantTextIndex >= 0) {
		const last = out[lastAssistantTextIndex];
		if (last?.kind === "assistant-text") finalText = last.text;
		out.splice(lastAssistantTextIndex, 1);
	}

	const step = stepInfo(input.status, input.stepIndex);
	const agent = step?.agent ?? "";
	const startTs =
		step?.startedAt ?? (input.stepIndex === 0 ? input.status?.startedAt : undefined) ?? firstMessageTs ?? 0;
	const endTs =
		step?.endedAt ??
		(input.stepIndex === 0 ? input.status?.endedAt : undefined) ??
		input.status?.lastUpdate ??
		Date.now();
	const tokens = step?.tokens?.total ?? (input.stepIndex === 0 ? input.status?.totalTokens?.total : undefined);
	const status = step?.status ?? input.status?.state;
	const lines: TranscriptLine[] = [
		{
			kind: "step-start",
			stepIndex: input.stepIndex,
			agent,
			ts: startTs,
			...(step?.label
				? { label: step.label }
				: input.stepIndex === 0 && input.status?.label
					? { label: input.status.label }
					: {}),
			...(initialPrompt ? { task: initialPrompt } : {}),
		},
		...out,
	];
	if (isTerminalStepStatus(status)) {
		lines.push({
			kind: "step-end",
			stepIndex: input.stepIndex,
			agent,
			ts: endTs,
			...(step?.durationMs !== undefined
				? { durationMs: step.durationMs }
				: startTs
					? { durationMs: Math.max(0, endTs - startTs) }
					: {}),
			...(tokens !== undefined ? { tokens } : {}),
			...(status ? { status } : {}),
		});
	}
	// The last assistant text is the full final message, which carries the agent's
	// preamble/narration around its trailing <output> block. The dashboard final-text
	// surface only wants the result, so leniently strip to the last <output> block
	// (a message with no block passes through unchanged).
	const finalDisplay = finalText ? (extractOutputBlockForDisplay(finalText) ?? finalText) : finalText;
	if (finalDisplay) lines.push({ kind: "final-text", stepIndex: input.stepIndex, agent, text: finalDisplay });
	return lines;
}

export function readRunTranscript(runRecordDir: string): TranscriptLine[] {
	const statusPath = path.join(runRecordDir, "status.json");
	// Read status FIRST so discovery can use it to find session files that live
	// outside <runRecordDir>/run-N/ (e.g. fork-reuse sharing the parent's file).
	const status = readJsonFile<PersistedRunStatus>(statusPath);
	const sessionFiles = discoverSessionFiles(runRecordDir, status);
	const stats = [fileStat(statusPath), ...sessionFiles.map((session) => fileStat(session.filePath))].filter(
		(stat): stat is CacheFileStat => Boolean(stat),
	);
	if (sessionFiles.length === 0) {
		cache.delete(runRecordDir);
		return [];
	}
	const cached = cache.get(runRecordDir);
	if (cached && sameFileStats(cached.files, stats)) return cached.lines;

	const lines = sessionFiles.flatMap((session) => parseSessionFile({ ...session, status }));
	cache.set(runRecordDir, { files: stats, lines });
	return lines;
}
