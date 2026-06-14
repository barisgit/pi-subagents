import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { createWorkflowTool } from "../../src/workflow/workflow.ts";
import { renderSubagentResult, syncResultAnimation } from "../../src/surfaces/render-result.ts";
import type { Details, SingleResult } from "../../src/protocol/types.ts";

function result(agent: string, task: string, exitCode = 0, index = agent === "A" ? 0 : 1, label?: string): SingleResult {
	return {
		agent,
		task,
		...(label ? { label } : {}),
		exitCode,
		messages: [],
		usage: { input: 0, output: 0 },
		structuredResult: { status: exitCode === 0 ? "ok" : "failed", summary: task, result: task, artifacts: [] },
		progress: { index, agent, task, status: exitCode === 0 ? "completed" : "failed", recentTools: [], recentOutput: [], toolCount: 0, tokens: 0, durationMs: 0 },
	};
}

function renderText(details: Details, expanded: boolean): string {
	const theme = { fg: (_t: string, s: string) => s, bg: (_t: string, s: string) => s, bold: (s: string) => s } as never;
	const widget = renderSubagentResult({ content: [{ type: "text", text: "workflow output" }], details }, { expanded }, theme);
	return widget.render(160).join("\n");
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
		// element omits a field the renderer derefs without optional workflowing.
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
		assert.equal(final?.workflow, true);
		assert.equal(final?.progress?.length, 2);
		assert.deepEqual(final?.progress?.map((progress) => [progress.agent, progress.status]), [["A", "completed"], ["B", "completed"]]);
		assert.equal(final?.results.length, 2);
		// results[] and progress[] stay aligned one-per-agent so header/body/denominator agree.
		assert.deepEqual(final?.results.map((r) => [r.agent, r.progress?.status]), [["A", "completed"], ["B", "completed"]]);
		assert.deepEqual(final?.agentGroups, ["A", "B"]);
		assert.equal(final?.totalSteps, 2);
	});

	it("emits serial lone agents as separate workflow steps but brackets true parallel siblings", async () => {
		const tool = createWorkflowTool({
			openWorkflowGroup: () => ({
				groupRunId: "group-1",
				async dispatchChild({ role, task, index }) {
					return result(role, task, 0, index);
				},
			}),
		});

		const serial = await tool.execute?.(
			"wf-serial",
			{ script: "phase('same phase');\nawait agent('A', 'alpha');\nawait agent('B', 'bravo');" },
			new AbortController().signal,
			undefined,
			{} as never,
		) as AgentToolResult<Details> | undefined;
		assert.deepEqual(serial?.details?.agentGroups, ["A", "B"]);
		assert.equal(serial?.details?.totalSteps, 2);

		const parallel = await tool.execute?.(
			"wf-parallel",
			{ script: "phase('same phase');\nawait parallel([() => agent('A', 'alpha'), () => agent('B', 'bravo')]);" },
			new AbortController().signal,
			undefined,
			{} as never,
		) as AgentToolResult<Details> | undefined;
		assert.deepEqual(parallel?.details?.agentGroups, ["[A+B]"]);
		assert.equal(parallel?.details?.totalSteps, 1);
	});

	it("brackets parallel siblings whose thunks await before calling agent", async () => {
		const tool = createWorkflowTool({
			openWorkflowGroup: () => ({
				groupRunId: "group-1",
				async dispatchChild({ role, task, index }) {
					return result(role, task, 0, index);
				},
			}),
		});

		const parallel = await tool.execute?.(
			"wf-parallel-delayed",
			{ script: "phase('same phase');\nawait parallel([async () => { await Promise.resolve(); return agent('A', 'alpha'); }, async () => { await Promise.resolve(); return agent('B', 'bravo'); }]);" },
			new AbortController().signal,
			undefined,
			{} as never,
		) as AgentToolResult<Details> | undefined;
		assert.deepEqual(parallel?.details?.agentGroups, ["[A+B]"]);
		assert.equal(parallel?.details?.totalSteps, 1);
	});

	it("renders non-workflow running children with the original starting and thinking fallbacks", () => {
		const starting = result("explorer", "inventory", 0, 0);
		starting.progress = { ...starting.progress!, status: "running", toolCount: 0 };
		const startingDetails: Details = {
			mode: "single",
			results: [starting],
			progress: [starting.progress],
		};

		const thinking = result("review", "check", 0, 0);
		thinking.progress = { ...thinking.progress!, status: "running", toolCount: 1 };
		const thinkingDetails: Details = {
			mode: "single",
			results: [thinking],
			progress: [thinking.progress],
		};

		assert.match(renderText(startingDetails, false), /starting…/);
		assert.doesNotMatch(renderText(startingDetails, false), /explorer working/);
		assert.match(renderText(thinkingDetails, false), /thinking…/);
		assert.doesNotMatch(renderText(thinkingDetails, false), /review working/);
	});

	it("renders workflow running child with phase-aware coarse label instead of starting", () => {
		const running = result("explorer", "inventory", 0, 0, "Phase 1: inventory");
		running.progress = { ...running.progress!, status: "running", toolCount: 0 };
		const details: Details = {
			mode: "parallel",
			workflow: true,
			label: "Phase 1: inventory",
			results: [running],
			progress: [running.progress],
			agentGroups: ["explorer"],
			totalSteps: 1,
		};

		const text = renderText(details, false);
		assert.match(text, /Phase 1: inventory working/);
		assert.doesNotMatch(text, /starting/);
	});

	it("renders workflow mode label instead of parallel in compact and expanded", () => {
		const details: Details = {
			mode: "parallel",
			workflow: true,
			label: "Phase 1: inventory",
			results: [result("explorer", "inventory", 0, 0)],
			progress: [result("explorer", "inventory", 0, 0).progress!],
			agentGroups: ["explorer"],
			totalSteps: 1,
		};

		for (const expanded of [false, true]) {
			const text = renderText(details, expanded);
			assert.match(text, /workflow/);
			assert.doesNotMatch(text, /parallel/);
		}
	});

	it("counts workflow parallel fan-out agents in the compact header", () => {
		const runningA = result("A", "alpha", 0, 0);
		runningA.progress = { ...runningA.progress!, status: "running" };
		const runningB = result("B", "bravo", 0, 1);
		runningB.progress = { ...runningB.progress!, status: "running" };
		const runningDetails: Details = {
			mode: "parallel",
			workflow: true,
			label: "Phase 1: inventory",
			agentGroups: ["[A+B]"],
			totalSteps: 1,
			results: [runningA, runningB],
			progress: [runningA.progress, runningB.progress],
		};

		assert.match(renderText(runningDetails, false), /agent 1\/2/);

		const settledA = result("A", "alpha", 0, 0);
		const settledB = result("B", "bravo", 0, 1);
		const settledDetails: Details = {
			...runningDetails,
			results: [settledA, settledB],
			progress: [settledA.progress!, settledB.progress!],
		};

		assert.match(renderText(settledDetails, false), /agent 2\/2/);
	});

	it("emits and renders workflow fan-out/fan-in structure with phase numbering", async () => {
		const updates: Array<AgentToolResult<Details>> = [];
		const tool = createWorkflowTool({
			openWorkflowGroup: () => ({
				groupRunId: "group-1",
				async dispatchChild({ role, task, index }) {
					return result(role, task, 0, index);
				},
			}),
		});

		const executed = await tool.execute?.(
			"wf",
			{ script: "phase('inventory');\nawait parallel([() => agent('explorer', 'alpha'), () => agent('explorer', 'bravo')]);\nphase('synthesis');\nawait agent('synth', 'charlie');" },
			new AbortController().signal,
			(update) => updates.push(update as AgentToolResult<Details>),
			{} as never,
		) as AgentToolResult<Details> | undefined;

		const final = executed?.details;
		assert.deepEqual(final?.agentGroups, ["[explorer+explorer]", "synth"]);
		assert.equal(final?.totalSteps, 2);
		assert.equal(final?.mode, "parallel");
		assert.equal(final?.workflow, true);

		const expanded = renderText(final!, true);
		assert.match(expanded, /workflow/);
		assert.match(expanded, /\[warning explorer ∥ warning explorer\] → warning synth/);
		assert.match(expanded, /Agent 1\.1∥: explorer/);
		assert.match(expanded, /Agent 1\.2∥: explorer/);
		assert.match(expanded, /Agent 2: synth/);
		assert.match(expanded, /Phase 2: synthesis/);

		const compact = renderText(final!, false);
		assert.match(compact, /workflow/);
		assert.match(compact, /Agent 1\.1∥: explorer/);
		assert.match(compact, /Agent 1\.2∥: explorer/);
		assert.match(compact, /Agent 2: synth/);
	});

	it("never renders 'agent 1/1' for a 2-agent parallel fan-out (header counts the whole group from the first frame)", async () => {
		const updates: Array<AgentToolResult<Details>> = [];
		const tool = createWorkflowTool({
			openWorkflowGroup: () => ({
				groupRunId: "group-1",
				async dispatchChild({ role, task, index }) {
					// Yield so both fan-out members are in flight before either settles,
					// mirroring real parallel() dispatch staggering.
					await Promise.resolve();
					return result(role, task, 0, index);
				},
			}),
		});

		await tool.execute?.(
			"wf",
			{ script: "phase('inventory');\nawait parallel([() => agent('explorer', 'alpha'), () => agent('explorer', 'bravo')]);" },
			new AbortController().signal,
			(update) => updates.push(update as AgentToolResult<Details>),
			{} as never,
		);

		// The reviewer's repro: every emitted live frame for a 2-agent fan-out must
		// read "agent x/2", never "agent 1/1".
		const compactFrames = updates.map((u) => renderText(u.details!, false));
		for (const frame of compactFrames) {
			assert.doesNotMatch(frame, /agent 1\/1\b/, `unexpected 'agent 1/1' frame:\n${frame}`);
		}
		// And at least one running frame proves the widened denominator is live.
		assert.ok(
			compactFrames.some((f) => /agent 1\/2/.test(f)),
			"expected a running frame showing 'agent 1/2'",
		);
		// Whenever only one sibling has registered into results[], expectedAgents must
		// compensate to 2; once both register, results.length suffices and the field is
		// omitted (and must never inflate the denominator after settling).
		for (const u of updates) {
			const d = u.details!;
			if ((d.results?.length ?? 0) === 1 && d.progress?.some((p) => p.status === "running")) {
				assert.equal(d.expectedAgents, 2, "single-registered running frame must widen to expectedAgents:2");
			}
		}
		// Final settled frame must not carry a stale widened denominator.
		assert.equal(updates.at(-1)?.details?.expectedAgents, undefined, "settled frame must omit expectedAgents");
	});

	it("reaps phantom pending slots when a parallel thunk settles without dispatching an agent", async () => {
		const updates: Array<AgentToolResult<Details>> = [];
		const tool = createWorkflowTool({
			openWorkflowGroup: () => ({
				groupRunId: "group-1",
				async dispatchChild({ role, task, index }) {
					await Promise.resolve();
					return result(role, task, 0, index);
				},
			}),
		});

		// Reviewer repro: a 2-thunk parallel group where only ONE thunk dispatches an
		// agent; the other resolves a raw value. expectParallel reserves 2 slots, but
		// only one childStarted ever fires, so without group-settle cleanup the phantom
		// slot leaves the completed frame stuck at 'agent 1/2'.
		await tool.execute?.(
			"wf",
			{ script: "phase('mixed');\nawait parallel([() => agent('explorer', 'alpha'), async () => 'raw']);" },
			new AbortController().signal,
			(update) => updates.push(update as AgentToolResult<Details>),
			{} as never,
		);

		const final = updates.at(-1)?.details;
		// The phantom slot must be reaped: the completed frame has one real agent and
		// no widened denominator.
		assert.equal(final?.expectedAgents, undefined, "settled mixed-thunk frame must omit expectedAgents");
		assert.equal(final?.results?.length, 1, "only one thunk dispatched an agent");
		assert.doesNotMatch(renderText(final!, false), /agent 1\/2/, "completed frame must not show an inflated 'agent 1/2'");
	});

	it("reaps the phantom slot when a parallel thunk throws synchronously", async () => {
		const updates: Array<AgentToolResult<Details>> = [];
		const tool = createWorkflowTool({
			openWorkflowGroup: () => ({
				groupRunId: "group-1",
				async dispatchChild({ role, task, index }) {
					await Promise.resolve();
					return result(role, task, 0, index);
				},
			}),
		});

		// Reviewer repro: a 2-thunk parallel group reserves 2 slots, but one thunk
		// throws SYNCHRONOUSLY (not a rejected promise). The sync throw must be turned
		// into a rejected member promise so allSettled still observes the group and
		// reaps the phantom slot; otherwise the completed frame stays at 'agent 1/2'.
		await tool.execute?.(
			"wf",
			{
				script:
					"phase('sync throw');\ntry { await parallel([() => agent('explorer', 'alpha'), () => { throw new Error('sync boom'); }]); } catch {}\nreturn 'ok';",
			},
			new AbortController().signal,
			(update) => updates.push(update as AgentToolResult<Details>),
			{} as never,
		);

		const final = updates.at(-1)?.details;
		assert.equal(final?.expectedAgents, undefined, "settled sync-throw frame must omit expectedAgents");
		assert.equal(final?.results?.length, 1, "only one thunk dispatched an agent");
		assert.doesNotMatch(renderText(final!, false), /agent 1\/2/, "completed frame must not show an inflated 'agent 1/2'");
	});
});
