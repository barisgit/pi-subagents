import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { prepareChildStep } from "../../src/dispatch/prepare-child-step.ts";
import { SUBMIT_RESULT_SYSTEM_INSTRUCTION, SUBMIT_RESULT_TOOL_NAME } from "../../src/protocol/submit-result.ts";

// A realistic fake model the registry hands back. The shape only needs the
// fields prepareChildStep reads/copies onto the step (provider/id), but we keep
// a believable object so the ChildAgentStep.model contract round-trips.
function makeModel(provider: string, id: string) {
	return { provider, id, displayName: `${provider}/${id}` };
}

const AVAILABLE_MODELS = [makeModel("anthropic", "claude-sonnet"), makeModel("openai", "gpt-x")];

function makeAgentConfig(overrides: Record<string, unknown> = {}) {
	return {
		name: "tester",
		description: "test agent",
		systemPrompt: "You are a tester.",
		model: "claude-sonnet",
		tools: ["read", "bash"],
		skills: [],
		...overrides,
	} as never;
}

function makeData(cwd: string, overrides: Record<string, unknown> = {}) {
	return {
		params: {},
		effectiveCwd: cwd,
		ctx: {
			cwd,
			model: { provider: "anthropic" },
			modelRegistry: {
				getAvailable: () => AVAILABLE_MODELS,
				find: (provider: string, id: string) =>
					AVAILABLE_MODELS.find((m) => m.provider === provider && m.id === id),
			},
			sessionManager: {
				getSessionId: () => "session-host",
				getSessionFile: () => null,
			},
		},
		signal: new AbortController().signal,
		agents: [],
		runId: "run-abc",
		rootRunId: "run-abc",
		shareEnabled: false,
		sessionRoot: cwd,
		sessionDirForIndex: () => cwd,
		sessionFileForIndex: () => undefined,
		artifactConfig: { enabled: false },
		artifactsDir: path.join(cwd, "artifacts"),
		backgroundRequestedWhileClarifying: false,
		effectiveAsync: false,
		controlConfig: {},
		intercomBridge: { active: false, orchestratorTarget: undefined },
		...overrides,
	} as never;
}

function makeDeps(cwd: string, overrides: Record<string, unknown> = {}) {
	return {
		pi: { getAllTools: () => [] },
		state: { currentSessionId: "session-host" },
		config: {},
		asyncByDefault: false,
		tempArtifactsDir: cwd,
		childRegistry: {},
		expandTilde: (p: string) => p,
		discoverAgents: () => ({ agents: [] }),
		...overrides,
	} as never;
}

describe("prepareChildStep", () => {
	const cwd = os.tmpdir();

	it("builds a ChildAgentStep with the real contract for a non-fork child", () => {
		const result = prepareChildStep({
			data: makeData(cwd),
			deps: makeDeps(cwd),
			agentConfig: makeAgentConfig(),
			stepIndex: 0,
			cwd,
			task: "do the thing",
			skillNames: [],
			maxSubagentDepth: 3,
		});
		assert.ok(!("error" in result), "expected a successful step, not the no-model sentinel");
		const { step } = result;
		assert.equal(step.agentName, "tester");
		assert.equal(step.task, "do the thing");
		assert.equal(step.runId, "run-abc");
		assert.equal(step.rootRunId, "run-abc");
		assert.equal(step.maxSubagentDepth, 3);
		// model resolved from the registry by bare id
		assert.equal(step.model.provider, "anthropic");
		assert.equal(step.model.id, "claude-sonnet");
		// non-fork systemPrompt carries the submit-result finish contract
		assert.ok(step.systemPrompt.includes("You are a tester."));
		assert.ok(step.systemPrompt.includes(SUBMIT_RESULT_SYSTEM_INSTRUCTION));
		// tools: explicit allowlist gains submit_result; submit_result tool injected as a custom tool
		assert.ok(step.activeToolNames?.includes("read"));
		assert.ok(step.activeToolNames?.includes(SUBMIT_RESULT_TOOL_NAME));
		assert.ok(step.customTools.some((t) => t.name === SUBMIT_RESULT_TOOL_NAME));
		// session paths derive from runId + stepIndex
		assert.ok(step.sessionFile.includes("run-abc"));
		assert.ok(step.sessionFile.includes("run-0"));
		assert.equal(step.intercom, undefined);
		assert.equal(step.outputPath, undefined);
	});

	it("returns the no-model sentinel when no model resolves", () => {
		const data = makeData(cwd, {
			ctx: {
				cwd,
				model: undefined,
				modelRegistry: { getAvailable: () => [], find: () => undefined },
				sessionManager: { getSessionId: () => "session-host", getSessionFile: () => null },
			},
		});
		const result = prepareChildStep({
			data,
			deps: makeDeps(cwd),
			agentConfig: makeAgentConfig({ model: undefined }),
			stepIndex: 0,
			cwd,
			task: "do the thing",
			skillNames: [],
			maxSubagentDepth: 3,
		});
		assert.ok("error" in result);
		assert.equal(result.error, "no-model");
	});

	it("preserves an empty systemPrompt for fork-reuse children", () => {
		const data = makeData(cwd, {
			forkReuse: { agentName: "tester", sessionId: "session-fork" },
		});
		const result = prepareChildStep({
			data,
			deps: makeDeps(cwd),
			agentConfig: makeAgentConfig(),
			stepIndex: 0,
			cwd,
			task: "resume work",
			skillNames: [],
			maxSubagentDepth: 3,
		});
		assert.ok(!("error" in result));
		// fork-reuse keeps the inherited session prompt: empty, NOT the submit-result text
		assert.equal(result.step.systemPrompt, "");
		assert.deepEqual(result.step.skillsResolved, []);
	});

	it("honors the foreground layer0 override for run identity and session paths", () => {
		const result = prepareChildStep({
			data: makeData(cwd),
			deps: makeDeps(cwd),
			agentConfig: makeAgentConfig(),
			stepIndex: 2,
			cwd,
			task: "layer0 task",
			skillNames: [],
			maxSubagentDepth: 3,
			layer0: {
				runId: "layer0-run",
				sessionFile: "/custom/layer0/session.jsonl",
				runRecordDir: "/custom/layer0",
				rootRunId: "layer0-root",
			},
		});
		assert.ok(!("error" in result));
		assert.equal(result.step.runId, "layer0-run");
		assert.equal(result.step.rootRunId, "layer0-root");
		assert.equal(result.step.sessionFile, "/custom/layer0/session.jsonl");
		assert.equal(result.step.runRecordDir, "/custom/layer0");
	});

	it("attaches a caller-computed intercom object when provided", () => {
		const result = prepareChildStep({
			data: makeData(cwd),
			deps: makeDeps(cwd),
			agentConfig: makeAgentConfig(),
			stepIndex: 0,
			cwd,
			task: "intercom task",
			skillNames: [],
			maxSubagentDepth: 3,
			intercom: { selfTarget: "self-1", bridgeTarget: "orchestrator-1" },
		});
		assert.ok(!("error" in result));
		assert.deepEqual(result.step.intercom, { selfTarget: "self-1", bridgeTarget: "orchestrator-1" });
	});
});
