import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";

// The finish contract is a SINGLE field: `result`. There is no status/summary/
// artifacts ceremony — those were written on every completion but never read
// (status drove no run state, artifacts[] had zero consumers, summary only
// duplicated result), so they were pure token + latency cost. `result` defaults
// to a string (the child's text output); a workflow may replace the default
// schema to force a typed object the orchestrating script branches on directly.
export interface SubmitResultEnvelope {
	result: unknown;
}

export const SUBMIT_RESULT_TOOL_NAME = "submit_result";

export function createSubmitResultParameters(resultSchema: TSchema = Type.String()): TSchema {
	return Type.Object(
		{
			result: resultSchema,
		},
		{ additionalProperties: false },
	);
}

export function createSubmitResultTool(resultSchema: TSchema = Type.String()): ToolDefinition {
	return {
		name: SUBMIT_RESULT_TOOL_NAME,
		label: "Submit result",
		description:
			"Call this as your final, lone tool call to finish the run. Every run MUST end by calling submit_result \u2014 never stop with prose only. Provide { result }: your output. By default result is a string; an orchestrating workflow may constrain it to a specific shape.",
		parameters: createSubmitResultParameters(resultSchema),
		async execute(
			_toolCallId: string,
			params: SubmitResultEnvelope,
		): Promise<AgentToolResult<SubmitResultEnvelope>> {
			return {
				content: [{ type: "text", text: "submitted" }],
				details: params,
				terminate: true,
			};
		},
	} as ToolDefinition;
}

// The finish contract rides primarily on the tool description (always present with the tool) and, as cheap
// persistent reinforcement, on the child system prompt. We deliberately no longer append it to every task
// string: that polluted the visible task, was re-appended on resume, and was the heaviest of the carriers.
// The reactive SUBMIT_RESULT_REPROMPT below still catches a child that finishes in prose without complying.
export const SUBMIT_RESULT_SYSTEM_INSTRUCTION = `Finish every run by calling the ${SUBMIT_RESULT_TOOL_NAME} tool as a lone, final tool call with { result }: your output (a string by default). Never stop with prose only. If you are waiting on an async/background run result, do not wait on it by default with sleep/status loops; Pi will send a completion or needs-attention message and trigger a new turn. Continue independent work or stop if blocked on that result. Use status/sleep checks only when immediate inspection is genuinely necessary.`;

export function appendSubmitResultSystemInstruction(systemPrompt: string): string {
	return systemPrompt ? `${systemPrompt}\n\n${SUBMIT_RESULT_SYSTEM_INSTRUCTION}` : SUBMIT_RESULT_SYSTEM_INSTRUCTION;
}

export const SUBMIT_RESULT_REPROMPT = `You did not call ${SUBMIT_RESULT_TOOL_NAME}. You MUST finish now by calling ${SUBMIT_RESULT_TOOL_NAME} as a lone tool call with { result }: your output.`;

export function isSubmitResultEnvelope(value: unknown): value is SubmitResultEnvelope {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	if (!("result" in record)) return false;
	// Reject any key outside the single-field shape: a TypeBox-validated envelope
	// (additionalProperties:false) never carries extras, so an object that does is
	// not a trustworthy structured result.
	return Object.keys(record).every((key) => key === "result");
}

// A run is compliant only when it produced a NON-ERROR submit_result toolResult whose details pass the
// envelope guard. An SDK-rejected (invalid-args) submit_result lands as an isError toolResult; treating it as
// compliant would stop the reprompt loop early and let unvalidated arguments leak through extraction.
export function hasSubmitResultToolResult(messages: unknown[]): boolean {
	return messages.some((message) => {
		if (!message || typeof message !== "object") return false;
		const record = message as Record<string, unknown>;
		return (
			record.role === "toolResult" &&
			record.toolName === SUBMIT_RESULT_TOOL_NAME &&
			record.isError !== true &&
			isSubmitResultEnvelope(record.details)
		);
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
		if (
			record.role === "toolResult" &&
			record.toolName === SUBMIT_RESULT_TOOL_NAME &&
			record.isError !== true &&
			isSubmitResultEnvelope(record.details)
		)
			return record.details;
	}
	return undefined;
}

export function fallbackSubmitResultEnvelope(text: string): SubmitResultEnvelope {
	return { result: text };
}
