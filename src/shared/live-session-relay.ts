import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { processGlobal } from "./process-global.ts";

const LIVE_SESSION_RELAY_KEY = "pi.subagents.live-session-relay";

export interface LiveSessionPublication {
	runId: string;
	stepIndex: number;
	session: AgentSession;
	rootSessionId?: string;
}

type RelayEvent =
	| { type: "published"; publication: LiveSessionPublication }
	| { type: "unpublished"; publication: LiveSessionPublication };
type RelayListener = (event: RelayEvent) => void;

export interface LiveToolProgress {
	startedAt?: number;
	partialResult?: AgentToolResult<unknown> & { isError: false };
}

export type LiveToolProgressBySession<TSession = AgentSession> = ReadonlyMap<
	TSession,
	ReadonlyMap<string, LiveToolProgress>
>;

export interface LiveSessionEventObserver {
	handleSessionEvent(session: AgentSession, event: AgentSessionEvent): void;
	releaseSession(session: AgentSession): void;
}

const EMPTY_TOOL_PROGRESS: ReadonlyMap<string, LiveToolProgress> = new Map();

export function dashboardPartialResult(value: unknown): (AgentToolResult<unknown> & { isError: false }) | undefined {
	if (typeof value !== "object" || value === null || !("content" in value) || !Array.isArray(value.content)) {
		return undefined;
	}
	const content: AgentToolResult<unknown>["content"] = [];
	for (const item of value.content) {
		if (typeof item !== "object" || item === null || !("type" in item)) return undefined;
		if (item.type === "image") continue;
		if (item.type !== "text" || !("text" in item) || typeof item.text !== "string") return undefined;
		content.push({ type: "text", text: item.text });
	}
	const result: AgentToolResult<unknown> & { isError: false } = {
		content,
		details: "details" in value ? value.details : undefined,
		isError: false,
	};
	if ("terminate" in value && typeof value.terminate === "boolean") result.terminate = value.terminate;
	return result;
}

function listeners(): Set<RelayListener> {
	return processGlobal(LIVE_SESSION_RELAY_KEY, () => new Set<RelayListener>());
}

/**
 * Deliver a live child session to current process-local observers.
 * The process-global hub retains listeners only; it has no replay or history.
 */
export function publishLiveSession(publication: LiveSessionPublication): () => void {
	for (const listener of listeners()) listener({ type: "published", publication });
	let published = true;
	return () => {
		if (!published) return;
		published = false;
		for (const listener of listeners()) listener({ type: "unpublished", publication });
	};
}

/** Host-activation-owned directory of currently observed child sessions. */
export class LiveSessionDirectory {
	private readonly sessions = new Map<string, Map<number, AgentSession>>();
	private readonly progress = new Map<AgentSession, Map<string, LiveToolProgress>>();
	private readonly sessionSubscriptions = new Map<AgentSession, () => void>();
	private readonly observer: LiveSessionEventObserver | undefined;
	private unsubscribe: (() => void) | undefined;

	constructor(observer?: LiveSessionEventObserver) {
		this.observer = observer;
		const listener: RelayListener = (event) => {
			const { runId, stepIndex, session } = event.publication;
			if (event.type === "published") {
				let byStep = this.sessions.get(runId);
				if (!byStep) {
					byStep = new Map();
					this.sessions.set(runId, byStep);
				}
				const replaced = byStep.get(stepIndex);
				if (replaced && replaced !== session) this.removeSession(replaced);
				byStep.set(stepIndex, session);
				this.observeSession(session);
				return;
			}
			const byStep = this.sessions.get(runId);
			if (byStep?.get(stepIndex) !== session) return;
			byStep.delete(stepIndex);
			if (byStep.size === 0) this.sessions.delete(runId);
			this.removeSession(session);
		};
		listeners().add(listener);
		this.unsubscribe = () => listeners().delete(listener);
	}

	private observeSession(session: AgentSession): void {
		if (this.sessionSubscriptions.has(session)) return;
		const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
			if (event.type === "tool_execution_start") {
				let byTool = this.progress.get(session);
				if (!byTool) {
					byTool = new Map();
					this.progress.set(session, byTool);
				}
				byTool.set(event.toolCallId, { startedAt: Date.now() });
			} else if (event.type === "tool_execution_update") {
				const partialResult = dashboardPartialResult(event.partialResult);
				if (partialResult) {
					let byTool = this.progress.get(session);
					if (!byTool) {
						byTool = new Map();
						this.progress.set(session, byTool);
					}
					const current = byTool.get(event.toolCallId);
					byTool.set(event.toolCallId, { startedAt: current?.startedAt ?? Date.now(), partialResult });
				}
			} else if (event.type === "tool_execution_end") {
				const byTool = this.progress.get(session);
				byTool?.delete(event.toolCallId);
				if (byTool?.size === 0) this.progress.delete(session);
			}
			this.observer?.handleSessionEvent(session, event);
		});
		this.sessionSubscriptions.set(session, unsubscribe);
	}

	private removeSession(session: AgentSession): void {
		this.sessionSubscriptions.get(session)?.();
		this.sessionSubscriptions.delete(session);
		this.progress.delete(session);
		this.observer?.releaseSession(session);
	}

	sessionsForRun(runId: string): AgentSession[] {
		return [...(this.sessions.get(runId)?.entries() ?? [])]
			.sort(([left], [right]) => left - right)
			.map(([, session]) => session);
	}

	toolProgress(session: AgentSession): ReadonlyMap<string, LiveToolProgress> {
		return this.progress.get(session) ?? EMPTY_TOOL_PROGRESS;
	}

	dispose(): void {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		for (const session of this.sessionSubscriptions.keys()) this.removeSession(session);
		this.sessions.clear();
	}
}
