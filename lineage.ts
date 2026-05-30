/**
 * Subagent lineage: per-session identity for the in-process subagent runtime.
 *
 * Each AgentSession (host OR child) has its own ExtensionRunner with its own
 * pi instance. Lineage answers "who am I, who spawned me, what's the root?"
 * for the session this code is running in.
 *
 * Lineage source of truth lives on `globalThis` keyed by sessionId. The
 * in-process executor stores a child's lineage BEFORE createAgentSession()
 * resolves the session id, then the child activate looks it up by its own
 * session id (resolved via pi.events `session_start` ctx) and publishes it
 * on the child's pi.events as `SUBAGENT_EXPOSE_API_EVENT`.
 *
 * For the host (UI-bearing) session, lineage is { role: "host", currentAgent:
 * "main", parentAgent: null, parentSessionId: null, rootSessionId: <self> }.
 * Host lineage is set on the first host activate.
 */

export interface SubagentLineage {
	/** "host" for the UI-bearing root session, "child" for any in-process child. */
	role: "host" | "child";
	/** Agent persona running in this session ("main" for host, the spawned agent name for children). */
	currentAgent: string;
	/** Direct parent agent persona (null for host, the spawner agent for children). */
	parentAgent: string | null;
	/** Direct parent session id (null for host). */
	parentSessionId: string | null;
	/** Root host session id (self for host). */
	rootSessionId: string | null;
	/** Depth from root: 0 = host, 1 = first-level child, etc. */
	depth: number;
	/** Run id (subagent dispatch correlation id) — null for host. */
	runId: string | null;
	/** Root run id for this run tree — null for host. */
	rootRunId?: string | null;
}

const STORE_KEY = "__piSubagentLineageBySession";
const PENDING_KEY = "__piSubagentLineagePending";

type Store = Map<string, SubagentLineage>;
type Pending = SubagentLineage[];

function store(): Store {
	const g = globalThis as Record<string, unknown>;
	let m = g[STORE_KEY] as Store | undefined;
	if (!m) {
		m = new Map();
		g[STORE_KEY] = m;
	}
	return m;
}

function pending(): Pending {
	const g = globalThis as Record<string, unknown>;
	let arr = g[PENDING_KEY] as Pending | undefined;
	if (!arr) {
		arr = [];
		g[PENDING_KEY] = arr;
	}
	return arr;
}

/**
 * Record a child's lineage BEFORE the child session id is known. The in-process
 * executor calls this just before createAgentSession() so that whichever
 * activate fires next can claim it. The matching activate identifies its
 * lineage by matching runId / agentName from the pending queue.
 */
export function pushPendingChildLineage(lineage: SubagentLineage): void {
	pending().push(lineage);
}

/**
 * Pop the most recent pending child lineage that matches the given runId and
 * agentName, or any pending entry if no match is found. Used by the child
 * activate to claim its lineage once it knows its own session id.
 *
 * Returns the matched lineage (now bound to sessionId) and stores it in the
 * permanent map for subsequent queries.
 */
export function claimPendingChildLineage(
	sessionId: string,
	hints: { runId?: string | null; agentName?: string | null },
): SubagentLineage | null {
	const arr = pending();
	if (arr.length === 0) return null;
	let idx = -1;
	if (hints.runId) {
		idx = arr.findIndex((l) => l.runId === hints.runId);
	}
	if (idx < 0 && hints.agentName) {
		idx = arr.findIndex((l) => l.currentAgent === hints.agentName);
	}
	if (idx < 0) idx = 0;
	const lineage = arr.splice(idx, 1)[0];
	store().set(sessionId, lineage);
	return lineage;
}

/**
 * Record a child's lineage keyed by its session id, when the session id is
 * already known (callers that resolve it via SessionManager.open before
 * createAgentSession runs).
 *
 * Always overwrites any prior entry for the same sid; the most recent dispatch
 * wins. This is the primary lineage path; the pending-queue + activate-claim
 * path is a fallback for cases where the session id isn't available yet.
 */
export function setChildLineage(sessionId: string, lineage: SubagentLineage): void {
	store().set(sessionId, lineage);
}

/** Record the host's lineage. Idempotent: only sets if not already present. */
export function setHostLineage(sessionId: string): SubagentLineage {
	const m = store();
	const existing = m.get(sessionId);
	if (existing) return existing;
	const lineage: SubagentLineage = {
		role: "host",
		currentAgent: "main",
		parentAgent: null,
		parentSessionId: null,
		rootSessionId: sessionId,
		depth: 0,
		runId: null,
		rootRunId: null,
	};
	m.set(sessionId, lineage);
	return lineage;
}

/** Look up lineage for a given session id. Returns null if not recorded. */
export function getLineageForSession(sessionId: string): SubagentLineage | null {
	return store().get(sessionId) ?? null;
}
