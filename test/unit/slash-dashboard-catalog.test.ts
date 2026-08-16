import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { registerSlashCommands } from "../../src/surfaces/slash-commands.ts";
import type { SubagentState } from "../../src/protocol/types.ts";

function state(): SubagentState {
	return {
		baseCwd: "/project",
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

describe("dashboard renderer catalog", () => {
	it("ensures the activation catalog on every open and still opens when initialization is unavailable", async () => {
		let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
		const pi = {
			registerCommand(name: string, spec: { handler(args: string, ctx: unknown): Promise<void> }) {
				if (name === "subagents-status") handler = spec.handler;
			},
			registerShortcut() {},
			events: { on: () => () => {}, emit: () => {} },
		};
		let ensureCalls = 0;
		const catalog = {
			ensure: async () => {
				ensureCalls++;
				return ensureCalls === 1;
			},
			getToolDefinition: () => undefined,
		};
		registerSlashCommands(pi as never, state(), undefined, undefined, catalog as never);
		let opens = 0;
		const setterValues: boolean[] = [];
		const legends: string[] = [];
		const ctx = {
			cwd: "/project",
			modelRegistry: {},
			sessionManager: { getSessionId: () => "session", getBranch: () => [] },
			ui: {
				getToolsExpanded: () => false,
				setToolsExpanded: (expanded: boolean) => setterValues.push(expanded),
				custom: async (
					factory: (
						tui: unknown,
						theme: unknown,
						keybindings: unknown,
						done: (value?: undefined) => void,
					) => { render(width: number): string[]; handleInput(data: string): void; dispose(): void },
				) => {
					opens++;
					const component = factory(
						{ requestRender: () => {} },
						{ fg: (_token: string, text: string) => text, bg: (_token: string, text: string) => text },
						{
							getKeys: (binding: string) => {
								if (binding === "app.tools.expand") return ["x"];
								if (binding === "app.thinking.toggle") return ["z"];
								return [];
							},
						},
						() => {},
					);
					legends.push(component.render(100).join("\n"));
					component.handleInput("x");
					component.dispose();
				},
			},
		};

		await handler?.("", ctx);
		await handler?.("", ctx);

		assert.equal(ensureCalls, 2);
		assert.equal(opens, 2);
		assert.ok(legends.every((legend) => /x\s+tools/.test(legend) && /z\s+thinking/.test(legend)));
		assert.deepEqual(setterValues, [true, true]);
	});

	it("prefers relayed sessions and keeps the activation registry as a direct-child fallback", async () => {
		let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
		const pi = {
			registerCommand(name: string, spec: { handler(args: string, ctx: unknown): Promise<void> }) {
				if (name === "subagents-status") handler = spec.handler;
			},
			registerShortcut() {},
			events: { on: () => () => {}, emit: () => {} },
		};
		const runtimeState = state();
		runtimeState.foregroundControls.set("live-run", {
			runId: "live-run",
			started: true,
			mode: "single",
			startedAt: Date.now(),
			updatedAt: Date.now(),
			currentAgent: "worker",
		} as never);
		const directSession = {
			messages: [{ role: "user", content: "direct session fallback", timestamp: 1 }],
			subscribe: () => () => {},
		};
		const relayedSession = {
			messages: [{ role: "user", content: "relayed nested session", timestamp: 1 }],
			subscribe: () => () => {},
		};
		const directRunIds: string[] = [];
		const childRegistry = {
			listRunViews: () => [],
			sessionsForRun: (runId: string) => {
				directRunIds.push(runId);
				return [directSession];
			},
		};
		let relayed = true;
		const requestedRunIds: string[] = [];
		const liveSessionSource = {
			sessionsForRun: (runId: string) => {
				requestedRunIds.push(runId);
				return relayed ? [relayedSession] : [];
			},
		};
		registerSlashCommands(
			pi as never,
			runtimeState,
			undefined,
			childRegistry as never,
			undefined,
			liveSessionSource as never,
		);
		const rendered: string[] = [];
		const ctx = {
			cwd: "/project",
			modelRegistry: {},
			sessionManager: {
				getSessionId: () => undefined,
				getBranch: () => [{ type: "custom", customType: "subagent_run", data: { runId: "live-run" } }],
			},
			ui: {
				custom: async (
					factory: (
						tui: unknown,
						theme: unknown,
						keybindings: unknown,
						done: (value?: undefined) => void,
					) => { render(width: number): string[]; dispose(): void },
				) => {
					const component = factory(
						{ requestRender: () => {}, terminal: { rows: 32 } },
						{ fg: (_token: string, text: string) => text, bg: (_token: string, text: string) => text },
						undefined,
						() => {},
					);
					rendered.push(component.render(120).join("\n"));
					component.dispose();
				},
			},
		};

		await handler?.("", ctx);
		assert.deepEqual(directRunIds, [], "the direct-child registry is not consulted while a relay match exists");
		relayed = false;
		await handler?.("", ctx);

		assert.ok(requestedRunIds.length > 0 && requestedRunIds.every((runId) => runId === "live-run"));
		assert.ok(directRunIds.length > 0 && directRunIds.every((runId) => runId === "live-run"));
		assert.equal(rendered.length, 2);
	});
});
