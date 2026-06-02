import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { createWorkflowTool } from "../../workflow.ts";
import { renderSubagentResult, syncResultAnimation } from "../../render.ts";
import type { Details, SingleResult } from "../../types.ts";

function result(agent: string, task: string, exitCode = 0): SingleResult {
	return {
		agent,
		task,
		exitCode,
		messages: [],
		usage: { input: 0, output: 0 },
		structuredResult: { status: exitCode === 0 ? "ok" : "failed", summary: task, result: task, artifacts: [] },
		progress: { index: agent === "A" ? 0 : 1, agent, task, status: exitCode === 0 ? "completed" : "failed", recentTools: [], recentOutput: [], toolCount: 0, tokens: 0, durationMs: 0 },
	};
}

describe("workflow final result rendering does not throw on non-Details payloads (VAL-INLINE-RENDER)", () => {
	// The workflow tool returns the script's arbitrary value (or an error envelope)
	// in `details`, which is NOT a Details object. The registered renderResult path
	// (syncResultAnimation -> resultIsRunning, then renderSubagentResult) must treat
	// it as text instead of dereferencing details.results.
	const theme = { fg: (_t: string, s: string) => s, bg: (_t: string, s: string) => s } as never;
	const animCtx = { state: {}, invalidate: () => {} } as never;
	for (const [label, details] of [
		["plain script return value", { value: 42 }],
		["error envelope", { status: "failed", summary: "boom", result: "boom", artifacts: [] }],
		["message object", { message: "boom" }],
		// Non-array `progress` and a `results` array of non-Details elements must not
		// throw: the guards validate both array-ness AND element shape.
		["non-array progress property", { progress: "x" }],
		["results array of non-objects", { results: ["x"] }],
		["results array of shapeless objects", { results: [{ foo: 1 }] }],
		// agent-only element: passes a naive `.agent` check but the renderer also
		// derefs r.task (.match/.slice), r.exitCode and r.usage — require ALL of them.
		["results element with only agent", { results: [{ agent: "A" }] }],
		["results element missing usage", { results: [{ agent: "A", task: "t", exitCode: 0 }] }],
		// Round-5 repros: a payload with non-empty results[] passes the cheap
		// hasRenderableResults pre-check, so it reaches the structured body; the body's
		// try/catch must still fall back to text rather than crash the host TUI when an
		// element omits a field the renderer derefs without optional chaining.
		["fully-shaped result but non-array top-level progress", { mode: "parallel", progress: "x", results: [{ agent: "A", task: "t", exitCode: 0, usage: { input: 0, output: 0 } }] }],
		["result element with malformed messages", { results: [{ agent: "A", task: "t", exitCode: 0, usage: { input: 0, output: 0 }, messages: { length: 1 } }] }],
	] as Array<[string, unknown]>) {
		it(`renders a ${label} as text without throwing`, () => {
			const result = { content: [{ type: "text", text: "workflow output" }], details } as never;
			assert.doesNotThrow(() => syncResultAnimation(result, animCtx));
			assert.doesNotThrow(() => renderSubagentResult(result, { expanded: true }, theme));
		});
	}

	// Round-6 repros: ADVERSARIAL poison accessors on `details`. No real caller can
	// produce these (every caller now builds typed Details), but the shared host
	// renderer must be TOTAL anyway — a throwing getter/proxy must never crash the TUI.
	// Each escapes round-5's single inner try: (1) the status probe reads d.progress,
	// (2) the inner catch's own error formatting throws via a poison toString, and
	// (3) the text fallback reads d.context.
	it("fails closed (no throw) on a poison `progress` getter via syncResultAnimation", () => {
		const details = { results: [] as unknown[], get progress(): unknown { throw new Error("progress poison"); } };
		const result = { content: [{ type: "text", text: "workflow output" }], details } as never;
		assert.doesNotThrow(() => syncResultAnimation(result, animCtx));
		assert.doesNotThrow(() => renderSubagentResult(result, { expanded: true }, theme));
	});

	it("survives a structured-render error whose message itself throws (poison toString) and still shows real text", () => {
		const details = {
			results: [{ agent: "A", exitCode: 0, usage: { input: 0, output: 0 }, messages: [],
				get task(): string { throw { toString() { throw new Error("toString poison"); } }; } }],
		};
		const result = { content: [{ type: "text", text: "workflow output" }], details } as never;
		let widget!: ReturnType<typeof renderSubagentResult>;
		assert.doesNotThrow(() => { widget = renderSubagentResult(result, { expanded: true }, theme); });
		// safeErrorMessage keeps the inner catch's logging from throwing, so the inner
		// fallback fires and the user sees their REAL output — not the outer last-resort
		// constant. Without it the outer boundary catches and degrades to a useless stub.
		const text = widget.render(140).join("\n");
		assert.match(text, /workflow output/);
		assert.doesNotMatch(text, /unrenderable subagent result/);
	});

	it("fails closed on a poison `context` getter in the text fallback path", () => {
		const details = { progress: [] as unknown[], results: [] as unknown[], get context(): string { throw new Error("context poison"); } };
		const result = { content: [{ type: "text", text: "workflow output" }], details } as never;
		assert.doesNotThrow(() => syncResultAnimation(result, animCtx));
		assert.doesNotThrow(() => renderSubagentResult(result, { expanded: true }, theme));
	});
});

describe("workflow inline render details (VAL-INLINE-RENDER)", () => {
	it("emits parallel details with phase summary and per-agent running/completed state", async () => {
		const updates: Array<AgentToolResult<Details>> = [];
		const tool = createWorkflowTool({
			openWorkflowGroup: () => ({
				groupRunId: "group-1",
				async dispatchChild({ role, task }) {
					return result(role, task);
				},
			}),
		});

		await tool.execute?.(
			"wf",
			{ script: "phase('inventory');\nawait agent('A', 'alpha');\nawait agent('B', 'bravo');" },
			new AbortController().signal,
			(update) => updates.push(update as AgentToolResult<Details>),
			{} as never,
		);

		const phaseUpdate = updates.find((update) => update.details?.label);
		assert.equal(phaseUpdate?.details?.mode, "parallel");
		assert.match(String(phaseUpdate?.details?.label), /^Phase \d+: inventory/);
		const runningA = updates.find((update) => update.details?.progress?.some((progress) => progress.agent === "A" && progress.status === "running"));
		assert.ok(runningA, "expected running progress for A");
		// Canonical parallel shape: a running agent must ALSO be present in results[]
		// (the renderer iterates results[] for body rows and uses results.length as the
		// denominator). When A is running it must already have a results[] placeholder.
		const aRunningUpdate = updates.find((update) =>
			update.details?.results?.some((r) => r.agent === "A" && r.progress?.status === "running"));
		assert.ok(aRunningUpdate, "expected A to have a running placeholder in results[] while in-flight");
		const final = updates.at(-1)?.details;
		assert.equal(final?.mode, "parallel");
		assert.equal(final?.progress?.length, 2);
		assert.deepEqual(final?.progress?.map((progress) => [progress.agent, progress.status]), [["A", "completed"], ["B", "completed"]]);
		assert.equal(final?.results.length, 2);
		// results[] and progress[] stay aligned one-per-agent so header/body/denominator agree.
		assert.deepEqual(final?.results.map((r) => [r.agent, r.progress?.status]), [["A", "completed"], ["B", "completed"]]);
	});
});
