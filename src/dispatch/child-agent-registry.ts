import type { AgentSession, AgentSessionEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ChildAgentResult, PersistedRunStatus, PersistedRunStep, StatusPatch } from "../protocol/status-types.ts";
import { applyPatchToStatus } from "../state/status-patch.ts";
import { statusFromMeta, type StatusMeta } from "../state/status-writer.ts";
import { statusToRunView } from "../state/async-status.ts";
import { tokenUsageFromUsage } from "../state/usage-totals.ts";
import type { RunView } from "../state/run-view.ts";

export interface ChildAgentContext {
	extensionCtx: ExtensionContext;
	abortSignal: AbortSignal;
	onEvent?: (stepIndex: number, e: AgentSessionEvent) => void;
	onStatusUpdate?: (patch: StatusPatch) => void;
	registry: ChildAgentRegistry;
	/** Per-run RunView seed; when present, startChildAgent seeds the registry mirror. */
	runViewSeed?: RunViewSeed;
	pi: ExtensionAPI;
}

export interface ChildAgentHandle {
	readonly runId: string;
	readonly stepIndex: number;
	readonly session: AgentSession;
	readonly completed: Promise<ChildAgentResult>;
	abort(reason: string): Promise<void>;
}

/**
 * Seed metadata for a registry RunView. Carries the StatusMeta fields that seed
 * the in-memory PersistedRunStatus (same builder as status.json) PLUS the
 * session-hierarchy + dir fields that live on RunView but not PersistedRunStatus.
 */
export interface RunViewSeed extends StatusMeta {
	/** Immediate dispatcher session id; copied onto the RunView. */
	parentSessionId?: string;
	/** Top-of-tree user session id; copied onto the RunView. */
	rootSessionId?: string;
	/** Run-record dir for disk-derived fields; defaults to sessionDir. */
	asyncDir?: string;
}

function isTerminalState(state: PersistedRunStatus["state"]): boolean {
	return (
		state === "complete" ||
		state === "failed" ||
		state === "paused" ||
		state === "lost" ||
		state === "interrupted" ||
		state === "skipped"
	);
}

export class ChildAgentRegistry {
	private readonly handles = new Map<string, Map<number, ChildAgentHandle>>();
	private readonly handleStates = new Map<string, Map<number, "queued" | "running">>();
	private readonly controllers = new Map<string, AbortController>();
	/** In-memory live status mirror, SAME shape as status.json, keyed by runId. */
	private readonly statuses = new Map<string, PersistedRunStatus & { steps: PersistedRunStep[] }>();
	/** Hierarchy/dir fields that live on RunView but not PersistedRunStatus. */
	private readonly viewMeta = new Map<
		string,
		{ parentSessionId?: string; rootSessionId?: string; asyncDir?: string }
	>();
	/** Terminal-stamp clock per runId; drives the bounded retention timer. */
	private readonly terminalAt = new Map<string, number>();
	private readonly retentionMs: number;
	private retentionTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(opts: { retentionMs?: number } = {}) {
		this.retentionMs = opts.retentionMs ?? 10000;
	}

	signalForRun(runId: string): AbortSignal {
		return this.controllerForRun(runId).signal;
	}

	register(handle: ChildAgentHandle): void {
		this.controllerForRun(handle.runId);
		let byStep = this.handles.get(handle.runId);
		if (!byStep) {
			byStep = new Map();
			this.handles.set(handle.runId, byStep);
		}
		byStep.set(handle.stepIndex, handle);
		let statesByStep = this.handleStates.get(handle.runId);
		if (!statesByStep) {
			statesByStep = new Map();
			this.handleStates.set(handle.runId, statesByStep);
		}
		statesByStep.set(handle.stepIndex, "queued");
	}

	markRunning(runId: string, stepIndex: number): void {
		const statesByStep = this.handleStates.get(runId);
		if (statesByStep?.has(stepIndex)) statesByStep.set(stepIndex, "running");
	}

	get(runId: string): ChildAgentHandle | undefined {
		return this.handles.get(runId)?.values().next().value;
	}

	sessionsForRun(runId: string): AgentSession[] {
		return [...(this.handles.get(runId)?.values() ?? [])]
			.sort((a, b) => a.stepIndex - b.stepIndex)
			.map((handle) => handle.session);
	}

	delete(runId: string, stepIndex?: number): void {
		if (stepIndex === undefined) {
			this.handles.delete(runId);
			this.handleStates.delete(runId);
			this.controllers.delete(runId);
			return;
		}
		const byStep = this.handles.get(runId);
		byStep?.delete(stepIndex);
		const statesByStep = this.handleStates.get(runId);
		statesByStep?.delete(stepIndex);
		if (!byStep || byStep.size === 0) {
			this.handles.delete(runId);
			this.handleStates.delete(runId);
			this.controllers.delete(runId);
		}
	}

	list(): ChildAgentHandle[] {
		return [...this.handles.values()].flatMap((byStep) => [...byStep.values()]);
	}

	snapshot(): { runId: string; stepIndex: number }[] {
		return this.list().map((handle) => ({ runId: handle.runId, stepIndex: handle.stepIndex }));
	}

	async abortAll(reason: string): Promise<void> {
		await Promise.all([...this.handles.keys()].map((runId) => this.abortRun(runId, reason)));
	}

	async abortQueued(reason: string): Promise<void> {
		const queuedHandles = [...this.handleStates].flatMap(([runId, statesByStep]) =>
			[...statesByStep]
				.filter(([, state]) => state === "queued")
				.flatMap(([stepIndex]) => {
					const handle = this.handles.get(runId)?.get(stepIndex);
					return handle ? [handle] : [];
				}),
		);
		await Promise.all(queuedHandles.map((handle) => handle.abort(reason)));
	}

	async abortRun(runId: string, reason: string): Promise<void> {
		const controller = this.controllerForRun(runId);
		if (!controller.signal.aborted) {
			controller.abort(reason);
		}
		await Promise.all([...(this.handles.get(runId)?.values() ?? [])].map((handle) => handle.abort(reason)));
	}

	/**
	 * Seed the in-memory RunView mirror for a run from its dispatch metadata.
	 * IDEMPOTENT: a no-op once a status exists, so multi-step sync runs that
	 * register N times per runId never re-seed. Builds the initial status via the
	 * SAME statusFromMeta builder that seeds status.json, so the two never diverge.
	 */
	seedRunView(runId: string, seed: RunViewSeed): void {
		if (this.statuses.has(runId)) return;
		this.statuses.set(runId, statusFromMeta(runId, seed));
		this.viewMeta.set(runId, {
			...(seed.parentSessionId ? { parentSessionId: seed.parentSessionId } : {}),
			...(seed.rootSessionId ? { rootSessionId: seed.rootSessionId } : {}),
			...(seed.asyncDir ? { asyncDir: seed.asyncDir } : {}),
		});
	}

	/**
	 * Apply a StatusPatch to the in-memory mirror through the SAME
	 * applyPatchToStatus the on-disk writer uses. Stamps terminalAt when the
	 * patch drives the run into a terminal state, opening the retention window.
	 */
	applyStatusPatch(patch: StatusPatch): void {
		const s = this.statuses.get(patch.runId);
		if (!s) return;
		applyPatchToStatus(s, patch);
		if (isTerminalState(s.state)) this.markTerminal(patch.runId);
		else this.clearTerminal(patch.runId);
	}

	/**
	 * Land terminal result metadata (output, final usage, and endedAt) that is NOT carried in
	 * the patch stream. This is the one explicit non-patch memory update.
	 */
	finalizeView(runId: string, result: ChildAgentResult): void {
		const s = this.statuses.get(runId);
		if (!s) return;
		const total = tokenUsageFromUsage(result.usage);
		if (total) s.totalTokens = total;
		s.state = result.state;
		s.outputText = result.outputText;
		s.endedAt ??= result.endedAt ?? Date.now();
		this.markTerminal(runId);
	}

	dispose(): void {
		if (this.retentionTimer) clearTimeout(this.retentionTimer);
		this.retentionTimer = undefined;
		this.handles.clear();
		this.handleStates.clear();
		this.controllers.clear();
		this.statuses.clear();
		this.viewMeta.clear();
		this.terminalAt.clear();
	}

	/** Project a run's in-memory status onto the canonical RunView. Memory-only. */
	getRunView(runId: string): RunView | undefined {
		const s = this.statuses.get(runId);
		if (!s) return undefined;
		return this.toRunView(runId, s);
	}

	/**
	 * Project all live runs onto RunView, also sweeping against an injected clock
	 * for callers and tests that need an immediate current snapshot.
	 */
	listRunViews(now = Date.now()): RunView[] {
		this.evictExpired(now);
		this.scheduleRetention();
		return [...this.statuses.entries()].map(([id, s]) => this.toRunView(id, s));
	}

	private markTerminal(runId: string): void {
		this.terminalAt.set(runId, Date.now());
		this.scheduleRetention();
	}

	private clearTerminal(runId: string): void {
		if (!this.terminalAt.delete(runId)) return;
		this.scheduleRetention();
	}

	private evictExpired(now = Date.now()): void {
		for (const [runId, terminalAt] of this.terminalAt) {
			if (now - terminalAt < this.retentionMs) continue;
			this.statuses.delete(runId);
			this.viewMeta.delete(runId);
			this.terminalAt.delete(runId);
		}
	}

	private scheduleRetention(): void {
		if (this.retentionTimer) clearTimeout(this.retentionTimer);
		this.retentionTimer = undefined;
		let nextDeadline: number | undefined;
		for (const terminalAt of this.terminalAt.values()) {
			const deadline = terminalAt + this.retentionMs;
			if (nextDeadline === undefined || deadline < nextDeadline) nextDeadline = deadline;
		}
		if (nextDeadline === undefined) return;
		this.retentionTimer = setTimeout(
			() => {
				this.retentionTimer = undefined;
				this.evictExpired();
				this.scheduleRetention();
			},
			Math.max(0, nextDeadline - Date.now()),
		);
		this.retentionTimer.unref?.();
	}

	private toRunView(runId: string, s: PersistedRunStatus & { steps: PersistedRunStep[] }): RunView {
		const extra = this.viewMeta.get(runId);
		const view = statusToRunView(extra?.asyncDir ?? s.sessionDir ?? "", s);
		return {
			...view,
			...(extra?.parentSessionId ? { parentSessionId: extra.parentSessionId } : {}),
			...(extra?.rootSessionId ? { rootSessionId: extra.rootSessionId } : {}),
		};
	}

	private controllerForRun(runId: string): AbortController {
		let controller = this.controllers.get(runId);
		if (!controller) {
			controller = new AbortController();
			this.controllers.set(runId, controller);
		}
		return controller;
	}
}
