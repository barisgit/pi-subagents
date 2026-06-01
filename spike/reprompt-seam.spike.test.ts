// THROWAWAY SPIKE part 2 for charter 783ddda7 structured-output.
// Do NOT wire into production. Empirical proof only for @earendil-works/pi-coding-agent v0.75.4.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Agent } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const mockModel = {
	id: "mock-model",
	name: "Mock Model",
	api: "mock-api",
	provider: "mock-provider",
	baseUrl: "",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 1000,
};

const submitResultParameters = Type.Object({
	status: Type.Union([Type.Literal("ok"), Type.Literal("blocked"), Type.Literal("failed")]),
	summary: Type.String(),
	result: Type.String(),
	artifacts: Type.Optional(Type.Array(Type.String())),
}, { additionalProperties: false });

function makeSubmitResultTool() {
	const calls = [];
	return {
		calls,
		tool: {
			name: "submit_result",
			label: "Submit result",
			description: "THROWAWAY SPIKE structured finish tool.",
			parameters: submitResultParameters,
			async execute(toolCallId, params) {
				calls.push({ toolCallId, params });
				return {
					content: [{ type: "text", text: `submitted: ${params.status}` }],
					details: params,
					terminate: true,
				};
			},
		},
	};
}

function assistantMessage(content, stopReason = "toolUse") {
	return {
		role: "assistant",
		content,
		api: "mock-api",
		provider: "mock-provider",
		model: "mock-model",
		usage,
		stopReason,
		timestamp: Date.now(),
	};
}

function mockStreamFrom(messages) {
	let index = 0;
	const calls = [];
	const streamFn = (...args) => {
		calls.push(args);
		const message = messages[index++];
		assert.ok(message, "mock stream should not be called after scripted messages are exhausted");
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => stream.push({ type: "done", reason: message.stopReason, message }));
		return stream;
	};
	streamFn.calls = calls;
	return streamFn;
}

function makeAgent({ tools = [], messages, events = [] }) {
	const streamFn = mockStreamFrom(messages);
	const agent = new Agent({
		initialState: {
			systemPrompt: "THROWAWAY SPIKE system prompt",
			model: mockModel,
			thinkingLevel: "off",
			tools,
		},
		streamFn,
	});
	agent.subscribe((event) => {
		events.push(event);
	});
	return { agent, streamFn };
}

function hasSubmitResultToolResult(messages) {
	return messages.some((message) => message?.role === "toolResult" && message.toolName === "submit_result");
}

function submitResultToolResults(messages) {
	return messages.filter((message) => message?.role === "toolResult" && message.toolName === "submit_result");
}

function lastAssistantText(messages) {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role !== "assistant") continue;
		return message.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n")
			.trim();
	}
	return "";
}

function envelopeFromAssistantText(text) {
	return {
		status: "ok",
		summary: text.split(/\s+/).slice(0, 12).join(" "),
		result: text,
		artifacts: [],
	};
}

async function promptAndMaybeReprompt(agent, initialPrompt, nudge, maxReprompts) {
	let promptCalls = 0;
	await agent.prompt(initialPrompt);
	promptCalls++;
	for (let reprompt = 0; reprompt < maxReprompts && !hasSubmitResultToolResult(agent.state.messages); reprompt++) {
		await agent.prompt(nudge);
		promptCalls++;
	}
	if (hasSubmitResultToolResult(agent.state.messages)) {
		return { promptCalls, fallback: undefined };
	}
	return { promptCalls, fallback: envelopeFromAssistantText(lastAssistantText(agent.state.messages)) };
}

describe("THROWAWAY post-completion reprompt seam spike", () => {
	it("R1: same Agent can be re-engaged after prose-only completion by calling prompt() again", async () => {
		const { tool, calls } = makeSubmitResultTool();
		const events = [];
		const submitArgs = { status: "ok", summary: "structured after nudge", result: "finished on reprompt", artifacts: [] };
		const { agent, streamFn } = makeAgent({
			tools: [tool],
			events,
			messages: [
				assistantMessage([{ type: "text", text: "I am done in prose only." }], "stop"),
				assistantMessage([{ type: "toolCall", id: "submit-after-reprompt", name: "submit_result", arguments: submitArgs }]),
			],
		});

		await agent.prompt("do work");

		assert.deepEqual(agent.state.messages.map((message) => message.role), ["user", "assistant"]);
		assert.equal(hasSubmitResultToolResult(agent.state.messages), false, "sad path detected: no submit_result toolResult after first completed run");
		assert.equal(lastAssistantText(agent.state.messages), "I am done in prose only.");
		assert.equal(events.filter((event) => event.type === "agent_end").length, 1);

		await agent.prompt("You did not call submit_result. You MUST finish by calling submit_result now.");

		assert.deepEqual(agent.state.messages.map((message) => message.role), ["user", "assistant", "user", "assistant", "toolResult"]);
		assert.equal(calls.length, 1);
		assert.deepEqual(calls[0], { toolCallId: "submit-after-reprompt", params: submitArgs });
		assert.equal(hasSubmitResultToolResult(agent.state.messages), true);
		assert.equal(submitResultToolResults(agent.state.messages).length, 1);
		assert.equal(streamFn.calls.length, 2, "second prompt() caused a second real Agent loop/stream call");
		assert.equal(events.filter((event) => event.type === "agent_end").length, 2, "second prompt() ran after the first agent_end");
		assert.equal(events.at(-1).type, "agent_end");
	});

	it("R2: bounded post-completion reprompts degrade to text fallback when submit_result never appears", async () => {
		const events = [];
		const { agent, streamFn } = makeAgent({
			events,
			messages: [
				assistantMessage([{ type: "text", text: "First prose-only completion." }], "stop"),
				assistantMessage([{ type: "text", text: "Second prose-only completion after nudge." }], "stop"),
				assistantMessage([{ type: "text", text: "Final prose-only completion after bounded nudges." }], "stop"),
			],
		});

		const result = await promptAndMaybeReprompt(
			agent,
			"do work",
			"You did not call submit_result. You MUST finish by calling submit_result now.",
			2,
		);

		assert.equal(hasSubmitResultToolResult(agent.state.messages), false);
		assert.equal(result.promptCalls, 3, "initial prompt + exactly 2 bounded reprompts");
		assert.equal(streamFn.calls.length, 3, "bounded driver did not ask the mock model for an unbounded extra turn");
		assert.equal(events.filter((event) => event.type === "agent_end").length, 3);
		assert.deepEqual(agent.state.messages.map((message) => message.role), ["user", "assistant", "user", "assistant", "user", "assistant"]);
		assert.deepEqual(result.fallback, {
			status: "ok",
			summary: "Final prose-only completion after bounded nudges.",
			result: "Final prose-only completion after bounded nudges.",
			artifacts: [],
		});
	});

	it("R3: detection predicate is scanning state.messages for a submit_result toolResult", async () => {
		const { tool } = makeSubmitResultTool();
		const proseOnly = makeAgent({
			messages: [assistantMessage([{ type: "text", text: "Plain prose only." }], "stop")],
		}).agent;
		await proseOnly.prompt("finish badly");
		assert.equal(hasSubmitResultToolResult(proseOnly.state.messages), false);

		const compliant = makeAgent({
			tools: [tool],
			messages: [assistantMessage([{ type: "toolCall", id: "submit-clean", name: "submit_result", arguments: { status: "ok", summary: "done", result: "structured" } }])],
		}).agent;
		await compliant.prompt("finish cleanly");
		assert.equal(hasSubmitResultToolResult(compliant.state.messages), true);
	});
});
