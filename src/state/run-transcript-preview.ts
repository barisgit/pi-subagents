import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

export const RUN_TRANSCRIPT_PREVIEW_VERSION = 1;
export const RUN_TRANSCRIPT_PREVIEW_MAX_BYTES = 128 * 1024;
const CONTENT_TEXT_MAX = 8 * 1024;
const THINKING_TEXT_MAX = 512;
const PAYLOAD_TEXT_MAX = 512;

type JsonRecord = Record<string, unknown>;

export interface RunTranscriptPreview {
	version: typeof RUN_TRANSCRIPT_PREVIEW_VERSION;
	stepIndex: number;
	messages: AgentMessage[];
}

export function writeRunTranscriptPreview(
	sessionFile: string,
	stepIndex: number,
	messages: readonly unknown[],
): boolean {
	try {
		const preview = buildRunTranscriptPreview(stepIndex, messages);
		writePreviewAtomic(runTranscriptPreviewPath(sessionFile), JSON.stringify(preview));
		return true;
	} catch {
		return false;
	}
}

type PreviewTimer = ReturnType<typeof setTimeout>;

export type RunTranscriptPreviewParseResult = { ok: true; value: RunTranscriptPreview } | { ok: false; reason: string };

function record(value: unknown): JsonRecord | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : undefined;
}

function truncate(text: string, limit: number): string {
	return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function sanitizeValue(value: unknown, key: string, depth = 0): unknown {
	if (depth > 5) return undefined;
	if (typeof value === "string") {
		if (key === "thinking" || key === "reasoning") return truncate(value, THINKING_TEXT_MAX);
		if (key === "text" || key === "output") return truncate(value, CONTENT_TEXT_MAX);
		return truncate(value, PAYLOAD_TEXT_MAX);
	}
	if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
	if (Array.isArray(value)) {
		const out: unknown[] = [];
		for (const item of value.slice(0, 32)) {
			const itemRecord = record(item);
			if (
				itemRecord?.type === "image" ||
				itemRecord?.type === "image_url" ||
				itemRecord?.type === "thinking" ||
				itemRecord?.type === "reasoning"
			)
				continue;
			const sanitized = sanitizeValue(item, key, depth + 1);
			if (sanitized !== undefined) out.push(sanitized);
		}
		return out;
	}
	const input = record(value);
	if (!input) return undefined;
	const out: JsonRecord = {};
	for (const [childKey, childValue] of Object.entries(input)) {
		if (childKey === "data" && (input.type === "image" || input.type === "image_url")) continue;
		if (childKey === "details" || childKey === "usage") continue;
		const sanitized = sanitizeValue(childValue, childKey, depth + 1);
		if (sanitized !== undefined) out[childKey] = sanitized;
	}
	return out;
}

function isPreviewMessage(value: unknown): value is AgentMessage {
	const message = record(value);
	if (!message || typeof message.role !== "string") return false;
	if (!new Set(["user", "assistant", "toolResult", "bashExecution"]).has(message.role)) return false;
	const validContent = (content: unknown): boolean => {
		if (!Array.isArray(content)) return false;
		return content.every((part) => {
			const item = record(part);
			if (!item || typeof item.type !== "string") return false;
			if (item.type === "text") return typeof item.text === "string";
			if (item.type === "toolCall")
				return (
					typeof item.id === "string" && typeof item.name === "string" && record(item.arguments) !== undefined
				);
			return true;
		});
	};
	if (message.role === "assistant") return validContent(message.content);
	if (message.role === "toolResult")
		return (
			typeof message.toolCallId === "string" &&
			typeof message.toolName === "string" &&
			validContent(message.content) &&
			typeof message.isError === "boolean"
		);
	if (message.role === "user") return typeof message.content === "string" || validContent(message.content);
	return typeof message.command === "string" && typeof message.output === "string";
}

function sanitizeMessage(value: unknown): AgentMessage | undefined {
	const sanitized = sanitizeValue(value, "message");
	return isPreviewMessage(sanitized) ? sanitized : undefined;
}

function toolCallIds(message: AgentMessage): Set<string> {
	if (message.role !== "assistant") return new Set();
	return new Set(message.content.filter((part) => part.type === "toolCall").map((part) => part.id));
}

function messageGroups(messages: AgentMessage[]): AgentMessage[][] {
	const groups: AgentMessage[][] = [];
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index]!;
		const group = [message];
		const pending = toolCallIds(message);
		while (pending.size > 0 && index + 1 < messages.length) {
			const result = messages[index + 1]!;
			if (result.role !== "toolResult" || !pending.has(result.toolCallId)) break;
			group.push(result);
			pending.delete(result.toolCallId);
			index++;
		}
		groups.push(group);
	}
	return groups;
}

function serializedBytes(stepIndex: number, messages: AgentMessage[]): number {
	return Buffer.byteLength(JSON.stringify({ version: RUN_TRANSCRIPT_PREVIEW_VERSION, stepIndex, messages }), "utf8");
}

export function buildRunTranscriptPreview(stepIndex: number, input: readonly unknown[]): RunTranscriptPreview {
	const sanitized = input.map(sanitizeMessage).filter((message): message is AgentMessage => message !== undefined);
	const groups = messageGroups(sanitized);
	const retained: AgentMessage[][] = [];
	let retainedMessages = 0;
	let retainedBytes = serializedBytes(stepIndex, []);
	for (let index = groups.length - 1; index >= 0; index--) {
		const group = groups[index]!;
		const groupBytes = group.reduce(
			(total, message, messageIndex) =>
				total + Buffer.byteLength(JSON.stringify(message), "utf8") + (messageIndex === 0 ? 0 : 1),
			0,
		);
		const separatorBytes = retainedMessages > 0 && group.length > 0 ? 1 : 0;
		if (retainedBytes + separatorBytes + groupBytes > RUN_TRANSCRIPT_PREVIEW_MAX_BYTES) break;
		retained.unshift(group);
		retainedMessages += group.length;
		retainedBytes += separatorBytes + groupBytes;
	}
	return { version: RUN_TRANSCRIPT_PREVIEW_VERSION, stepIndex, messages: retained.flat() };
}

export function parseRunTranscriptPreview(input: string): RunTranscriptPreviewParseResult {
	let value: unknown;
	try {
		value = JSON.parse(input);
	} catch {
		return { ok: false, reason: "invalid JSON" };
	}
	const preview = record(value);
	if (
		!preview ||
		preview.version !== RUN_TRANSCRIPT_PREVIEW_VERSION ||
		typeof preview.stepIndex !== "number" ||
		!Number.isInteger(preview.stepIndex) ||
		preview.stepIndex < 0 ||
		!Array.isArray(preview.messages) ||
		!preview.messages.every(isPreviewMessage)
	) {
		return { ok: false, reason: "invalid transcript preview" };
	}
	if (Buffer.byteLength(input, "utf8") > RUN_TRANSCRIPT_PREVIEW_MAX_BYTES) {
		return { ok: false, reason: "transcript preview exceeds size limit" };
	}
	return {
		ok: true,
		value: {
			version: RUN_TRANSCRIPT_PREVIEW_VERSION,
			stepIndex: preview.stepIndex,
			messages: preview.messages,
		},
	};
}

export function runTranscriptPreviewPath(sessionFile: string): string {
	return path.join(path.dirname(sessionFile), "session.preview.json");
}

function writePreviewAtomic(filePath: string, content: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
	try {
		fs.writeFileSync(temporary, content, "utf8");
		fs.renameSync(temporary, filePath);
	} finally {
		try {
			fs.unlinkSync(temporary);
		} catch {
			// Atomic replacement already consumed the temporary file.
		}
	}
}

export function readRunTranscriptPreview(sessionFile: string): RunTranscriptPreview | undefined {
	try {
		const parsed = parseRunTranscriptPreview(fs.readFileSync(runTranscriptPreviewPath(sessionFile), "utf8"));
		return parsed.ok ? parsed.value : undefined;
	} catch {
		return undefined;
	}
}

export function cloneRunTranscriptPreview(
	sourceSessionFile: string,
	targetSessionFile: string,
	targetStepIndex?: number,
): boolean {
	const source = readRunTranscriptPreview(sourceSessionFile);
	if (!source) return false;
	const preview = targetStepIndex === undefined ? source : { ...source, stepIndex: targetStepIndex };
	try {
		writePreviewAtomic(runTranscriptPreviewPath(targetSessionFile), JSON.stringify(preview));
		return true;
	} catch {
		return false;
	}
}

export interface RunTranscriptPreviewWriter {
	schedule(): void;
	flush(): void;
	dispose(): void;
}

export function createRunTranscriptPreviewWriter(options: {
	sessionFile: string;
	stepIndex: number;
	getMessages: () => readonly unknown[];
	coalesceMs?: number;
	setTimeoutFn?: (callback: () => void, delay: number) => PreviewTimer;
	clearTimeoutFn?: (timer: PreviewTimer) => void;
}): RunTranscriptPreviewWriter {
	const setTimeoutFn: (callback: () => void, delay: number) => PreviewTimer =
		options.setTimeoutFn ?? ((callback, delay) => setTimeout(callback, delay));
	const clearTimeoutFn: (timer: PreviewTimer) => void = options.clearTimeoutFn ?? ((handle) => clearTimeout(handle));
	let timer: PreviewTimer | undefined;
	let disposed = false;

	const flush = (): void => {
		if (timer !== undefined) {
			clearTimeoutFn(timer);
			timer = undefined;
		}
		writeRunTranscriptPreview(options.sessionFile, options.stepIndex, options.getMessages());
	};

	return {
		schedule(): void {
			if (disposed || timer !== undefined) return;
			timer = setTimeoutFn(() => {
				timer = undefined;
				flush();
			}, options.coalesceMs ?? 50);
			if (typeof timer === "object" && "unref" in timer) timer.unref();
		},
		flush,
		dispose(): void {
			if (disposed) return;
			disposed = true;
			flush();
		},
	};
}
