export type SubagentExecutionContext = "fresh" | "fork";

interface ForkableSessionManagerStatic {
	open(path: string): { createBranchedSession(leafId: string): string | undefined };
}

/**
 * Minimal shape of a session entry we inspect when picking a safe fork point.
 * Matches the host SDK's `SessionEntry` (see `@earendil-works/pi-coding-agent`
 * `core/session-manager.ts`), narrowed to the fields we read.
 */
interface ForkInspectableEntry {
	type: string;
	id: string;
	parentId: string | null;
	message?: {
		role?: string;
		content?: ReadonlyArray<{ type?: string; name?: string }> | unknown;
	};
}

export interface ForkableSessionManager {
	getSessionFile(): string | undefined;
	getLeafId(): string | null;
	/**
	 * Optional at compile-time so test fakes can omit it; at runtime the real
	 * `SessionManager` from the host SDK always provides it. When present we use
	 * it to walk back past the dispatching `subagent` tool_use so the child does
	 * not inherit an orphan tool_use at its leaf (see
	 * `references/context-fork.md`).
	 */
	getEntry?(id: string): ForkInspectableEntry | undefined;
	constructor: ForkableSessionManagerStatic;
}

export interface ForkContextResolver {
	sessionFileForIndex(index?: number): string | undefined;
}

export function resolveSubagentContext(value: unknown): SubagentExecutionContext {
	return value === "fork" ? "fork" : "fresh";
}

export function createForkContextResolver(
	sessionManager: ForkableSessionManager,
	requestedContext: unknown,
): ForkContextResolver {
	if (resolveSubagentContext(requestedContext) !== "fork") {
		return {
			sessionFileForIndex: () => undefined,
		};
	}

	const parentSessionFile = sessionManager.getSessionFile();
	if (!parentSessionFile) {
		throw new Error("Forked subagent context requires a persisted parent session.");
	}

	const rawLeafId = sessionManager.getLeafId();
	if (!rawLeafId) {
		throw new Error("Forked subagent context requires a current leaf to fork from.");
	}

	const leafId = pickSafeForkLeafId(sessionManager, rawLeafId);

	const cachedSessionFiles = new Map<number, string>();

	return {
		sessionFileForIndex(index = 0): string | undefined {
			const cached = cachedSessionFiles.get(index);
			if (cached) return cached;
			try {
				const sourceManager = sessionManager.constructor.open(parentSessionFile);
				const sessionFile = sourceManager.createBranchedSession(leafId);
				if (!sessionFile) {
					throw new Error("Session manager did not return a session file.");
				}
				cachedSessionFiles.set(index, sessionFile);
				return sessionFile;
			} catch (error) {
				const cause = error instanceof Error ? error : new Error(String(error));
				throw new Error(`Failed to create forked subagent session: ${cause.message}`, { cause });
			}
		},
	};
}

/**
 * Walk back one step from `leafId` when the leaf is the assistant turn that
 * issued the dispatching `subagent` tool_use. The child fork should not
 * inherit that pending tool_use: at fork time there is no matching tool_result
 * in the child's branch (the result lives in the parent's session), so the
 * child would otherwise inherit an orphan tool_use at the end of its history.
 *
 * Falls back to the original `leafId` when:
 *   - `getEntry` is unavailable (legacy/test fakes),
 *   - the leaf is not an assistant message, or
 *   - the assistant turn has no `subagent` tool_use, or
 *   - the parent entry can't be resolved.
 */
function pickSafeForkLeafId(sessionManager: ForkableSessionManager, leafId: string): string {
	const getEntry = sessionManager.getEntry?.bind(sessionManager);
	if (!getEntry) return leafId;
	let entry: ForkInspectableEntry | undefined;
	try {
		entry = getEntry(leafId);
	} catch {
		return leafId;
	}
	if (!entry || entry.type !== "message" || entry.message?.role !== "assistant") return leafId;
	const content = entry.message?.content;
	if (!Array.isArray(content)) return leafId;
	const hasDispatchToolUse = content.some(
		(block) =>
			block &&
			typeof block === "object" &&
			(block as { type?: string }).type === "toolCall" &&
			(block as { name?: string }).name === "subagent",
	);
	if (!hasDispatchToolUse) return leafId;
	const parentId = entry.parentId;
	if (!parentId) return leafId;
	return parentId;
}
