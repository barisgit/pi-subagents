// THROWAWAY SPIKE for charter 783ddda7 structured-output.
// Do NOT wire into production. Empirical proof only for @earendil-works/pi-coding-agent v0.75.4.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Agent } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, validateToolArguments } from "@earendil-works/pi-ai";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { createExtensionRuntime } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/index.js";
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

function makeNonTerminatingTool() {
	return {
		name: "non_terminating_probe",
		label: "Non-terminating probe",
		description: "THROWAWAY SPIKE tool proving mixed batches do not terminate.",
		parameters: Type.Object({ note: Type.String() }, { additionalProperties: false }),
		async execute(_toolCallId, params) {
			return {
				content: [{ type: "text", text: params.note }],
				details: params,
			};
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
	return () => {
		const message = messages[index++];
		assert.ok(message, "mock stream should not be called after scripted messages are exhausted");
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => stream.push({ type: "done", reason: message.stopReason, message }));
		return stream;
	};
}

function makeAgent({ tools = [], messages, events = [] }) {
	const agent = new Agent({
		initialState: {
			systemPrompt: "THROWAWAY SPIKE system prompt",
			model: mockModel,
			thinkingLevel: "off",
			tools,
		},
		streamFn: mockStreamFrom(messages),
	});
	agent.subscribe((event) => {
		events.push(event);
	});
	return agent;
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

function noExtensionResourceLoader() {
	return {
		getExtensions() {
			return {
				extensions: [],
				errors: [],
				runtime: createExtensionRuntime(),
			};
		},
		getSkills() { return { skills: [], diagnostics: [] }; },
		getPrompts() { return { prompts: [], diagnostics: [] }; },
		getThemes() { return { themes: [], diagnostics: [] }; },
		getAgentsFiles() { return { agentsFiles: [] }; },
		getSystemPrompt() { return undefined; },
		getAppendSystemPrompt() { return []; },
		extendResources() {},
		async reload() {},
	};
}

describe("THROWAWAY submit_result structured-output spike", () => {
	it("A: TypeBox schema validation accepts good args and rejects bad args", () => {
		const { tool } = makeSubmitResultTool();
		const good = { status: "ok", summary: "done", result: "full result", artifacts: ["/tmp/a"] };
		const accepted = validateToolArguments(tool, { type: "toolCall", id: "good", name: "submit_result", arguments: good });
		assert.deepEqual(accepted, good);

		assert.throws(
			() => validateToolArguments(tool, { type: "toolCall", id: "missing", name: "submit_result", arguments: { status: "ok", result: "no summary" } }),
			/summary|Expected required property/,
		);
		assert.throws(
			() => validateToolArguments(tool, { type: "toolCall", id: "bad-status", name: "submit_result", arguments: { status: "maybe", summary: "x", result: "y" } }),
			/status|Expected union value/,
		);
		assert.throws(
			() => validateToolArguments(tool, { type: "toolCall", id: "extra", name: "submit_result", arguments: { status: "ok", summary: "x", result: "y", surprise: true } }),
			/surprise|Unexpected property/,
		);
	});

	it("B: lone submit_result terminate:true executes and ends the Agent loop without another LLM turn", async () => {
		const { tool, calls } = makeSubmitResultTool();
		const events = [];
		const args = { status: "ok", summary: "finished", result: "structured payload" };
		const agent = makeAgent({
			tools: [tool],
			events,
			messages: [assistantMessage([{ type: "toolCall", id: "submit-1", name: "submit_result", arguments: args }])],
		});

		await agent.prompt("finish with submit_result");

		assert.equal(calls.length, 1);
		assert.deepEqual(calls[0], { toolCallId: "submit-1", params: args });
		assert.deepEqual(agent.state.messages.map((message) => message.role), ["user", "assistant", "toolResult"]);
		assert.equal(agent.state.messages.at(-1).toolName, "submit_result");
		assert.equal(agent.state.messages.at(-1).details.terminate, undefined, "terminate is consumed by loop, not copied to toolResult details");
		assert.deepEqual(events.filter((event) => event.type === "message_end").map((event) => event.message.role), ["user", "assistant", "toolResult"]);
		assert.equal(events.filter((event) => event.type === "turn_start").length, 1, "no second LLM turn");
		assert.equal(events.at(-1).type, "agent_end");
	});

	it("B-note: submit_result mixed with a non-terminating tool does not terminate the batch", async () => {
		const { tool: submitTool } = makeSubmitResultTool();
		const events = [];
		const agent = makeAgent({
			tools: [submitTool, makeNonTerminatingTool()],
			events,
			messages: [
				assistantMessage([
					{ type: "toolCall", id: "submit-1", name: "submit_result", arguments: { status: "ok", summary: "done", result: "mixed" } },
					{ type: "toolCall", id: "probe-1", name: "non_terminating_probe", arguments: { note: "keeps loop alive" } },
				]),
				assistantMessage([{ type: "text", text: "second assistant turn after mixed batch" }], "stop"),
			],
		});

		await agent.prompt("finish plus other tool");

		assert.deepEqual(agent.state.messages.map((message) => message.role), ["user", "assistant", "toolResult", "toolResult", "assistant"]);
		assert.equal(events.filter((event) => event.type === "turn_start").length, 2, "mixed terminating and non-terminating tool calls force a second LLM turn");
		assert.equal(lastAssistantText(agent.state.messages), "second assistant turn after mixed batch");
	});

	it("C: createAgentSession registers executable customTools under sdk source and makes them active/invokable", async () => {
		const { tool } = makeSubmitResultTool();
		const { session } = await createAgentSession({
			cwd: process.cwd(),
			model: mockModel,
			thinkingLevel: "off",
			tools: ["submit_result"],
			customTools: [tool],
			resourceLoader: noExtensionResourceLoader(),
			sessionManager: SessionManager.inMemory(process.cwd()),
		});
		try {
			const allTools = session.getAllTools();
			const registered = allTools.find((candidate) => candidate.name === "submit_result");
			assert.ok(registered);
			assert.equal(registered.sourceInfo.source, "sdk");
			assert.deepEqual(session.getActiveToolNames(), ["submit_result"]);
			const definition = session.getToolDefinition("submit_result");
			assert.equal(typeof definition?.execute, "function");
			const result = await definition.execute("manual-call", { status: "ok", summary: "registry", result: "invoked" }, new AbortController().signal, () => {}, {});
			assert.equal(result.terminate, true);
			assert.equal(result.details.summary, "registry");
		}
		finally {
			session.dispose();
		}
	});

	it("D: final assistant text without submit_result is recoverable and can be wrapped in fallback envelope", async () => {
		const events = [];
		const text = "Plain final assistant prose with no structured submit_result call.";
		const agent = makeAgent({
			events,
			messages: [assistantMessage([{ type: "text", text }], "stop")],
		});

		await agent.prompt("answer in prose");

		assert.deepEqual(agent.state.messages.map((message) => message.role), ["user", "assistant"]);
		assert.equal(events.filter((event) => event.type === "tool_execution_start").length, 0);
		const recovered = lastAssistantText(agent.state.messages);
		assert.equal(recovered, text);
		assert.deepEqual(envelopeFromAssistantText(recovered), {
			status: "ok",
			summary: "Plain final assistant prose with no structured submit_result call.",
			result: text,
			artifacts: [],
		});
	});
});
