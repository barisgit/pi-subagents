import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createSubagentExecutor } from "../../src/dispatch/subagent-executor.ts";
import {
	claimPendingChildLineage,
	getLineageForSession,
	pushPendingChildLineage,
	removeChildLineageBindings,
	removePendingChildLineage,
	setChildLineage,
	setHostLineage,
	type SubagentLineage,
} from "../../src/state/lineage.ts";
import type { WorkflowGroupHandle } from "../../src/workflow/workflow.ts";

const globalStore = globalThis as Record<string, unknown>;
const LINEAGE_STORE_KEY = "__piSubagentLineageBySession";
const PENDING_SESSION_FILES_KEY = "__piSubagentLineagePendingSessionFiles";
const BOUND_SESSION_FILES_KEY = "__piSubagentLineageBoundSessionFiles";
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
	const sessionFiles = globalStore[BOUND_SESSION_FILES_KEY] as Map<string, string> | undefined;
	sessionFiles?.delete(sessionId);
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

it("removes the exact prebound pending lineage when run ids are duplicate nulls", () => {
	const preboundSessionId = "session-prebound-null-run-id";
	const unrelatedSessionId = "session-unrelated-null-run-id";
	const unrelated = makeChildLineage({ currentAgent: "unrelated-child", runId: null });
	const prebound = makeChildLineage({ currentAgent: "prebound-child", runId: null });
	pushPendingChildLineage(unrelated);
	pushPendingChildLineage(prebound);
	setLineageForSession(preboundSessionId, prebound);

	try {
		assert.equal(claimPendingChildLineage(preboundSessionId, { runId: null, agentName: null }), prebound);
		assert.equal(claimPendingChildLineage(unrelatedSessionId, { runId: null, agentName: null }), unrelated);
	} finally {
		clearLineage(preboundSessionId);
		clearLineage(unrelatedSessionId);
	}
});

it("claims concurrent pending lineages out of order by session file", () => {
	const firstSessionId = "session-file-first";
	const secondSessionId = "session-file-second";
	const firstSessionFile = "/tmp/session-file-first.jsonl";
	const secondSessionFile = "/tmp/session-file-second.jsonl";
	const first = makeChildLineage({ currentAgent: "first-child", runId: "run-session-file-first" });
	const second = makeChildLineage({ currentAgent: "second-child", runId: "run-session-file-second" });
	pushPendingChildLineage(first, firstSessionFile);
	pushPendingChildLineage(second, secondSessionFile);

	try {
		assert.equal(
			claimPendingChildLineage(secondSessionId, {
				runId: null,
				agentName: null,
				sessionFile: secondSessionFile,
			}),
			second,
		);
		assert.equal(
			claimPendingChildLineage(firstSessionId, {
				runId: null,
				agentName: null,
				sessionFile: firstSessionFile,
			}),
			first,
		);
	} finally {
		claimPendingChildLineage(firstSessionId, { runId: first.runId, agentName: null });
		claimPendingChildLineage(secondSessionId, { runId: second.runId, agentName: null });
		clearLineage(firstSessionId);
		clearLineage(secondSessionId);
	}
});

it("fails closed when a session file does not match the pending lineage", () => {
	const sessionId = "session-file-match";
	const sessionFile = "/tmp/session-file-match.jsonl";
	const lineage = makeChildLineage({ runId: "run-session-file-match" });
	pushPendingChildLineage(lineage, sessionFile);

	try {
		assert.equal(
			claimPendingChildLineage("session-file-mismatch", {
				runId: null,
				agentName: null,
				sessionFile: "/tmp/other-session-file.jsonl",
			}),
			null,
		);
		assert.equal(claimPendingChildLineage(sessionId, { runId: null, agentName: null, sessionFile }), lineage);
	} finally {
		claimPendingChildLineage(sessionId, { runId: lineage.runId, agentName: null });
		clearLineage(sessionId);
	}
});

it("fails closed without consuming duplicate session-file lineage authorization", () => {
	const sessionId = "session-file-ambiguous";
	const staleCleanupSessionId = "session-file-ambiguous-stale-cleanup";
	const currentCleanupSessionId = "session-file-ambiguous-current-cleanup";
	const sessionFile = "/tmp/session-file-ambiguous.jsonl";
	const stale = makeChildLineage({
		currentAgent: "stale-authorized-child",
		runId: "run-session-file-ambiguous-stale",
		canDelegate: true,
	});
	const current = makeChildLineage({
		currentAgent: "current-blocked-child",
		runId: "run-session-file-ambiguous-current",
		canDelegate: false,
		allowedDelegateAgents: [],
	});
	pushPendingChildLineage(stale, sessionFile);
	pushPendingChildLineage(current, sessionFile);

	try {
		assert.equal(
			claimPendingChildLineage(sessionId, { runId: null, agentName: null, sessionFile }),
			null,
			"ambiguous session-file authorization must not select the stale authorized lineage",
		);
		assert.equal(getLineageForSession(sessionId), null);
		assert.equal(
			claimPendingChildLineage(staleCleanupSessionId, { runId: stale.runId, agentName: null }),
			stale,
			"the stale lineage must remain pending",
		);
		assert.equal(
			claimPendingChildLineage(currentCleanupSessionId, { runId: current.runId, agentName: null }),
			current,
			"the current lineage must remain pending",
		);
	} finally {
		removePendingChildLineage(stale);
		removePendingChildLineage(current);
		clearLineage(sessionId);
		clearLineage(staleCleanupSessionId);
		clearLineage(currentCleanupSessionId);
	}
});

it("removes only the exact pending lineage and clears its session-file hint", () => {
	const sessionId = "session-file-exact-removal";
	const sessionFile = "/tmp/session-file-exact-removal.jsonl";
	const removed = makeChildLineage({ runId: "run-session-file-exact-removal" });
	const kept = { ...removed };
	pushPendingChildLineage(removed, sessionFile);
	pushPendingChildLineage(kept, sessionFile);

	try {
		removePendingChildLineage(removed);
		const sessionFiles = globalStore[PENDING_SESSION_FILES_KEY] as WeakMap<SubagentLineage, string>;
		assert.equal(sessionFiles.has(removed), false);
		assert.equal(claimPendingChildLineage(sessionId, { runId: null, agentName: null, sessionFile }), kept);
	} finally {
		removePendingChildLineage(removed);
		removePendingChildLineage(kept);
		clearLineage(sessionId);
	}
});

it("removes every session binding for the exact lineage object", () => {
	const firstSessionId = "session-lineage-binding-first";
	const secondSessionId = "session-lineage-binding-second";
	const distinctSessionId = "session-lineage-binding-distinct";
	const lineage = makeChildLineage({ runId: "run-lineage-binding" });
	const distinct = { ...lineage };
	setChildLineage(firstSessionId, lineage, "/tmp/session-lineage-binding-first.jsonl");
	setChildLineage(secondSessionId, lineage, "/tmp/session-lineage-binding-second.jsonl");
	setChildLineage(distinctSessionId, distinct, "/tmp/session-lineage-binding-distinct.jsonl");

	try {
		removeChildLineageBindings(lineage);

		assert.equal(getLineageForSession(firstSessionId), null);
		assert.equal(getLineageForSession(secondSessionId), null);
		assert.equal(getLineageForSession(distinctSessionId), distinct);
		const sessionFiles = globalStore[BOUND_SESSION_FILES_KEY] as Map<string, string> | undefined;
		assert.equal(sessionFiles?.has(firstSessionId), false);
		assert.equal(sessionFiles?.has(secondSessionId), false);
		assert.equal(sessionFiles?.get(distinctSessionId), "/tmp/session-lineage-binding-distinct.jsonl");
	} finally {
		clearLineage(firstSessionId);
		clearLineage(secondSessionId);
		clearLineage(distinctSessionId);
	}
});

it("rejects colliding child bindings without replacing host or child-parent lineage", () => {
	const hostSessionId = "session-lineage-collision-host";
	const childParentSessionId = "session-lineage-collision-child-parent";
	const hostLineage = setHostLineage(hostSessionId, "host-agent");
	const childParentLineage = makeChildLineage({
		currentAgent: "child-parent-agent",
		parentSessionId: hostSessionId,
		rootSessionId: hostSessionId,
	});
	const collidingLineage = makeChildLineage({ currentAgent: "colliding-child" });
	setChildLineage(childParentSessionId, childParentLineage);

	try {
		for (const [sessionId, existing] of [
			[hostSessionId, hostLineage],
			[childParentSessionId, childParentLineage],
		] as const) {
			assert.throws(() => setChildLineage(sessionId, collidingLineage), {
				message: "Cannot replace an existing session lineage binding.",
			});
			assert.equal(getLineageForSession(sessionId), existing);
		}
	} finally {
		clearLineage(hostSessionId);
		clearLineage(childParentSessionId);
	}
});

it("rejects fallback claims without replacing host or child-parent lineage", () => {
	const hostSessionId = "session-lineage-claim-collision-host";
	const childParentSessionId = "session-lineage-claim-collision-child-parent";
	const hostLineage = setHostLineage(hostSessionId, "host-agent");
	const childParentLineage = makeChildLineage({
		currentAgent: "claim-child-parent-agent",
		parentSessionId: hostSessionId,
		rootSessionId: hostSessionId,
	});
	setChildLineage(childParentSessionId, childParentLineage);
	const cases = [
		{
			sessionId: hostSessionId,
			sessionFile: "/tmp/session-lineage-claim-collision-host.jsonl",
			existing: hostLineage,
			pending: makeChildLineage({ currentAgent: "claim-colliding-host-child" }),
		},
		{
			sessionId: childParentSessionId,
			sessionFile: "/tmp/session-lineage-claim-collision-child-parent.jsonl",
			existing: childParentLineage,
			pending: makeChildLineage({ currentAgent: "claim-colliding-child-parent" }),
		},
	] as const;
	for (const entry of cases) pushPendingChildLineage(entry.pending, entry.sessionFile);

	try {
		for (const entry of cases) {
			assert.throws(
				() =>
					claimPendingChildLineage(entry.sessionId, {
						runId: null,
						agentName: null,
						sessionFile: entry.sessionFile,
					}),
				{ message: "Cannot replace an existing session lineage binding." },
			);
			assert.equal(getLineageForSession(entry.sessionId), entry.existing);
		}
	} finally {
		for (const entry of cases) removePendingChildLineage(entry.pending);
		clearLineage(hostSessionId);
		clearLineage(childParentSessionId);
	}
});

it("allows exact same-object child lineage rebinding", () => {
	const sessionId = "session-lineage-same-object-rebinding";
	const lineage = makeChildLineage({ runId: "run-lineage-same-object-rebinding" });

	try {
		setChildLineage(sessionId, lineage);
		assert.doesNotThrow(() => setChildLineage(sessionId, lineage));
		assert.equal(getLineageForSession(sessionId), lineage);
	} finally {
		clearLineage(sessionId);
	}
});

it("allows a resumed child lineage to rebind the same session id and file", () => {
	const sessionId = "session-lineage-resume-same-file";
	const sessionFile = "/tmp/session-lineage-resume-same-file.jsonl";
	const previous = makeChildLineage({ runId: "run-lineage-resume-previous" });
	const resumed = makeChildLineage({ runId: "run-lineage-resume-current" });

	try {
		setChildLineage(sessionId, previous, sessionFile);
		assert.doesNotThrow(() => setChildLineage(sessionId, resumed, sessionFile));
		assert.equal(getLineageForSession(sessionId), resumed);
	} finally {
		clearLineage(sessionId);
	}
});

it("rejects a different-file collision for the same child session id", () => {
	const sessionId = "session-lineage-resume-different-file";
	const previous = makeChildLineage({ runId: "run-lineage-different-file-previous" });
	const colliding = makeChildLineage({ runId: "run-lineage-different-file-current" });

	try {
		setChildLineage(sessionId, previous, "/tmp/session-lineage-different-file-previous.jsonl");
		assert.throws(
			() => setChildLineage(sessionId, colliding, "/tmp/session-lineage-different-file-current.jsonl"),
			{ message: "Cannot replace an existing session lineage binding." },
		);
		assert.equal(getLineageForSession(sessionId), previous);
	} finally {
		clearLineage(sessionId);
	}
});

it("returns and consumes the newly rebound pending lineage for a resumed session", () => {
	const sessionId = "session-lineage-claim-resume";
	const cleanupSessionId = "session-lineage-claim-resume-cleanup";
	const sessionFile = "/tmp/session-lineage-claim-resume.jsonl";
	const previous = makeChildLineage({ runId: "run-lineage-claim-resume-previous" });
	const resumed = makeChildLineage({ runId: "run-lineage-claim-resume-current" });
	setChildLineage(sessionId, previous, sessionFile);
	pushPendingChildLineage(resumed, sessionFile);

	try {
		assert.equal(claimPendingChildLineage(sessionId, { runId: null, agentName: null, sessionFile }), resumed);
		assert.equal(getLineageForSession(sessionId), resumed);
		assert.equal(
			claimPendingChildLineage(cleanupSessionId, { runId: null, agentName: null, sessionFile }),
			null,
			"the rebound lineage must be consumed only after it is safely bound",
		);
	} finally {
		removePendingChildLineage(resumed);
		clearLineage(sessionId);
		clearLineage(cleanupSessionId);
	}
});

it("leaves a rejected different-file claim pending", () => {
	const sessionId = "session-lineage-claim-different-file";
	const cleanupSessionId = "session-lineage-claim-different-file-cleanup";
	const previous = makeChildLineage({ runId: "run-lineage-claim-different-file-previous" });
	const colliding = makeChildLineage({ runId: "run-lineage-claim-different-file-current" });
	const collidingSessionFile = "/tmp/session-lineage-claim-different-file-current.jsonl";
	setChildLineage(sessionId, previous, "/tmp/session-lineage-claim-different-file-previous.jsonl");
	pushPendingChildLineage(colliding, collidingSessionFile);

	try {
		assert.throws(
			() =>
				claimPendingChildLineage(sessionId, {
					runId: null,
					agentName: null,
					sessionFile: collidingSessionFile,
				}),
			{ message: "Cannot replace an existing session lineage binding." },
		);
		assert.equal(getLineageForSession(sessionId), previous);
		removeChildLineageBindings(previous);
		assert.equal(
			claimPendingChildLineage(cleanupSessionId, {
				runId: null,
				agentName: null,
				sessionFile: collidingSessionFile,
			}),
			colliding,
		);
	} finally {
		removePendingChildLineage(colliding);
		clearLineage(sessionId);
		clearLineage(cleanupSessionId);
	}
});

it("does not retain a child session-file hint on a host binding", () => {
	const sessionId = "session-lineage-host-file-hint";
	setChildLineage(
		sessionId,
		makeChildLineage({ runId: "run-lineage-host-file-hint" }),
		"/tmp/session-lineage-host-file-hint.jsonl",
	);
	const sessionFiles = globalStore[BOUND_SESSION_FILES_KEY] as Map<string, string>;
	const lineageStore = globalStore[LINEAGE_STORE_KEY] as Map<string, SubagentLineage>;
	lineageStore.delete(sessionId);

	try {
		assert.equal(setHostLineage(sessionId, "host-agent").role, "host");
		assert.equal(sessionFiles.has(sessionId), false);
	} finally {
		clearLineage(sessionId);
	}
});

it("falls back from a blank host lineage identity for self-fork checks", async () => {
	const cwd = "/tmp/pi-subagent-nested-delegation-authorization";
	const sessionId = "session-host-fork-blank-identity";
	process.env.PI_SUBAGENT_CURRENT_AGENT = "target-agent";
	setLineageForSession(sessionId, {
		role: "host",
		currentAgent: "   ",
		parentAgent: null,
		parentSessionId: null,
		rootSessionId: sessionId,
		depth: 0,
		runId: null,
	});

	try {
		const result = await makeExecutor(cwd).execute(
			"call-host-fork-blank-identity",
			{ run: [{ agent: "target-agent", task: "continue", context: "fork" }] },
			new AbortController().signal,
			undefined,
			makeCtx(cwd, sessionId),
		);

		assert.doesNotMatch(result.content[0]?.text ?? "", /known current agent identity/i);
		assert.match(result.content[0]?.text ?? "", /persisted parent session/i);
	} finally {
		clearLineage(sessionId);
	}
});

it("keeps a blank child lineage identity authoritative for self-fork checks", async () => {
	const cwd = "/tmp/pi-subagent-nested-delegation-authorization";
	const sessionId = "session-child-fork-blank-identity";
	process.env.PI_SUBAGENT_CURRENT_AGENT = "target-agent";
	setLineageForSession(
		sessionId,
		makeChildLineage({
			currentAgent: "   ",
			runId: "run-child-fork-blank-identity",
			allowedDelegateAgents: ["target-agent"],
		}),
	);

	try {
		const result = await makeExecutor(cwd).execute(
			"call-child-fork-blank-identity",
			{ run: [{ agent: "target-agent", task: "continue", context: "fork" }] },
			new AbortController().signal,
			undefined,
			makeCtx(cwd, sessionId),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /known current agent identity/i);
	} finally {
		clearLineage(sessionId);
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
			assert.doesNotMatch(result.content[0]?.text ?? "", /source-agent|parent-agent/i);
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
			assert.doesNotMatch(result.content[0]?.text ?? "", /source-agent|parent-agent|target-agent/i);
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
			assert.match(result.content[0]?.text ?? "", /configured allowlist/i);
			assert.doesNotMatch(result.content[0]?.text ?? "", /source-agent|parent-agent|allowed-agent|target-agent/i);
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
				(error: Error) => {
					assert.match(error.message, /configured allowlist/i);
					assert.doesNotMatch(error.message, /source-agent|parent-agent|allowed-agent|target-agent/i);
					return true;
				},
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

	it("does not expose agent identities when rejecting a cross-agent fork", async () => {
		const cwd = "/tmp/pi-subagent-nested-delegation-authorization";
		const sessionId = "session-child-cross-agent-fork";
		setLineageForSession(sessionId, makeChildLineage({ runId: "run-child-cross-agent-fork" }));

		try {
			const result = await makeExecutor(cwd).execute(
				"call-cross-agent-fork",
				{ run: [{ agent: "target-agent", task: "continue", context: "fork" }] },
				new AbortController().signal,
				undefined,
				makeCtx(cwd, sessionId),
			);

			assert.equal(result.isError, true);
			assert.match(result.content[0]?.text ?? "", /same-agent execution/i);
			assert.doesNotMatch(result.content[0]?.text ?? "", /source-agent|target-agent/i);
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
