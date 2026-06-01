import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";

export type SubmitResultStatus = "ok" | "blocked" | "failed";

export interface SubmitResultEnvelope {
	status: SubmitResultStatus;
	summary: string;
	result: unknown;
	artifacts?: string[];
}

export const SUBMIT_RESULT_TOOL_NAME = "submit_result";

export function createSubmitResultParameters(resultSchema: TSchema = Type.String()): TSchema {
	return Type.Object({
		status: Type.Union([Type.Literal("ok"), Type.Literal("blocked"), Type.Literal("failed")]),
		summary: Type.String(),
		result: resultSchema,
		artifacts: Type.Optional(Type.Array(Type.String())),
	}, { additionalProperties: false });
}

export function createSubmitResultTool(resultSchema: TSchema = Type.String()): ToolDefinition {
	return {
		name: SUBMIT_RESULT_TOOL_NAME,
		label: "Submit result",
		description: "Finish the child agent run with a structured result envelope.",
		parameters: createSubmitResultParameters(resultSchema),
		async execute(_toolCallId: string, params: SubmitResultEnvelope): Promise<AgentToolResult<SubmitResultEnvelope>> {
			return {
				content: [{ type: "text", text: `submitted: ${params.status}` }],
				details: params,
				terminate: true,
			};
		},
	} as ToolDefinition;
}

export function injectSubmitResultInstruction(task: string): string {
	return `${task}\n\n---\n**Structured finish:** When your work is complete, call the ${SUBMIT_RESULT_TOOL_NAME} tool as a lone tool call. Use this envelope exactly: { status: 'ok'|'blocked'|'failed', summary: string, result: string, artifacts?: string[] }. Do not finish with prose only.`;
}

export const SUBMIT_RESULT_REPROMPT = `You did not call ${SUBMIT_RESULT_TOOL_NAME}. You MUST finish now by calling ${SUBMIT_RESULT_TOOL_NAME} as a lone tool call with { status: 'ok'|'blocked'|'failed', summary: string, result: string, artifacts?: string[] }.`;

const SUBMIT_RESULT_ENVELOPE_KEYS = new Set(["status", "summary", "result", "artifacts"]);

export function isSubmitResultEnvelope(value: unknown): value is SubmitResultEnvelope {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	if (!(record.status === "ok" || record.status === "blocked" || record.status === "failed")) return false;
	if (typeof record.summary !== "string") return false;
	if (!("result" in record)) return false;
	if (!(record.artifacts === undefined || (Array.isArray(record.artifacts) && record.artifacts.every((artifact) => typeof artifact === "string")))) return false;
	// Reject any key outside the fixed envelope shape: a TypeBox-validated envelope (additionalProperties:false)
	// never carries extras, so an object that does is not a trustworthy structured result.
	return Object.keys(record).every((key) => SUBMIT_RESULT_ENVELOPE_KEYS.has(key));
}

// A run is compliant only when it produced a NON-ERROR submit_result toolResult whose details pass the
// envelope guard. An SDK-rejected (invalid-args) submit_result lands as an isError toolResult; treating it as
// compliant would stop the reprompt loop early and let unvalidated arguments leak through extraction.
export function hasSubmitResultToolResult(messages: unknown[]): boolean {
	return messages.some((message) => {
		if (!message || typeof message !== "object") return false;
		const record = message as Record<string, unknown>;
		return record.role === "toolResult"
			&& record.toolName === SUBMIT_RESULT_TOOL_NAME
			&& record.isError !== true
			&& isSubmitResultEnvelope(record.details);
	});
}

// Only the TypeBox-validated toolResult details are authoritative. We deliberately do NOT fall back to raw
// assistant tool-call arguments: those bypass schema validation (additionalProperties / result type), so an
// invalid call could masquerade as a structured envelope. A missing valid toolResult routes to text-fallback.
export function extractSubmitResultEnvelope(messages: unknown[]): SubmitResultEnvelope | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (!message || typeof message !== "object") continue;
		const record = message as Record<string, unknown>;
		if (record.role === "toolResult" && record.toolName === SUBMIT_RESULT_TOOL_NAME && record.isError !== true && isSubmitResultEnvelope(record.details)) return record.details;
	}
	return undefined;
}

export function fallbackSubmitResultEnvelope(text: string): SubmitResultEnvelope {
	return {
		status: "ok",
		summary: text.trim().split(/\s+/).filter(Boolean).slice(0, 12).join(" "),
		result: text,
		artifacts: [],
	};
}
