import * as fs from "node:fs";
import * as path from "node:path";

type EventLogLine =
	| { kind: "step-start"; stepIndex: number; agent: string; ts: number }
	| { kind: "tool"; stepIndex: number; toolName: string; argsPreview: string; durationMs?: number; ts: number }
	| { kind: "step-end"; stepIndex: number; agent: string; ts: number; durationMs?: number; tokens?: number; status?: string }
	| { kind: "final-text"; stepIndex: number; agent: string; text: string };

interface CacheEntry {
	mtimeMs: number;
	size: number;
	lines: EventLogLine[];
}

const cache = new Map<string, CacheEntry>();

const ARGS_PREVIEW_MAX = 60;

function previewArgs(args: unknown): string {
	if (args === undefined || args === null) return "";
	let json: string;
	try {
		json = JSON.stringify(args);
	} catch {
		return "";
	}
	if (!json) return "";
	if (json.length <= ARGS_PREVIEW_MAX) return json;
	return `${json.slice(0, ARGS_PREVIEW_MAX - 1)}…`;
}

function extractTextFromMessageContent(content: unknown): string {
	if (!Array.isArray(content)) return "";
	const texts: string[] = [];
	for (const part of content) {
		if (part && typeof part === "object" && (part as { type?: unknown }).type === "text") {
			const text = (part as { text?: unknown }).text;
			if (typeof text === "string") texts.push(text);
		}
	}
	return texts.join("");
}

export function readEventLog(asyncDir: string): EventLogLine[] {
	const filePath = path.join(asyncDir, "events.jsonl");
	let stat: fs.Stats;
	try {
		stat = fs.statSync(filePath);
	} catch {
		cache.delete(filePath);
		return [];
	}

	const cached = cache.get(filePath);
	if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
		return cached.lines;
	}

	let raw: string;
	try {
		raw = fs.readFileSync(filePath, "utf-8");
	} catch {
		return [];
	}

	const out: EventLogLine[] = [];
	// Track tool starts per (stepIndex, toolCallId) so end events can attach duration.
	const toolStartIndex = new Map<string, number>();
	// Track latest assistant text per stepIndex; emitted as 'final-text' on step/run completion.
	const pendingFinalText = new Map<number, { agent: string; text: string }>();

	const finalizeStep = (stepIndex: number, agent: string) => {
		const pending = pendingFinalText.get(stepIndex);
		if (pending && pending.text) {
			out.push({ kind: "final-text", stepIndex, agent: pending.agent || agent, text: pending.text });
		}
		pendingFinalText.delete(stepIndex);
	};

	const rememberAgentByStep = new Map<number, string>();

	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let event: Record<string, unknown>;
		try {
			event = JSON.parse(trimmed) as Record<string, unknown>;
		} catch {
			continue;
		}
		const type = typeof event.type === "string" ? event.type : "";

		if (type === "subagent.step.started") {
			const stepIndex = typeof event.stepIndex === "number" ? event.stepIndex : -1;
			const agent = typeof event.agent === "string" ? event.agent : "";
			const ts = typeof event.ts === "number" ? event.ts : 0;
			if (stepIndex < 0) continue;
			rememberAgentByStep.set(stepIndex, agent);
			out.push({ kind: "step-start", stepIndex, agent, ts });
			continue;
		}

		if (type === "tool_execution_start") {
			const stepIndex = typeof event.subagentStepIndex === "number" ? event.subagentStepIndex : -1;
			const toolName = typeof event.toolName === "string" ? event.toolName : "";
			const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : "";
			const ts = typeof event.observedAt === "number" ? event.observedAt : 0;
			if (stepIndex < 0 || !toolName) continue;
			const argsPreview = previewArgs(event.args);
			const entry: EventLogLine = { kind: "tool", stepIndex, toolName, argsPreview, ts };
			out.push(entry);
			if (toolCallId) toolStartIndex.set(`${stepIndex}:${toolCallId}`, out.length - 1);
			continue;
		}

		if (type === "tool_execution_end") {
			const stepIndex = typeof event.subagentStepIndex === "number" ? event.subagentStepIndex : -1;
			const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : "";
			const ts = typeof event.observedAt === "number" ? event.observedAt : 0;
			if (stepIndex < 0 || !toolCallId) continue;
			const idx = toolStartIndex.get(`${stepIndex}:${toolCallId}`);
			if (idx === undefined) continue;
			const start = out[idx];
			if (start && start.kind === "tool" && start.ts) {
				start.durationMs = Math.max(0, ts - start.ts);
			}
			toolStartIndex.delete(`${stepIndex}:${toolCallId}`);
			continue;
		}

		if (type === "message_end") {
			const message = event.message as { role?: unknown; content?: unknown } | undefined;
			if (!message || message.role !== "assistant") continue;
			// Subagent-bridged events tag step index via subagentStepIndex on the wrapper.
			const stepIndex = typeof event.subagentStepIndex === "number" ? event.subagentStepIndex : -1;
			if (stepIndex < 0) continue;
			const text = extractTextFromMessageContent(message.content);
			if (!text) continue;
			const agent = typeof event.subagentAgent === "string"
				? event.subagentAgent
				: rememberAgentByStep.get(stepIndex) ?? "";
			pendingFinalText.set(stepIndex, { agent, text });
			continue;
		}

		if (type === "subagent.step.completed" || type === "subagent.step.failed") {
			const stepIndex = typeof event.stepIndex === "number" ? event.stepIndex : -1;
			const agent = typeof event.agent === "string" ? event.agent : rememberAgentByStep.get(stepIndex) ?? "";
			const ts = typeof event.ts === "number" ? event.ts : 0;
			if (stepIndex < 0) continue;
			const durationMs = typeof event.durationMs === "number" ? event.durationMs : undefined;
			const tokensField = event.tokens as { total?: unknown } | undefined;
			const tokens = tokensField && typeof tokensField.total === "number" ? tokensField.total : undefined;
			const status = typeof event.status === "string"
				? event.status
				: (type === "subagent.step.failed" ? "failed" : "completed");
			out.push({
				kind: "step-end",
				stepIndex,
				agent,
				ts,
				...(durationMs !== undefined ? { durationMs } : {}),
				...(tokens !== undefined ? { tokens } : {}),
				...(status ? { status } : {}),
			});
			finalizeStep(stepIndex, agent);
			continue;
		}

		if (type === "subagent.run.completed") {
			for (const [stepIndex, info] of pendingFinalText) {
				if (info.text) out.push({ kind: "final-text", stepIndex, agent: info.agent, text: info.text });
			}
			pendingFinalText.clear();
			continue;
		}
	}

	cache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, lines: out });
	return out;
}
