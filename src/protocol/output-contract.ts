import type { TSchema } from "typebox";
import { Check } from "typebox/value";

// The finish contract is delivered as an end-of-prompt convention, not a tool: a
// child ends its final assistant message with the result wrapped in a trailing
// <output>...</output> block, and the runtime extracts the LAST such block as the
// authoritative result. This replaces the former submit_result tool (and its
// synthetic terminate signal): the agent loop already ends naturally on an
// assistant turn with no tool calls, so a prose final message with <output>
// finishes without any bolted-on machinery.
//
// The persisted structured carrier is unchanged. `SubmitResultEnvelope` is the
// single-field { result } shape written to status.json (status-types.ts,
// types.ts) and consumed by workflow scripts; only its PRODUCER changed (parsed
// from <output> instead of a validated tool result). The name is kept to preserve
// the documented persisted field and avoid churn across importers.
export interface SubmitResultEnvelope {
	result: unknown;
}

export const OUTPUT_OPEN = "<output>";
export const OUTPUT_CLOSE = "</output>";

// Global, non-greedy, dot-matches-newline (via [\s\S]) so multiple blocks and
// multiline content are both handled. We deliberately require a closing tag: an
// unterminated <output> is treated as no valid block (fail closed -> text
// fallback), never speculatively extracted to end-of-string, so a model that was
// cut off mid-stream does not surface a half-written object as its result.
const OUTPUT_BLOCK_RE = /<output>([\s\S]*?)<\/output>/g;

/**
 * Extract the content of the LAST <output>...</output> block in `text`, trimmed.
 * Returns undefined when no complete block is present.
 *
 * Last-match is the core of the contract: a child may legitimately emit fenced
 * code or even literal <output> samples earlier in its message; only the final
 * block is its result, and models reliably treat the closing block as canonical.
 */
export function extractOutputBlock(text: string): string | undefined {
	if (!text) return undefined;
	let last: string | undefined;
	let lastEnd = 0;
	OUTPUT_BLOCK_RE.lastIndex = 0;
	for (let match = OUTPUT_BLOCK_RE.exec(text); match !== null; match = OUTPUT_BLOCK_RE.exec(text)) {
		last = match[1];
		lastEnd = match.index + match[0].length;
	}
	if (last === undefined) return undefined;
	// The final block must be truly trailing: only whitespace may follow. Any
	// trailing non-whitespace means the block is not authoritative (it may be a
	// sample), so fail closed and let the caller reprompt or fall back.
	if (text.slice(lastEnd).trim() !== "") return undefined;
	// A present-but-empty block (`<output></output>`) is a DELIBERATE empty result, not a
	// miss: we return "" rather than undefined. Mapping empty -> undefined would drive the
	// reprompt loop to exhaustion and then fall back to the last assistant text (the prose
	// preamble) -- reintroducing the exact preamble-leak this contract exists to prevent.
	// The schema path is unaffected: an empty block fails JSON.parse, so parseOutputEnvelope
	// still returns { ok: false } and reprompts/fails closed under a schema.
	return last.trim();
}

/**
 * DISPLAY-ONLY lenient variant of extractOutputBlock: returns the content of the
 * LAST complete <output> block even when prose follows it. The strict contract
 * (extractOutputBlock) requires the block to be truly trailing and fails closed
 * otherwise — that failure falls back to the full message text, so a model that
 * appended a sentence after its <output> block leaks that prose into the result
 * surface. For rendering we only care about the output, so this strips the
 * surrounding narration. Returns undefined when no complete block exists; an
 * empty block yields "" (a deliberate empty result).
 */
export function extractOutputBlockForDisplay(text: string): string | undefined {
	if (!text) return undefined;
	let last: string | undefined;
	OUTPUT_BLOCK_RE.lastIndex = 0;
	for (let match = OUTPUT_BLOCK_RE.exec(text); match !== null; match = OUTPUT_BLOCK_RE.exec(text)) {
		last = match[1];
	}
	return last?.trim();
}

/** True when `text` contains at least one complete <output> block. */
export function hasOutputBlock(text: string): boolean {
	return extractOutputBlock(text) !== undefined;
}

export type ParseOutputResult = { ok: true; envelope: SubmitResultEnvelope } | { ok: false };

/**
 * Codec at the finish boundary. Extract the last <output> block from `text` and
 * resolve it into the structured envelope, failing CLOSED (ok:false) on a missing
 * block or schema-invalid content.
 *
 * - No schema: the block's text IS the result (string). This is the default
 *   string contract.
 * - With schema: the block is JSON.parsed and TypeBox-validated against the
 *   workflow-authored schema; a parse error or validation miss is ok:false so the
 *   caller can reprompt or fall back rather than trusting unvalidated input.
 */
export function parseOutputEnvelope(text: string, schema?: TSchema): ParseOutputResult {
	const block = extractOutputBlock(text);
	if (block === undefined) return { ok: false };
	if (!schema) return { ok: true, envelope: { result: block } };
	let parsed: unknown;
	try {
		parsed = JSON.parse(block);
	} catch {
		return { ok: false };
	}
	if (!Check(schema, parsed)) return { ok: false };
	return { ok: true, envelope: { result: parsed } };
}

/** Text fallback when no compliant <output> block was produced after reprompts. */
export function fallbackSubmitResultEnvelope(text: string): SubmitResultEnvelope {
	return { result: text };
}

// The contract rides on the child system prompt via the loader's additive append
// channel, so it is present uniformly for fresh and fork-reuse children without
// clobbering an inherited prompt. The reactive OUTPUT_REPROMPT below still catches
// a child that finishes without a compliant block.
export const OUTPUT_SYSTEM_INSTRUCTION = `Finish every run by ending your final message with your output wrapped in a trailing ${OUTPUT_OPEN}...${OUTPUT_CLOSE} block. The output block must be the LAST thing in your final message; earlier narration and fenced samples are ignored, but nothing may follow the final block. Put a string there by default, or the exact shape requested. Do not stop with prose only and do not call any finish tool. If you are waiting on an async/background run result, do not wait on it by default with sleep/status loops; Pi will send a completion or needs-attention message and trigger a new turn. Continue independent work or stop if blocked on that result. Use status/sleep checks only when immediate inspection is genuinely necessary.`;

/**
 * Render a schema-specific contract instruction telling the child the exact JSON
 * shape to place inside the <output> block. Used only on the workflow path, where
 * the orchestrating script authors the schema; the child never decides its shape.
 */
export function renderSchemaInstruction(schema: TSchema): string {
	const json = JSON.stringify(schema, null, 2);
	return `Your ${OUTPUT_OPEN} block MUST contain a single JSON value that validates against this schema (no prose, no code fences inside the block):\n${json}`;
}

export function schemaReprompt(schema: TSchema): string {
	return `Your last ${OUTPUT_OPEN} block did not match the required JSON shape. You MUST finish now with a corrected trailing ${OUTPUT_OPEN}...${OUTPUT_CLOSE} block.\n\n${renderSchemaInstruction(schema)}`;
}

/**
 * Build the full contract text appended to a child's system prompt: the base
 * end-of-prompt instruction, plus the schema shape when the workflow supplied one.
 */
export function buildOutputContractAppend(schema?: TSchema): string {
	return schema ? `${OUTPUT_SYSTEM_INSTRUCTION}\n\n${renderSchemaInstruction(schema)}` : OUTPUT_SYSTEM_INSTRUCTION;
}

export const OUTPUT_REPROMPT = `Your last message did not end with a ${OUTPUT_OPEN}...${OUTPUT_CLOSE} block. You MUST finish now: send your output wrapped in a trailing ${OUTPUT_OPEN}...${OUTPUT_CLOSE} block as the last thing in your message.`;
