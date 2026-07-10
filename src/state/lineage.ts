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
 * <active root role>, parentAgent: null, parentSessionId: null, rootSessionId:
 * <self> }. Host lineage is set on the first host activate.
 */

export interface SubagentLineage {
	/** "host" for the UI-bearing root session, "child" for any in-process child. */
	role: "host" | "child";
	/** Agent persona running in this session (active root role for host, spawned agent name for children). */
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
	/** Whether this child may dispatch another child. */
	canDelegate?: boolean;
	/** Child agent names this child may dispatch. */
	allowedDelegateAgents?: string[];
	/** Effective maximum depth inherited by this child. */
	maxSubagentDepth?: number;
}

const STORE_KEY = "__piSubagentLineageBySession";
const PENDING_KEY = "__piSubagentLineagePending";
const PENDING_SESSION_FILES_KEY = "__piSubagentLineagePendingSessionFiles";
const BOUND_SESSION_FILES_KEY = "__piSubagentLineageBoundSessionFiles";

type Store = Map<string, SubagentLineage>;
type Pending = SubagentLineage[];
type PendingSessionFiles = WeakMap<SubagentLineage, string>;
type BoundSessionFiles = Map<string, string>;

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

function pendingSessionFiles(): PendingSessionFiles {
	const g = globalThis as Record<string, unknown>;
	let files = g[PENDING_SESSION_FILES_KEY] as PendingSessionFiles | undefined;
	if (!files) {
		files = new WeakMap();
		g[PENDING_SESSION_FILES_KEY] = files;
	}
	return files;
}

function isBoundSessionFiles(value: unknown): value is BoundSessionFiles {
	if (!(value instanceof Map)) return false;
	for (const [sessionId, sessionFile] of value) {
		if (
			typeof sessionId !== "string" ||
			sessionId.length === 0 ||
			typeof sessionFile !== "string" ||
			sessionFile.length === 0
		) {
			return false;
		}
	}
	return true;
}

function boundSessionFiles(): BoundSessionFiles {
	const g = globalThis as Record<string, unknown>;
	const existing = g[BOUND_SESSION_FILES_KEY];
	if (isBoundSessionFiles(existing)) return existing;
	const files: BoundSessionFiles = new Map();
	g[BOUND_SESSION_FILES_KEY] = files;
	return files;
}

function removePendingAt(arr: Pending, index: number): SubagentLineage {
	const lineage = arr.splice(index, 1)[0];
	pendingSessionFiles().delete(lineage);
	return lineage;
}

/** Remove one exact lineage object from the pending queue and clear its session-file hint. */
export function removePendingChildLineage(lineage: SubagentLineage): void {
	const arr = pending();
	const index = arr.findIndex((candidate) => candidate === lineage);
	if (index >= 0) removePendingAt(arr, index);
	else pendingSessionFiles().delete(lineage);
}

/**
 * Record a child's lineage BEFORE the child session id is known. The in-process
 * executor calls this just before createAgentSession() so that whichever
 * activate fires next can claim it. The matching activate identifies its
 * lineage by matching the child session file, runId, or agentName from the
 * pending queue.
 */
export function pushPendingChildLineage(lineage: SubagentLineage, sessionFile?: string | null): void {
	removePendingChildLineage(lineage);
	const sessionFiles = pendingSessionFiles();
	if (sessionFile) sessionFiles.set(lineage, sessionFile);
	pending().push(lineage);
}

/**
 * Pop the most recent pending child lineage that matches the given session
 * file, runId, or agentName. Used by the child activate to claim its lineage
 * once it knows its own session id.
 *
 * Returns the matched lineage (now bound to sessionId) and stores it in the
 * permanent map for subsequent queries.
 */
export function claimPendingChildLineage(
	sessionId: string,
	hints: { runId?: string | null; agentName?: string | null; sessionFile?: string | null },
): SubagentLineage | null {
	const arr = pending();
	const existing = store().get(sessionId);
	if (existing) {
		const pendingIndex = arr.findIndex((candidate) => candidate === existing);
		if (pendingIndex >= 0) {
			setChildLineage(sessionId, existing, hints.sessionFile);
			removePendingAt(arr, pendingIndex);
			return existing;
		}
		if (hints.sessionFile) {
			const sessionFiles = pendingSessionFiles();
			let matchedIndex = -1;
			for (let index = 0; index < arr.length; index++) {
				if (sessionFiles.get(arr[index]!) !== hints.sessionFile) continue;
				if (matchedIndex >= 0) return existing;
				matchedIndex = index;
			}
			if (matchedIndex >= 0) {
				const matched = arr[matchedIndex]!;
				setChildLineage(sessionId, matched, hints.sessionFile);
				removePendingAt(arr, matchedIndex);
				return matched;
			}
		}
		return existing;
	}
	if (arr.length === 0) return null;
	let idx = -1;
	if (hints.sessionFile) {
		const sessionFiles = pendingSessionFiles();
		for (let index = 0; index < arr.length; index++) {
			if (sessionFiles.get(arr[index]) !== hints.sessionFile) continue;
			if (idx >= 0) return null;
			idx = index;
		}
		if (idx < 0) return null;
	}
	if (idx < 0 && hints.runId) {
		idx = arr.findIndex((l) => l.runId === hints.runId);
	}
	if (idx < 0 && hints.agentName) {
		idx = arr.findIndex((l) => l.currentAgent === hints.agentName);
	}
	if (idx < 0 && arr.length === 1) idx = 0;
	if (idx < 0) return null;
	const lineage = arr[idx]!;
	setChildLineage(sessionId, lineage, hints.sessionFile);
	removePendingAt(arr, idx);
	return lineage;
}

/**
 * Record a child's lineage keyed by its session id, when the session id is
 * already known (callers that resolve it via SessionManager.open before
 * createAgentSession runs).
 *
 * Refuses to replace an existing binding with a different lineage object unless
 * both child bindings use the same non-empty session file, as happens when a
 * persisted child session is resumed. Rebinding the exact same object is
 * allowed for idempotent setup and retries. This is the primary lineage path;
 * the pending-queue + activate-claim path is a fallback for cases where the
 * session id isn't available yet.
 */
export function setChildLineage(sessionId: string, lineage: SubagentLineage, sessionFile?: string | null): void {
	const lineages = store();
	const existing = lineages.get(sessionId);
	const sessionFiles = boundSessionFiles();
	const existingSessionFile = sessionFiles.get(sessionId);
	const nextSessionFile = sessionFile || null;
	if (
		existing &&
		existing !== lineage &&
		(existing.role !== "child" ||
			lineage.role !== "child" ||
			!existingSessionFile ||
			!nextSessionFile ||
			existingSessionFile !== nextSessionFile)
	) {
		throw new Error("Cannot replace an existing session lineage binding.");
	}
	lineages.set(sessionId, lineage);
	if (nextSessionFile) sessionFiles.set(sessionId, nextSessionFile);
	else if (!existing) sessionFiles.delete(sessionId);
}

/** Remove every session binding that points to the exact lineage object. */
export function removeChildLineageBindings(lineage: SubagentLineage): void {
	const lineages = store();
	const sessionFiles = boundSessionFiles();
	for (const [sessionId, candidate] of lineages) {
		if (candidate === lineage) {
			lineages.delete(sessionId);
			sessionFiles.delete(sessionId);
		}
	}
}

/** Record or refresh the host's lineage. */
export function setHostLineage(sessionId: string, currentAgent = ""): SubagentLineage {
	const m = store();
	const existing = m.get(sessionId);
	if (existing?.role === "child") return existing;
	const lineage: SubagentLineage = {
		...(existing ?? {
			role: "host" as const,
			parentAgent: null,
			parentSessionId: null,
			depth: 0,
			runId: null,
			rootRunId: null,
		}),
		currentAgent,
		rootSessionId: sessionId,
	};
	m.set(sessionId, lineage);
	boundSessionFiles().delete(sessionId);
	return lineage;
}

/** Look up lineage for a given session id. Returns null if not recorded. */
export function getLineageForSession(sessionId: string): SubagentLineage | null {
	return store().get(sessionId) ?? null;
}

/**
 * Resolve the root host session for a dispatch from the current session.
 * In-process children do not necessarily inherit PI_SUBAGENT_ROOT_SESSION_ID,
 * so session lineage is the canonical source; env remains the fallback for
 * subprocess/legacy paths, then the current session id for top-level hosts.
 */
export function resolveRootSessionIdForSession(sessionId: string | undefined): string | undefined {
	if (sessionId) {
		const lineage = getLineageForSession(sessionId);
		if (lineage?.rootSessionId) return lineage.rootSessionId;
	}
	return process.env.PI_SUBAGENT_ROOT_SESSION_ID ?? sessionId;
}
