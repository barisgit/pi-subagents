import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Message } from "@earendil-works/pi-ai";
import { createWorkflowPhaseEmitter, createWorkflowTool, runWorkflowScript } from "../../src/workflow/workflow.ts";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { AgentProgress, Details, SingleResult } from "../../src/protocol/types.ts";

describe("workflow phase global (VAL-PHASE)", () => {
	it("emits a progress line through onUpdate without changing the script return value", async () => {
		const updates: Array<{ content: Array<{ type: string; text: string }>; details: Details }> = [];
		const value = await runWorkflowScript({
			dispatch: async () => ({ result: "unused" }),
			onPhase: createWorkflowPhaseEmitter("wf", (update) => updates.push(update as (typeof updates)[number])),
			script: "phase('Inventory');\nreturn 'done';",
		});

		assert.equal(value, "done");
		assert.equal(updates.length, 1);
		assert.equal(updates[0]?.content[0]?.text, "Inventory");
		assert.equal(updates[0]?.details.mode, "parallel");
		assert.deepEqual(updates[0]?.details.progress, []);
		assert.match(String(updates[0]?.details.label), /^Phase \d+: Inventory/);
	});

	it("childProgress repaints the running placeholder, then is ignored after settle", () => {
		const updates: Array<AgentToolResult<Details>> = [];
		const emitter = createWorkflowPhaseEmitter("wf", (u) => updates.push(u));
		emitter.childStarted("explorer", "scan", 0);
		const startedFrames = updates.length;
		assert.equal(emitter.snapshot().progress?.[0]?.status, "running");
		assert.equal(emitter.snapshot().progress?.[0]?.toolCount, 0);

		// Live mid-run frame: a fresh progress snapshot for the same running child.
		const liveProgress: AgentProgress = {
			index: 0,
			agent: "explorer",
			status: "running",
			task: "scan",
			recentTools: [{ tool: "grep", args: "TODO", endMs: Date.now() }],
			recentOutput: [],
			toolCount: 3,
			tokens: 120,
			durationMs: 500,
			lastActivityAt: Date.now(),
		};
		emitter.childProgress(0, liveProgress);
		assert.ok(updates.length > startedFrames, "childProgress re-emits a live frame");
		assert.equal(emitter.snapshot().progress?.[0]?.toolCount, 3, "running placeholder reflects live tool count");

		// After settle, a late childProgress frame must not resurrect a running status.
		const settled: SingleResult = {
			agent: "explorer",
			task: "scan",
			exitCode: 0,
			usage: { input: 0, output: 0 },
		};
		emitter.childSettled(settled, 0);
		assert.equal(emitter.snapshot().progress?.[0]?.status, "completed");
		const settledFrames = updates.length;
		emitter.childProgress(0, { ...liveProgress, toolCount: 99 });
		assert.equal(updates.length, settledFrames, "childProgress is a no-op once the child settled");
		assert.equal(emitter.snapshot().progress?.[0]?.status, "completed");
		assert.notEqual(emitter.snapshot().progress?.[0]?.toolCount, 99);
	});

	it("compacts settled child payloads in live and final snapshots", () => {
		const updates: Array<AgentToolResult<Details>> = [];
		const emitter = createWorkflowPhaseEmitter("wf", (u) => updates.push(u));
		const largePayload = "A".repeat(100_000);
		const messages: Message[] = [
			{
				role: "user",
				content: [
					{ type: "text", text: largePayload },
					{ type: "image", data: largePayload, mimeType: "image/png" },
				],
				timestamp: 1,
			},
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "/tmp/report.png" } }],
				api: "test",
				provider: "test",
				model: "test",
				usage: {
					input: 1,
					output: 2,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 3,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: 2,
			},
		];
		const pipeline = { id: "pipe-1", itemIndex: 2, stageIndex: 1, itemLabel: "artifact" };
		const progress: AgentProgress = {
			index: 0,
			agent: "explorer",
			status: "running",
			task: "inspect artifact",
			recentTools: [{ tool: "read", args: "/tmp/report.png", endMs: 3 }],
			recentOutput: [largePayload],
			tokenSamples: [{ ts: 4, tokens: 3 }],
			toolCount: 1,
			tokens: 3,
			durationMs: 5,
		};
		emitter.childStarted("explorer", "inspect artifact", 0);
		emitter.childSettled(
			{
				agent: "explorer",
				task: "inspect artifact",
				exitCode: 1,
				messages,
				usage: { input: 1, output: 2 },
				error: "inspection failed",
				label: "Inspect artifact",
				pipeline,
				progress,
				finalOutput: "useful final output",
				structuredResult: { result: { retained: true } },
			},
			0,
		);

		const liveResult = updates.at(-1)?.details.results[0];
		const finalResult = emitter.snapshot().results[0];
		for (const result of [liveResult, finalResult]) {
			assert.ok(result);
			assert.equal(result.messages, undefined);
			assert.deepEqual(result.toolCalls, [
				{ text: "read /tmp/report.png", expandedText: "read /tmp/report.png" },
			]);
			assert.deepEqual(result.progress?.recentOutput, []);
			assert.deepEqual(result.progress?.recentTools, progress.recentTools);
			assert.deepEqual(result.progress?.tokenSamples, progress.tokenSamples);
			assert.equal(result.progress?.status, "failed");
			assert.equal(result.finalOutput, "useful final output");
			assert.deepEqual(result.structuredResult, { result: { retained: true } });
			assert.deepEqual(result.usage, { input: 1, output: 2 });
			assert.equal(result.error, "inspection failed");
			assert.equal(result.label, "Inspect artifact");
			assert.deepEqual(result.pipeline, pipeline);
		}
	});

	it("returns the unmodified child result to the workflow script while compacting details", async () => {
		const childValue = { answer: 7, payload: "script-visible" };
		const tool = createWorkflowTool({
			openWorkflowGroup: () => ({
				groupRunId: "group-1",
				dispatchChild: async () => ({
					agent: "explorer",
					task: "inspect",
					exitCode: 0,
					messages: [{ role: "user", content: "large message", timestamp: 1 }],
					usage: { input: 1, output: 2 },
					structuredResult: { result: childValue },
				}),
			}),
		});

		const result = await tool.execute?.(
			"wf",
			{ script: "return await agent('explorer', 'inspect');" },
			new AbortController().signal,
			undefined,
			{} as never,
		);

		assert.equal(result?.content[0]?.type, "text");
		assert.deepEqual(JSON.parse(result?.content[0]?.type === "text" ? result.content[0].text : ""), childValue);
		assert.equal((result?.details as Details | undefined)?.results[0]?.messages, undefined);
	});

	it("ignores phase emitter errors", async () => {
		const value = await runWorkflowScript({
			dispatch: async () => ({ result: "unused" }),
			onPhase: () => {
				throw new Error("render failed");
			},
			script: "phase('Inventory');\nreturn 5;",
		});

		assert.equal(value, 5);
	});
});
