import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { resolveDispatchParentRunId, resolveDispatchRootRunId } from "../../subagent-executor.ts";
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

function ctxWith(sid: string | undefined) {
	return {
		sessionManager: {
			getSessionId: () => sid,
		},
	};
}

describe("resolveDispatchParentRunId", () => {
	const savedEnv = process.env.PI_SUBAGENT_PARENT_RUN_ID;
	const savedRootEnv = process.env.PI_SUBAGENT_ROOT_RUN_ID;
	afterEach(() => {
		if (savedEnv === undefined) delete process.env.PI_SUBAGENT_PARENT_RUN_ID;
		else process.env.PI_SUBAGENT_PARENT_RUN_ID = savedEnv;
		if (savedRootEnv === undefined) delete process.env.PI_SUBAGENT_ROOT_RUN_ID;
		else process.env.PI_SUBAGENT_ROOT_RUN_ID = savedRootEnv;
	});

	it("returns the child's own runId for nested dispatches (mid-prompt-loop)", () => {
		delete process.env.PI_SUBAGENT_PARENT_RUN_ID;
		const sid = "session-child-runid-test";
		setLineageForSession(sid, {
			role: "child",
			currentAgent: "tester",
			parentAgent: "main",
			parentSessionId: "session-host",
			rootSessionId: "session-host",
			depth: 1,
			runId: "child-runid-abc",
		});
		try {
			assert.equal(resolveDispatchParentRunId(ctxWith(sid)), "child-runid-abc");
		} finally {
			clearLineage(sid);
		}
	});

	it("returns undefined for the host session (runId=null) when env is unset", () => {
		delete process.env.PI_SUBAGENT_PARENT_RUN_ID;
		const sid = "session-host-runid-test";
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
			assert.equal(resolveDispatchParentRunId(ctxWith(sid)), undefined);
		} finally {
			clearLineage(sid);
		}
	});

	it("prefers child lineage runId over PI_SUBAGENT_PARENT_RUN_ID env var", () => {
		const sid = "session-child-env-shadow";
		setLineageForSession(sid, {
			role: "child",
			currentAgent: "tester",
			parentAgent: "main",
			parentSessionId: "session-host",
			rootSessionId: "session-host",
			depth: 1,
			runId: "child-runid-from-lineage",
		});
		process.env.PI_SUBAGENT_PARENT_RUN_ID = "stale-env-value";
		try {
			assert.equal(resolveDispatchParentRunId(ctxWith(sid)), "child-runid-from-lineage");
		} finally {
			clearLineage(sid);
		}
	});

	it("falls back to PI_SUBAGENT_PARENT_RUN_ID when lineage is missing", () => {
		process.env.PI_SUBAGENT_PARENT_RUN_ID = "env-fallback";
		// no lineage for an unknown sid
		assert.equal(resolveDispatchParentRunId(ctxWith("session-no-lineage")), "env-fallback");
	});

	it("falls back to env when no session id is available", () => {
		process.env.PI_SUBAGENT_PARENT_RUN_ID = "env-fallback";
		assert.equal(resolveDispatchParentRunId(ctxWith(undefined)), "env-fallback");
	});

	it("returns undefined when both lineage and env are absent", () => {
		delete process.env.PI_SUBAGENT_PARENT_RUN_ID;
		assert.equal(resolveDispatchParentRunId(ctxWith(undefined)), undefined);
	});

	it("resolves root run id from lineage, env, then own run id", () => {
		const sid = "session-child-root-runid";
		setLineageForSession(sid, {
			role: "child",
			currentAgent: "tester",
			parentAgent: "main",
			parentSessionId: "session-host",
			rootSessionId: "session-host",
			depth: 1,
			runId: "child-runid",
			rootRunId: "root-runid-from-lineage",
		});
		process.env.PI_SUBAGENT_ROOT_RUN_ID = "root-runid-from-env";
		try {
			assert.equal(resolveDispatchRootRunId(ctxWith(sid), "new-runid"), "root-runid-from-lineage");
		} finally {
			clearLineage(sid);
		}
		assert.equal(resolveDispatchRootRunId(ctxWith(undefined), "new-runid"), "root-runid-from-env");
		delete process.env.PI_SUBAGENT_ROOT_RUN_ID;
		assert.equal(resolveDispatchRootRunId(ctxWith(undefined), "new-runid"), "new-runid");
	});
});
