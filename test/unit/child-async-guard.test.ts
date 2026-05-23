import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createSubagentExecutor } from "../../subagent-executor.ts";
import { CHILD_SESSION_FLAG_KEY, isInsideChildSession } from "../../types.ts";
import type { SubagentLineage } from "../../lineage.ts";

const globalStore = globalThis as Record<string, unknown>;
const LINEAGE_STORE_KEY = "__piSubagentLineageBySession";

function setLineageForSession(sessionId: string, lineage: SubagentLineage): void {
	let m = globalStore[LINEAGE_STORE_KEY] as Map<string, SubagentLineage> | undefined;
	if (!m) {
		m = new Map();
		globalStore[LINEAGE_STORE_KEY] = m;
	}
	m.set(sessionId, lineage);
}
function clearLineage(sessionId: string): void {
	const m = globalStore[LINEAGE_STORE_KEY] as Map<string, SubagentLineage> | undefined;
	m?.delete(sessionId);
}

afterEach(() => {
	delete globalStore[CHILD_SESSION_FLAG_KEY];
});

describe("isInsideChildSession", () => {
	it("returns false when the flag is unset", () => {
		assert.equal(isInsideChildSession(), false);
	});

	it("returns true only when the flag is exactly the boolean true", () => {
		globalStore[CHILD_SESSION_FLAG_KEY] = true;
		assert.equal(isInsideChildSession(), true);
		globalStore[CHILD_SESSION_FLAG_KEY] = false;
		assert.equal(isInsideChildSession(), false);
		globalStore[CHILD_SESSION_FLAG_KEY] = "true";
		assert.equal(isInsideChildSession(), false);
		globalStore[CHILD_SESSION_FLAG_KEY] = 1;
		assert.equal(isInsideChildSession(), false);
	});
});

describe("subagent executor child-session async guard", () => {
	function makeExecutor(cwd: string) {
		return (createSubagentExecutor as unknown as (deps: Record<string, unknown>) => {
			execute: (
				id: string,
				params: Record<string, unknown>,
				signal: AbortSignal,
				onUpdate: ((r: unknown) => void) | undefined,
				ctx: Record<string, unknown>,
			) => Promise<{ isError?: boolean; content: Array<{ text?: string }>; details?: { mode?: string } }>;
		})({
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
			asyncByDefault: false,
			tempArtifactsDir: cwd,
			expandTilde: (value: string) => value,
			discoverAgents: () => ({
				agents: [{ name: "tester", description: "test agent" }],
			}),
		});
	}

	function makeCtx(cwd: string) {
		return {
			cwd,
			hasUI: false,
			ui: {},
			sessionManager: {
				getSessionId: () => "session-child",
				getSessionFile: () => null,
			},
			modelRegistry: { getAvailable: () => [] },
		};
	}

	it("rejects async:true single dispatch from inside a child session", async () => {
		globalStore[CHILD_SESSION_FLAG_KEY] = true;
		const executor = makeExecutor("/tmp/pi-subagent-child-async-guard");
		const result = await executor.execute(
			"id-single",
			{ run: [{ agent: "tester", task: "do stuff" }], async: true },
			new AbortController().signal,
			undefined,
			makeCtx("/tmp/pi-subagent-child-async-guard"),
		);
		assert.equal(result.isError, true);
		assert.equal(result.details?.mode, "single");
		assert.match(result.content[0]?.text ?? "", /only allowed from the host session/i);
		assert.match(result.content[0]?.text ?? "", /async/i);
	});

	it("rejects async:true parallel dispatch from inside a child session", async () => {
		globalStore[CHILD_SESSION_FLAG_KEY] = true;
		const executor = makeExecutor("/tmp/pi-subagent-child-async-guard");
		const result = await executor.execute(
			"id-parallel",
			{ run: [{ agent: "tester", task: "a" }, { agent: "tester", task: "b" }], async: true },
			new AbortController().signal,
			undefined,
			makeCtx("/tmp/pi-subagent-child-async-guard"),
		);
		assert.equal(result.isError, true);
		assert.equal(result.details?.mode, "parallel");
		assert.match(result.content[0]?.text ?? "", /only allowed from the host session/i);
	});

	it("rejects async:true chain dispatch from inside a child session", async () => {
		globalStore[CHILD_SESSION_FLAG_KEY] = true;
		const executor = makeExecutor("/tmp/pi-subagent-child-async-guard");
		const result = await executor.execute(
			"id-chain",
			{ run: [{ agent: "tester", task: "step1" }], chain: true, async: true },
			new AbortController().signal,
			undefined,
			makeCtx("/tmp/pi-subagent-child-async-guard"),
		);
		assert.equal(result.isError, true);
		assert.equal(result.details?.mode, "chain");
		assert.match(result.content[0]?.text ?? "", /only allowed from the host session/i);
	});

	it("does NOT reject async:true when called from the host session (flag unset)", async () => {
		// We don't need the run to actually complete; we just need to be sure the
		// child-async guard does not fire. The guard sits before validation, so an
		// unknown agent will surface a different (non-guard) error path; that's fine.
		delete globalStore[CHILD_SESSION_FLAG_KEY];
		const executor = makeExecutor("/tmp/pi-subagent-child-async-guard");
		const result = await executor.execute(
			"id-host",
			{ run: [{ agent: "tester", task: "ok" }], async: true },
			new AbortController().signal,
			undefined,
			makeCtx("/tmp/pi-subagent-child-async-guard"),
		);
		// Whatever the outcome, it must not be the child-async guard message.
		const text = result.content[0]?.text ?? "";
		assert.equal(/only allowed from the host session/i.test(text), false);
	});

	it("rejects async:true when the CURRENT session has child lineage (mid-prompt-loop)", async () => {
		// Real-world case: the brief construction-time flag is already cleared by the
		// time the child's prompt loop invokes the subagent tool. Lineage is the
		// durable signal that this session is a child.
		delete globalStore[CHILD_SESSION_FLAG_KEY];
		const sid = "session-child-lineage";
		setLineageForSession(sid, {
			role: "child",
			currentAgent: "tester",
			parentAgent: "main",
			parentSessionId: "session-host",
			rootSessionId: "session-host",
			depth: 1,
			runId: "run-abc",
		});
		try {
			const executor = makeExecutor("/tmp/pi-subagent-child-async-guard");
			const result = await executor.execute(
				"id-lineage",
				{ run: [{ agent: "tester", task: "do stuff" }], async: true },
				new AbortController().signal,
				undefined,
				{
					cwd: "/tmp/pi-subagent-child-async-guard",
					hasUI: false,
					ui: {},
					sessionManager: {
						getSessionId: () => sid,
						getSessionFile: () => null,
					},
					modelRegistry: { getAvailable: () => [] },
				},
			);
			assert.equal(result.isError, true);
			assert.match(result.content[0]?.text ?? "", /only allowed from the host session/i);
		} finally {
			clearLineage(sid);
		}
	});

	it("does NOT reject async:true when the CURRENT session has host lineage", async () => {
		delete globalStore[CHILD_SESSION_FLAG_KEY];
		const sid = "session-host-lineage";
		setLineageForSession(sid, {
			role: "host",
			currentAgent: "main",
			parentAgent: null,
			parentSessionId: null,
			rootSessionId: sid,
			depth: 0,
			runId: null,
		});
		try {
			const executor = makeExecutor("/tmp/pi-subagent-child-async-guard");
			const result = await executor.execute(
				"id-host-lineage",
				{ run: [{ agent: "tester", task: "ok" }], async: true },
				new AbortController().signal,
				undefined,
				{
					cwd: "/tmp/pi-subagent-child-async-guard",
					hasUI: false,
					ui: {},
					sessionManager: {
						getSessionId: () => sid,
						getSessionFile: () => null,
					},
					modelRegistry: { getAvailable: () => [] },
				},
			);
			assert.equal(/only allowed from the host session/i.test(result.content[0]?.text ?? ""), false);
		} finally {
			clearLineage(sid);
		}
	});
});
