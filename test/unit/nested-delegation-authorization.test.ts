import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createSubagentExecutor } from "../../src/dispatch/subagent-executor.ts";
import {
	claimPendingChildLineage,
	pushPendingChildLineage,
	setHostLineage,
	type SubagentLineage,
} from "../../src/state/lineage.ts";
import type { WorkflowGroupHandle } from "../../src/workflow/workflow.ts";

const globalStore = globalThis as Record<string, unknown>;
const LINEAGE_STORE_KEY = "__piSubagentLineageBySession";
const AUTH_ENV_KEYS = [
	"PI_SUBAGENT_CURRENT_AGENT",
	"PI_SUBAGENT_PARENT_AGENT",
	"PI_SUBAGENT_CAN_DELEGATE",
	"PI_SUBAGENT_ALLOWED_DELEGATE_AGENTS",
	"PI_SUBAGENT_DEPTH",
	"PI_SUBAGENT_MAX_DEPTH",
] as const;
const originalEnv = new Map<string, string | undefined>();

function setLineageForSession(sessionId: string, lineage: SubagentLineage): void {
	let store = globalStore[LINEAGE_STORE_KEY] as Map<string, SubagentLineage> | undefined;
	if (!store) {
		store = new Map();
		globalStore[LINEAGE_STORE_KEY] = store;
	}
	store.set(sessionId, lineage);
}

function clearLineage(sessionId: string): void {
	const store = globalStore[LINEAGE_STORE_KEY] as Map<string, SubagentLineage> | undefined;
	store?.delete(sessionId);
}

function makeChildLineage(overrides: Partial<SubagentLineage> = {}): SubagentLineage {
	return {
		role: "child",
		currentAgent: "source-agent",
		parentAgent: "parent-agent",
		parentSessionId: "session-parent",
		rootSessionId: "session-parent",
		depth: 1,
		runId: "run-child",
		canDelegate: true,
		allowedDelegateAgents: ["target-agent"],
		maxSubagentDepth: 2,
		...overrides,
	};
}

function makeExecutor(cwd: string, asyncByDefault = false) {
	return (
		createSubagentExecutor as unknown as (deps: Record<string, unknown>) => {
			execute: (
				id: string,
				params: Record<string, unknown>,
				signal: AbortSignal,
				onUpdate: ((result: unknown) => void) | undefined,
				ctx: Record<string, unknown>,
			) => Promise<{ isError?: boolean; content: Array<{ text?: string }>; details?: { mode?: string } }>;
			openWorkflowGroup: (args: {
				toolCallId: string;
				signal: AbortSignal;
				ctx: Record<string, unknown>;
				requestedAsync?: boolean;
			}) => WorkflowGroupHandle;
		}
	)({
		pi: {
			events: { emit: () => {} },
			getSessionName: () => undefined,
			setSessionName: () => {},
		},
		state: {
			baseCwd: cwd,
			currentSessionId: null,
			asyncJobs: new Map(),
			cleanupTimers: new Map(),
			lastUiContext: null,
			poller: null,
		},
		config: {},
		asyncByDefault,
		tempArtifactsDir: cwd,
		expandTilde: (value: string) => value,
		discoverAgents: () => ({
			agents: [{ name: "target-agent", description: "test target" }],
		}),
	});
}

function makeCtx(cwd: string, sessionId: string) {
	return {
		cwd,
		hasUI: false,
		ui: {},
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionFile: () => null,
		},
		modelRegistry: { getAvailable: () => [] },
	};
}

beforeEach(() => {
	for (const key of AUTH_ENV_KEYS) {
		originalEnv.set(key, process.env[key]);
		delete process.env[key];
	}
});

afterEach(() => {
	for (const key of AUTH_ENV_KEYS) {
		const value = originalEnv.get(key);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	originalEnv.clear();
});

describe("nested delegation authorization", () => {
	it("does not let host initialization overwrite authoritative child lineage", () => {
		const sessionId = "session-child-host-refresh";
		const child = makeChildLineage({
			currentAgent: "scoped-child",
			rootSessionId: "session-root",
			runId: "run-child-host-refresh",
		});
		setLineageForSession(sessionId, child);

		try {
			assert.equal(setHostLineage(sessionId, ""), child);
		} finally {
			clearLineage(sessionId);
		}
	});
	it("blocks resume dispatch before a disabled child can restart work", async () => {
		const cwd = "/tmp/pi-subagent-nested-delegation-authorization";
		const sessionId = "session-child-resume-disabled";
		setLineageForSession(
			sessionId,
			makeChildLineage({
				runId: "run-child-resume-disabled",
				canDelegate: false,
				allowedDelegateAgents: [],
			}),
		);

		try {
			const result = await makeExecutor(cwd).execute(
				"call-resume-disabled",
				{ action: "resume", id: "run-not-opened", message: "continue" },
				new AbortController().signal,
				undefined,
				makeCtx(cwd, sessionId),
			);

			assert.equal(result.isError, true);
			assert.match(result.content[0]?.text ?? "", /not allowed to delegate/i);
			assert.doesNotMatch(result.content[0]?.text ?? "", /unknown run/i);
		} finally {
			clearLineage(sessionId);
		}
	});

	it("rejects explicit and default background workflows from a child session", () => {
		const cwd = "/tmp/pi-subagent-nested-delegation-authorization";
		const sessionId = "session-child-workflow-async";
		setLineageForSession(sessionId, makeChildLineage({ runId: "run-child-workflow-async" }));

		try {
			for (const [executor, requestedAsync] of [
				[makeExecutor(cwd), true],
				[makeExecutor(cwd, true), undefined],
			] as const) {
				assert.throws(
					() =>
						executor.openWorkflowGroup({
							toolCallId: "call-workflow-async",
							signal: new AbortController().signal,
							ctx: makeCtx(cwd, sessionId),
							...(requestedAsync === undefined ? {} : { requestedAsync }),
						}),
					/only allowed from the host session/i,
				);
			}
		} finally {
			clearLineage(sessionId);
		}
	});
	it("blocks a direct executor dispatch from a child that cannot delegate without env identity", async () => {
		const cwd = "/tmp/pi-subagent-nested-delegation-authorization";
		const sessionId = "session-child-disabled";
		setLineageForSession(
			sessionId,
			makeChildLineage({ runId: "run-child-disabled", canDelegate: false, allowedDelegateAgents: [] }),
		);

		try {
			const result = await makeExecutor(cwd).execute(
				"call-direct",
				{ run: [{ agent: "target-agent", task: "do work" }] },
				new AbortController().signal,
				undefined,
				makeCtx(cwd, sessionId),
			);

			assert.equal(result.isError, true);
			assert.equal(result.details?.mode, "single");
			assert.match(result.content[0]?.text ?? "", /not allowed to delegate/i);
		} finally {
			clearLineage(sessionId);
		}
	});

	it("blocks a direct executor target outside the child lineage allowlist", async () => {
		const cwd = "/tmp/pi-subagent-nested-delegation-authorization";
		const sessionId = "session-child-restricted";
		setLineageForSession(
			sessionId,
			makeChildLineage({ runId: "run-child-restricted", allowedDelegateAgents: ["allowed-agent"] }),
		);

		try {
			const result = await makeExecutor(cwd).execute(
				"call-disallowed-target",
				{ run: [{ agent: "target-agent", task: "do work" }] },
				new AbortController().signal,
				undefined,
				makeCtx(cwd, sessionId),
			);

			assert.equal(result.isError, true);
			assert.match(result.content[0]?.text ?? "", /may only delegate to allowed-agent/i);
		} finally {
			clearLineage(sessionId);
		}
	});

	it("blocks a direct parallel executor dispatch before child work starts", async () => {
		const cwd = "/tmp/pi-subagent-nested-delegation-authorization";
		const sessionId = "session-child-parallel-disabled";
		setLineageForSession(
			sessionId,
			makeChildLineage({ runId: "run-child-parallel-disabled", canDelegate: false, allowedDelegateAgents: [] }),
		);

		try {
			const result = await makeExecutor(cwd).execute(
				"call-parallel",
				{
					run: [
						{ agent: "target-agent", task: "first" },
						{ agent: "target-agent", task: "second" },
					],
				},
				new AbortController().signal,
				undefined,
				makeCtx(cwd, sessionId),
			);

			assert.equal(result.isError, true);
			assert.equal(result.details?.mode, "parallel");
			assert.match(result.content[0]?.text ?? "", /not allowed to delegate/i);
		} finally {
			clearLineage(sessionId);
		}
	});

	it("allows a direct executor target authorized by child lineage", async () => {
		const cwd = "/tmp/pi-subagent-nested-delegation-authorization";
		const sessionId = "session-child-allowed";
		setLineageForSession(sessionId, makeChildLineage({ runId: "run-child-allowed" }));

		try {
			const result = await makeExecutor(cwd).execute(
				"call-allowed-target",
				{ run: [{ agent: "target-agent", task: "do work" }] },
				new AbortController().signal,
				undefined,
				makeCtx(cwd, sessionId),
			);

			assert.equal(/Nested subagent call blocked/i.test(result.content[0]?.text ?? ""), false);
			assert.match(result.content[0]?.text ?? "", /No model available/i);
		} finally {
			clearLineage(sessionId);
		}
	});

	it("blocks a child lineage at its effective maximum depth", async () => {
		const cwd = "/tmp/pi-subagent-nested-delegation-authorization";
		const sessionId = "session-child-max-depth";
		setLineageForSession(
			sessionId,
			makeChildLineage({ rootSessionId: "session-root", depth: 2, runId: "run-child-max-depth" }),
		);

		try {
			const result = await makeExecutor(cwd).execute(
				"call-at-max-depth",
				{ run: [{ agent: "target-agent", task: "do work" }] },
				new AbortController().signal,
				undefined,
				makeCtx(cwd, sessionId),
			);

			assert.equal(result.isError, true);
			assert.match(result.content[0]?.text ?? "", /depth=2, max=2/i);
		} finally {
			clearLineage(sessionId);
		}
	});

	it("blocks workflow dispatch before a disabled child starts work", () => {
		const cwd = "/tmp/pi-subagent-nested-delegation-authorization";
		const sessionId = "session-child-workflow-disabled";
		setLineageForSession(
			sessionId,
			makeChildLineage({
				runId: "run-child-workflow-disabled",
				canDelegate: false,
				allowedDelegateAgents: [],
			}),
		);

		try {
			assert.throws(
				() =>
					makeExecutor(cwd).openWorkflowGroup({
						toolCallId: "call-workflow",
						signal: new AbortController().signal,
						ctx: makeCtx(cwd, sessionId),
					}),
				/not allowed to delegate/i,
			);
		} finally {
			clearLineage(sessionId);
		}
	});

	it("authorizes each workflow child target before work starts", async () => {
		const cwd = "/tmp/pi-subagent-nested-delegation-authorization";
		const sessionId = "session-child-workflow-restricted";
		setLineageForSession(
			sessionId,
			makeChildLineage({
				runId: "run-child-workflow-restricted",
				allowedDelegateAgents: ["allowed-agent"],
			}),
		);

		try {
			const group = makeExecutor(cwd).openWorkflowGroup({
				toolCallId: "call-workflow-target",
				signal: new AbortController().signal,
				ctx: makeCtx(cwd, sessionId),
			});
			await assert.rejects(
				group.dispatchChild({ role: "target-agent", task: "do work", index: 0 }),
				/may only delegate to allowed-agent/i,
			);
		} finally {
			clearLineage(sessionId);
		}
	});

	it("fails closed when child lineage is missing delegation authorization", async () => {
		const cwd = "/tmp/pi-subagent-nested-delegation-authorization";
		const sessionId = "session-child-missing-authorization";
		process.env.PI_SUBAGENT_CURRENT_AGENT = "legacy-agent";
		process.env.PI_SUBAGENT_CAN_DELEGATE = "1";
		process.env.PI_SUBAGENT_ALLOWED_DELEGATE_AGENTS = "target-agent";
		process.env.PI_SUBAGENT_DEPTH = "0";
		process.env.PI_SUBAGENT_MAX_DEPTH = "9";
		setLineageForSession(sessionId, {
			role: "child",
			currentAgent: "source-agent",
			parentAgent: "parent-agent",
			parentSessionId: "session-parent",
			rootSessionId: "session-parent",
			depth: 1,
			runId: "run-child-missing-authorization",
		});

		try {
			const result = await makeExecutor(cwd).execute(
				"call-missing-authorization",
				{ run: [{ agent: "target-agent", task: "do work" }] },
				new AbortController().signal,
				undefined,
				makeCtx(cwd, sessionId),
			);

			assert.equal(result.isError, true);
			assert.match(result.content[0]?.text ?? "", /authorization is unavailable/i);
		} finally {
			clearLineage(sessionId);
		}
	});

	it("preserves host dispatch behavior when stale env policy is restrictive", async () => {
		const cwd = "/tmp/pi-subagent-nested-delegation-authorization";
		const sessionId = "session-host";
		process.env.PI_SUBAGENT_CURRENT_AGENT = "stale-agent";
		process.env.PI_SUBAGENT_CAN_DELEGATE = "0";
		process.env.PI_SUBAGENT_DEPTH = "9";
		process.env.PI_SUBAGENT_MAX_DEPTH = "0";
		setLineageForSession(sessionId, {
			role: "host",
			currentAgent: "host-agent",
			parentAgent: null,
			parentSessionId: null,
			rootSessionId: sessionId,
			depth: 0,
			runId: null,
		});

		try {
			const result = await makeExecutor(cwd).execute(
				"call-host",
				{ run: [{ agent: "target-agent", task: "do work" }] },
				new AbortController().signal,
				undefined,
				makeCtx(cwd, sessionId),
			);

			assert.equal(/Nested subagent call blocked/i.test(result.content[0]?.text ?? ""), false);
			assert.match(result.content[0]?.text ?? "", /No model available/i);
		} finally {
			clearLineage(sessionId);
		}
	});

	it("uses legacy env authorization when current-session lineage is absent", async () => {
		const cwd = "/tmp/pi-subagent-nested-delegation-authorization";
		process.env.PI_SUBAGENT_CURRENT_AGENT = "legacy-agent";
		process.env.PI_SUBAGENT_CAN_DELEGATE = "0";
		process.env.PI_SUBAGENT_DEPTH = "1";
		process.env.PI_SUBAGENT_MAX_DEPTH = "3";

		const result = await makeExecutor(cwd).execute(
			"call-legacy-env",
			{ run: [{ agent: "target-agent", task: "do work" }] },
			new AbortController().signal,
			undefined,
			makeCtx(cwd, "session-without-lineage"),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /not allowed to delegate/i);
	});

	it("uses lineage identity before stale environment identity for self-fork checks", async () => {
		const cwd = "/tmp/pi-subagent-nested-delegation-authorization";
		const sessionId = "session-child-fork";
		process.env.PI_SUBAGENT_CURRENT_AGENT = "stale-agent";
		setLineageForSession(
			sessionId,
			makeChildLineage({
				currentAgent: "target-agent",
				runId: "run-child-fork",
				allowedDelegateAgents: ["target-agent"],
			}),
		);

		try {
			const result = await makeExecutor(cwd).execute(
				"call-fork",
				{ run: [{ agent: "target-agent", task: "continue", context: "fork" }] },
				new AbortController().signal,
				undefined,
				makeCtx(cwd, sessionId),
			);

			assert.doesNotMatch(result.content[0]?.text ?? "", /stale-agent/);
			assert.match(result.content[0]?.text ?? "", /persisted parent session/i);
		} finally {
			clearLineage(sessionId);
		}
	});

	it("does not overwrite prebound lineage when concurrent pending children activate out of order", () => {
		const firstSessionId = "session-prebound-first";
		const secondSessionId = "session-prebound-second";
		const first = makeChildLineage({
			currentAgent: "first-child",
			runId: "run-prebound-first",
			canDelegate: false,
			allowedDelegateAgents: [],
		});
		const second = makeChildLineage({
			currentAgent: "second-child",
			runId: "run-prebound-second",
			canDelegate: true,
		});
		pushPendingChildLineage(first);
		pushPendingChildLineage(second);
		setLineageForSession(secondSessionId, second);

		try {
			assert.equal(claimPendingChildLineage(secondSessionId, { runId: null, agentName: null }), second);
			assert.equal(claimPendingChildLineage(firstSessionId, { runId: null, agentName: null }), first);
		} finally {
			clearLineage(firstSessionId);
			clearLineage(secondSessionId);
		}
	});

	it("keeps two session lineages with opposite policies isolated", async () => {
		const cwd = "/tmp/pi-subagent-nested-delegation-authorization";
		const blockedSessionId = "session-interleaved-blocked";
		const allowedSessionId = "session-interleaved-allowed";
		setLineageForSession(
			blockedSessionId,
			makeChildLineage({
				currentAgent: "blocked-agent",
				runId: "run-interleaved-blocked",
				canDelegate: false,
				allowedDelegateAgents: [],
			}),
		);
		setLineageForSession(
			allowedSessionId,
			makeChildLineage({ currentAgent: "allowed-agent", runId: "run-interleaved-allowed" }),
		);

		try {
			const executor = makeExecutor(cwd);
			const [blocked, allowed] = await Promise.all([
				executor.execute(
					"call-interleaved-blocked",
					{ run: [{ agent: "target-agent", task: "first" }] },
					new AbortController().signal,
					undefined,
					makeCtx(cwd, blockedSessionId),
				),
				executor.execute(
					"call-interleaved-allowed",
					{ run: [{ agent: "target-agent", task: "second" }] },
					new AbortController().signal,
					undefined,
					makeCtx(cwd, allowedSessionId),
				),
			]);

			assert.match(blocked.content[0]?.text ?? "", /not allowed to delegate/i);
			assert.equal(/Nested subagent call blocked/i.test(allowed.content[0]?.text ?? ""), false);
			assert.match(allowed.content[0]?.text ?? "", /No model available/i);
		} finally {
			clearLineage(blockedSessionId);
			clearLineage(allowedSessionId);
		}
	});
});
