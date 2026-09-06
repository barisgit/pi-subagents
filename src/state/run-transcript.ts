import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { type PersistedRunStatus, parsePersistedRunStatus } from "../protocol/status-types.ts";
import { readRunTranscriptPreview, writeRunTranscriptPreview } from "./run-transcript-preview.ts";

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
	| { kind: "assistant-text"; stepIndex: number; text: string; ts: number; outputEligible?: false }
	| {
			kind: "step-end";
			stepIndex: number;
			agent: string;
			ts: number;
			durationMs?: number;
			tokens?: number;
			status?: string;
	  }
	| { kind: "final-text"; stepIndex: number; agent: string; text: string; outputEligible?: false };

interface CacheFileStat {
	filePath: string;
	mtimeMs: number;
	size: number;
}

interface CacheEntry {
	files: CacheFileStat[];
	lines: TranscriptLine[];
	sourceBytes: number;
}

const cache = new Map<string, CacheEntry>();
const TRANSCRIPT_CACHE_MAX_ENTRIES = 32;
const TRANSCRIPT_CACHE_MAX_SOURCE_BYTES = 32 * 1024 * 1024;
const ARGS_PREVIEW_MAX = 60;

function cacheTranscript(runRecordDir: string, entry: CacheEntry): void {
	cache.delete(runRecordDir);
	cache.set(runRecordDir, entry);
	let sourceBytes = [...cache.values()].reduce((total, cached) => total + cached.sourceBytes, 0);
	while (
		cache.size > 1 &&
		(cache.size > TRANSCRIPT_CACHE_MAX_ENTRIES || sourceBytes > TRANSCRIPT_CACHE_MAX_SOURCE_BYTES)
	) {
		const oldest = cache.keys().next().value;
		if (oldest === undefined) break;
		const evicted = cache.get(oldest);
		cache.delete(oldest);
		sourceBytes -= evicted?.sourceBytes ?? 0;
	}
}

export interface RunMessageSession {
	stepIndex: number;
	messages: AgentMessage[];
}

interface RunMessageCacheEntry {
	files: CacheFileStat[];
	sessions: RunMessageSession[];
	sourceBytes: number;
}

/** Dashboard-owned reader for typed messages on each persisted session branch. */
export class RunMessageReader {
	private readonly cache = new Map<string, RunMessageCacheEntry>();
	private readonly maxEntries: number;
	private readonly maxSourceBytes: number;

	constructor(options: { maxEntries?: number; maxSourceBytes?: number } = {}) {
		this.maxEntries = options.maxEntries ?? 10;
		this.maxSourceBytes = options.maxSourceBytes ?? 32 * 1024 * 1024;
	}

	readPreview(runRecordDir: string): RunMessageSession[] {
		const status = readStatusFile(path.join(runRecordDir, "status.json"));
		return discoverSessionFiles(runRecordDir, status).flatMap((session) => {
			const preview = readRunTranscriptPreview(session.filePath);
			return preview && preview.messages.length > 0
				? [{ stepIndex: session.stepIndex, messages: preview.messages }]
				: [];
		});
	}

	peek(runRecordDir: string): RunMessageSession[] | undefined {
		const cached = this.cache.get(runRecordDir);
		if (!cached) return undefined;
		const statusPath = path.join(runRecordDir, "status.json");
		const status = readStatusFile(statusPath);
		const stats = [
			fileStat(statusPath),
			...discoverSessionFiles(runRecordDir, status).map((session) => fileStat(session.filePath)),
		].filter((stat): stat is CacheFileStat => Boolean(stat));
		if (!sameFileStats(cached.files, stats)) {
			this.cache.delete(runRecordDir);
			return undefined;
		}
		this.touch(runRecordDir, cached);
		return cached.sessions;
	}

	read(runRecordDir: string): RunMessageSession[] {
		const statusPath = path.join(runRecordDir, "status.json");
		const status = readStatusFile(statusPath);
		const sessionFiles = discoverSessionFiles(runRecordDir, status);
		if (sessionFiles.length === 0) {
			this.cache.delete(runRecordDir);
			return [];
		}
		const stats = [fileStat(statusPath), ...sessionFiles.map((session) => fileStat(session.filePath))].filter(
			(stat): stat is CacheFileStat => Boolean(stat),
		);
		const cached = this.cache.get(runRecordDir);
		if (cached && sameFileStats(cached.files, stats)) {
			this.touch(runRecordDir, cached);
			return cached.sessions;
		}

		const sessions: RunMessageSession[] = [];
		try {
			for (const sessionFile of sessionFiles) {
				const manager = SessionManager.open(sessionFile.filePath);
				const messages = manager
					.getBranch()
					.filter((entry) => entry.type === "message")
					.map((entry) => entry.message);
				if (messages.length > 0) {
					sessions.push({ stepIndex: sessionFile.stepIndex, messages });
					writeRunTranscriptPreview(sessionFile.filePath, sessionFile.stepIndex, messages);
				}
			}
		} catch {
			this.cache.delete(runRecordDir);
			return [];
		}
		const entry = {
			files: stats,
			sessions,
			sourceBytes: stats.reduce((total, stat) => total + stat.size, 0),
		};
		this.touch(runRecordDir, entry);
		this.evict();
		return sessions;
	}

	private touch(runRecordDir: string, entry: RunMessageCacheEntry): void {
		this.cache.delete(runRecordDir);
		this.cache.set(runRecordDir, entry);
	}

	private evict(): void {
		let sourceBytes = [...this.cache.values()].reduce((total, entry) => total + entry.sourceBytes, 0);
		while (this.cache.size > 1 && (this.cache.size > this.maxEntries || sourceBytes > this.maxSourceBytes)) {
			const oldest = this.cache.keys().next().value;
			if (oldest === undefined) break;
			const entry = this.cache.get(oldest);
			this.cache.delete(oldest);
			sourceBytes -= entry?.sourceBytes ?? 0;
		}
	}
}

function previewArgs(args: unknown, maxLength = ARGS_PREVIEW_MAX): string {
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

function readStatusFile(filePath: string): PersistedRunStatus | undefined {
	try {
		const parsed = parsePersistedRunStatus(fs.readFileSync(filePath, "utf-8"));
		return parsed.ok ? parsed.value : undefined;
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
	const byStep = new Map<number, string>();
	// Scan <runRecordDir>/run-N/session.jsonl for older steps written before the
	// sessionFile field was added to status.json.
	try {
		for (const entry of fs.readdirSync(runRecordDir)) {
			const match = /^run-(\d+)$/.exec(entry);
			if (!match) continue;
			const stepIndex = Number(match[1]);
			if (!Number.isInteger(stepIndex) || stepIndex < 0) continue;
			const filePath = path.join(runRecordDir, entry, "session.jsonl");
			if (fs.existsSync(filePath)) byStep.set(stepIndex, filePath);
		}
	} catch {
		// Explicit session files may still live outside a missing run record directory.
	}

	// Prefer each step's explicit sessionFile when present. This is the only
	// correct path when a session file lives outside <runRecordDir>/run-N/.
	for (const [stepIndex, step] of (status?.steps ?? []).entries()) {
		const filePath = step?.sessionFile;
		if (typeof filePath === "string" && filePath && fs.existsSync(filePath)) {
			byStep.set(stepIndex, filePath);
		}
	}

	return [...byStep.entries()]
		.map(([stepIndex, filePath]) => ({ stepIndex, filePath }))
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
			const outputEligible = !content.some((part) => {
				const item = objectRecord(part);
				return item?.type === "tool_use" || item?.type === "toolUse" || item?.type === "toolCall";
			});
			for (const part of content) {
				const item = objectRecord(part);
				if (!item) continue;
				const type = item.type;
				if (type === "text") {
					const text = item.text;
					if (typeof text === "string" && text.trim()) {
						// Every non-empty assistant text survives as narration; the LAST one
						// is peeled off below as the run's final-text.
						out.push({
							kind: "assistant-text",
							stepIndex: input.stepIndex,
							text,
							ts,
							...(!outputEligible ? { outputEligible: false as const } : {}),
						});
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
	let finalOutputEligible = true;
	if (lastAssistantTextIndex >= 0) {
		const last = out[lastAssistantTextIndex];
		if (last?.kind === "assistant-text") {
			finalText = last.text;
			finalOutputEligible = last.outputEligible !== false;
		}
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
	if (finalText)
		lines.push({
			kind: "final-text",
			stepIndex: input.stepIndex,
			agent,
			text: finalText,
			...(!finalOutputEligible ? { outputEligible: false as const } : {}),
		});
	return lines;
}

/** Already-parsed transcript for a run record, or undefined when nothing has
 * been parsed yet. Pure cache lookup: no stat, read, or parse, so callers on the
 * render path can consult it without touching the disk. */
export function peekRunTranscript(runRecordDir: string): TranscriptLine[] | undefined {
	return cache.get(runRecordDir)?.lines;
}

export function readRunTranscript(runRecordDir: string): TranscriptLine[] {
	const statusPath = path.join(runRecordDir, "status.json");
	// Read status FIRST so discovery can use it to find session files that live
	// outside <runRecordDir>/run-N/ (e.g. fork-reuse sharing the parent's file).
	const status = readStatusFile(statusPath);
	const sessionFiles = discoverSessionFiles(runRecordDir, status);
	const stats = [fileStat(statusPath), ...sessionFiles.map((session) => fileStat(session.filePath))].filter(
		(stat): stat is CacheFileStat => Boolean(stat),
	);
	if (sessionFiles.length === 0) {
		cache.delete(runRecordDir);
		return [];
	}
	const cached = cache.get(runRecordDir);
	if (cached && sameFileStats(cached.files, stats)) {
		cacheTranscript(runRecordDir, cached);
		return cached.lines;
	}

	const lines = sessionFiles.flatMap((session) => parseSessionFile({ ...session, status }));
	cacheTranscript(runRecordDir, {
		files: stats,
		lines,
		sourceBytes: stats.reduce((total, stat) => total + stat.size, 0),
	});
	return lines;
}
