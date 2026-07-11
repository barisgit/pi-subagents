import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { registerSlashCommands } from "../../src/surfaces/slash-commands.ts";
import type { SubagentState } from "../../src/protocol/types.ts";

const SLASH_SUBAGENT_REQUEST_EVENT = "subagent:slash:request";
const SLASH_SUBAGENT_STARTED_EVENT = "subagent:slash:started";
const SLASH_SUBAGENT_RESPONSE_EVENT = "subagent:slash:response";

interface EventBus {
	on(event: string, handler: (data: unknown) => void): () => void;
	emit(event: string, data: unknown): void;
}

function createEventBus(): EventBus {
	const handlers = new Map<string, Array<(data: unknown) => void>>();
	return {
		on(event, handler) {
			const existing = handlers.get(event) ?? [];
			existing.push(handler);
			handlers.set(event, existing);
			return () => {
				handlers.set(
					event,
					(handlers.get(event) ?? []).filter((entry) => entry !== handler),
				);
			};
		},
		emit(event, data) {
			for (const handler of handlers.get(event) ?? []) handler(data);
		},
	};
}

let tempHome = "";
let tempProject = "";
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalPreset = process.env.PI_PRESET;
const originalPiAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalFiAgentDir = process.env.FI_CODING_AGENT_DIR;

function writeProjectAgent(name: string): void {
	const filePath = path.join(tempProject, ".pi", "agents", `${name}.md`);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(
		filePath,
		`---\nname: ${name}\ndescription: ${name} agent\nmodel: anthropic/claude-sonnet-4\n---\nYou are ${name}.\n`,
		"utf-8",
	);
}

function createState(cwd: string): SubagentState {
	return {
		baseCwd: cwd,
		currentSessionId: null,
		asyncJobs: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		usageByRun: new Map(),
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
	} as unknown as SubagentState;
}

function createCommandContext(notifications: string[]) {
	return {
		cwd: tempProject,
		hasUI: false,
		ui: {
			notify: (message: string) => {
				notifications.push(message);
			},
			setStatus: (_key: string, _text: string | undefined) => {},
			onTerminalInput: () => () => {},
			custom: async () => undefined,
		},
		modelRegistry: { getAvailable: () => [] },
		sessionManager: undefined,
	};
}

interface CommandSpec {
	handler(args: string, ctx: unknown): Promise<void>;
}

function setupSlashHarness() {
	const commands = new Map<string, CommandSpec>();
	const events = createEventBus();
	const requested: Array<{ preset?: string; run?: Array<{ agent: string }> }> = [];
	events.on(SLASH_SUBAGENT_REQUEST_EVENT, (data) => {
		const payload = data as { requestId: string; params?: { preset?: string; run?: Array<{ agent: string }> } };
		requested.push({ preset: payload.params?.preset, run: payload.params?.run });
		events.emit(SLASH_SUBAGENT_STARTED_EVENT, { requestId: payload.requestId });
		events.emit(SLASH_SUBAGENT_RESPONSE_EVENT, {
			requestId: payload.requestId,
			result: { content: [{ type: "text", text: "done" }], details: { mode: "single", results: [] } },
			isError: false,
		});
	});
	const pi = {
		events,
		registerCommand(name: string, spec: CommandSpec) {
			commands.set(name, spec);
		},
		registerShortcut() {},
		sendMessage() {},
	};
	registerSlashCommands(pi as never, createState(tempProject));
	return { commands, requested };
}

// Two strict presets with disjoint agents: `a-agent` exists only under preset A
// (the config default), `b-agent` only under preset B. Selecting preset=B must
// carry through to the dispatched params -- otherwise execution rediscovers
// under the default preset and the B-only agent fails or loses its overlay.
describe("slash preset dispatch", () => {
	beforeEach(() => {
		tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-slash-preset-home-"));
		tempProject = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-slash-preset-project-"));
		process.env.HOME = tempHome;
		process.env.USERPROFILE = tempHome;
		process.env.PI_CODING_AGENT_DIR = path.join(tempHome, ".pi", "agent");
		process.env.FI_CODING_AGENT_DIR = path.join(tempHome, ".pi", "agent");
		delete process.env.PI_PRESET;
		writeProjectAgent("a-agent");
		writeProjectAgent("b-agent");
		const configPath = path.join(tempHome, ".pi", "agent", "subagent.json");
		fs.mkdirSync(path.dirname(configPath), { recursive: true });
		fs.writeFileSync(
			configPath,
			JSON.stringify({
				defaultPreset: "A",
				presets: {
					A: { strictAgents: true, agents: { "a-agent": {} } },
					B: { strictAgents: true, agents: { "b-agent": {} } },
				},
			}),
			"utf-8",
		);
	});

	afterEach(() => {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		if (originalUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = originalUserProfile;
		if (originalPreset === undefined) delete process.env.PI_PRESET;
		else process.env.PI_PRESET = originalPreset;
		if (originalPiAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalPiAgentDir;
		if (originalFiAgentDir === undefined) delete process.env.FI_CODING_AGENT_DIR;
		else process.env.FI_CODING_AGENT_DIR = originalFiAgentDir;
		fs.rmSync(tempHome, { recursive: true, force: true });
		fs.rmSync(tempProject, { recursive: true, force: true });
	});

	it("/run threads the resolved preset into the dispatched params", async () => {
		const { commands, requested } = setupSlashHarness();
		const notifications: string[] = [];

		await commands.get("run")!.handler("[preset=B] b-agent inspect this", createCommandContext(notifications));

		assert.deepEqual(notifications, []);
		assert.equal(requested.length, 1);
		assert.equal(requested[0]!.preset, "B");
		assert.equal(requested[0]!.run?.[0]?.agent, "b-agent");
	});

	it("/parallel threads the resolved top-level preset into the dispatched params", async () => {
		const { commands, requested } = setupSlashHarness();
		const notifications: string[] = [];

		await commands
			.get("parallel")!
			.handler("[preset=B] b-agent -- scan the code", createCommandContext(notifications));

		assert.deepEqual(notifications, []);
		assert.equal(requested.length, 1);
		assert.equal(requested[0]!.preset, "B");
		assert.equal(requested[0]!.run?.[0]?.agent, "b-agent");
	});

	it("/parallel resolves per-step presets before validating agents", async () => {
		const { commands, requested } = setupSlashHarness();
		const notifications: string[] = [];

		// No top-level preset: the step-level preset=B must be resolved BEFORE the
		// agent catalog is validated, or the B-only agent is rejected under the
		// default preset A.
		await commands
			.get("parallel")!
			.handler("b-agent[preset=B] -- scan the code", createCommandContext(notifications));

		assert.deepEqual(notifications, []);
		assert.equal(requested.length, 1);
		assert.equal(requested[0]!.preset, "B");
		assert.equal(requested[0]!.run?.[0]?.agent, "b-agent");
	});
});
