import * as fs from "node:fs";
import * as path from "node:path";
import {
	type ChildAgentResult,
	type ChildAgentExitState,
	type PersistedRunStatus,
	type PersistedRunStep,
	type StatusPatch,
	parsePersistedRunStatus,
} from "../protocol/status-types.ts";
import type { TokenUsage } from "../protocol/types.ts";
import { tokenUsageFromUsage } from "./usage-totals.ts";
import { applyPatchToStatus } from "./status-patch.ts";
import { STALE_MTIME_THRESHOLD_MS } from "../shared/utils.ts";

export type FlushPolicy = "terminal" | "eager";

export interface StatusWriterOpts {
	runRecordDir: string;
	runId: string;
	/** Coalescing mechanism. 'eager' (default) debounces; 'terminal' leading-edge throttles write-through. */
	flushPolicy?: FlushPolicy;
	/** EAGER debounce window (ms). */
	debounceMs?: number;
	/** TERMINAL leading-edge throttle window (ms). */
	throttleMs?: number;
}

/** Minimum interval between throttled terminal-policy writes; the leading-edge clock. */
const MIN_UPDATE_INTERVAL_MS = 250;

type StatusState = ChildAgentExitState | "queued" | "running" | "paused" | "lost";

export const STATUS_JSON_VERSION = 1;

type StatusStep = PersistedRunStep;

export interface StatusMeta {
	mode?: "single" | "parallel";
	label?: string;
	cwd?: string;
	parentRunId?: string;
	startedAt?: number;
	state?: StatusState;
	currentStep?: number;
	steps?: StatusStep[];
	sessionFile?: string;
	outputFile?: string;
	sessionDir?: string;
	lastActivityAt?: number;
	runnerHeartbeatAt?: number;
	resumedAt?: number;
	resumeCount?: number;
}

/**
 * Build the initial {@link PersistedRunStatus} from {@link StatusMeta}. Single
 * source of truth for the seeded status shape: StatusWriter.initialize stamps
 * status.json from it, and ChildAgentRegistry.seedRunView seeds its in-memory
 * RunView mirror from the same builder so the two never diverge.
 */
export function statusFromMeta(runId: string, meta: StatusMeta): PersistedRunStatus & { steps: PersistedRunStep[] } {
	const startedAt = meta.startedAt ?? Date.now();
	return {
		version: STATUS_JSON_VERSION,
		runId,
		mode: meta.mode ?? "single",
		state: meta.state ?? "queued",
		startedAt,
		lastUpdate: meta.lastActivityAt ?? startedAt,
		...(meta.lastActivityAt !== undefined ? { lastActivityAt: meta.lastActivityAt } : {}),
		...(meta.runnerHeartbeatAt !== undefined ? { runnerHeartbeatAt: meta.runnerHeartbeatAt } : {}),
		...(meta.resumedAt !== undefined ? { resumedAt: meta.resumedAt } : {}),
		...(meta.resumeCount !== undefined ? { resumeCount: meta.resumeCount } : {}),
		steps: meta.steps
			? meta.steps.map((step) => ({ ...step, live: step.live ? { ...step.live } : undefined }))
			: [],
		...(meta.label ? { label: meta.label } : {}),
		...(meta.cwd ? { cwd: meta.cwd } : {}),
		...(meta.parentRunId ? { parentRunId: meta.parentRunId } : {}),
		...(meta.currentStep !== undefined ? { currentStep: meta.currentStep } : {}),
		...(meta.sessionFile ? { sessionFile: meta.sessionFile } : {}),
		...(meta.outputFile ? { outputFile: meta.outputFile } : {}),
		...(meta.sessionDir ? { sessionDir: meta.sessionDir } : {}),
	};
}

export class StatusWriter {
	private readonly opts: StatusWriterOpts;
	readonly runRecordDir: string;
	private readonly statusPath: string;
	private readonly flushPolicy: FlushPolicy;
	private readonly debounceMs: number;
	private readonly throttleMs: number;
	private timer: ReturnType<typeof setTimeout> | undefined;
	/**
	 * In-memory canonical persisted run status held + serialized by the writer.
	 * `steps` is narrowed to required because the writer always initializes it to
	 * `[]`; readers see the optional `steps?` of PersistedRunStatus.
	 */
	private status: (PersistedRunStatus & { steps: PersistedRunStep[] }) | undefined;
	/** Per-run leading-edge throttle clock (TERMINAL policy); replaces the module-global lastWriteByRun map. */
	private lastWriteAt = 0;

	constructor(opts: StatusWriterOpts) {
		this.opts = opts;
		this.runRecordDir = opts.runRecordDir;
		this.flushPolicy = opts.flushPolicy ?? "eager";
		this.debounceMs = opts.debounceMs ?? 500;
		this.throttleMs = opts.throttleMs ?? MIN_UPDATE_INTERVAL_MS;
		this.statusPath = path.join(opts.runRecordDir, "status.json");
	}

	initialize(meta: StatusMeta): void {
		this.status = statusFromMeta(this.opts.runId, meta);
		this.lastWriteAt = Date.now();
		this.writeNow();
	}

	enqueue(patch: StatusPatch): void {
		if (this.flushPolicy !== "eager") throw new Error("StatusWriter.enqueue requires flushPolicy 'eager'");
		this.ensureInitialized();
		this.applyPatch(patch);
		this.scheduleWrite();
	}

	/**
	 * TERMINAL-policy free-form merge with leading-edge throttle + write-through.
	 * On each call: terminal states (complete|failed|paused) and flush:true bypass
	 * the throttle and write immediately. Otherwise, if the throttle window has not
	 * elapsed since the last accepted write, EARLY-RETURN WITHOUT mutating the
	 * in-memory payload (data-drop, mirroring the old read-from-disk free function
	 * where a throttled patch never touched disk). Dropping without applying keeps
	 * in-memory === last-written-disk so the deep-merge base matches the prior
	 * on-disk base and the terminal file stays byte-stable.
	 */
	mergePatch(patch: Partial<PersistedRunStatus>, options: { flush?: boolean } = {}): void {
		if (this.flushPolicy !== "terminal") throw new Error("StatusWriter.mergePatch requires flushPolicy 'terminal'");
		statusUpdateObserverForTest?.(this.opts.runId, patch, options, this.opts.runRecordDir);
		this.ensureInitialized();
		if (!this.status) return;
		const now = Date.now();
		// A run-level state TRANSITION must never be throttled away: terminal ends
		// (complete/failed/paused) and the queued->running flip when a child starts
		// must reach disk promptly, or the dashboard reads a stale state. Repeated
		// same-state progress patches still throttle normally.
		const stateTransition = patch.state !== undefined && patch.state !== this.status.state;
		if (!options.flush && !stateTransition && this.lastWriteAt > 0 && now - this.lastWriteAt < this.throttleMs)
			return;
		mergeValue(this.status as unknown as Record<string, unknown>, {
			...patch,
			lastUpdate: patch.lastUpdate ?? now,
			runnerHeartbeatAt: patch.runnerHeartbeatAt ?? now,
		});
		this.lastWriteAt = now;
		this.writeNow();
	}

	/**
	 * TERMINAL-policy end write (formerly the sync end free function): finalize
	 * the resumed/running step set, then apply the shared run-level terminal
	 * convention. Writes immediately.
	 */
	finalizeTerminal(end: {
		state?: "complete" | "failed" | "interrupted";
		steps?: Array<Partial<StatusStep>>;
		totalTokens?: TokenUsage;
		sessionFile?: string;
	}): void {
		this.ensureInitialized();
		if (!this.status) return;
		const endedAt = Date.now();
		const steps = this.status.steps.map((step, index) => {
			const patch = end.steps?.[index] ?? {};
			// A non-complete run-level end (failed/interrupted) drags an unpatched step to
			// the same non-complete state; an explicit per-step patch.status always wins.
			const status =
				patch.status ??
				(end.state === "failed" || end.state === "interrupted"
					? end.state
					: step.status === "failed"
						? "failed"
						: "complete");
			const startedAt = patch.startedAt ?? step.startedAt ?? this.status!.startedAt;
			return {
				...step,
				...patch,
				status,
				endedAt: patch.endedAt ?? endedAt,
				durationMs: patch.durationMs ?? (startedAt ? endedAt - startedAt : undefined),
			};
		});
		this.status.steps = steps;
		if (end.sessionFile) this.status.sessionFile = end.sessionFile;
		this.applyTerminalScalars({
			state: end.state ?? "complete",
			endedAt,
			...(end.totalTokens ? { totalTokens: end.totalTokens } : {}),
		});
		this.lastWriteAt = endedAt;
		this.writeNow();
	}

	async finalize(
		result: ChildAgentResult,
		options?: {
			totalUsage?: {
				input: number;
				output: number;
				cacheRead?: number;
				cacheWrite?: number;
				cost?: number;
				turns?: number;
			};
		},
	): Promise<void> {
		this.ensureInitialized();
		this.clearTimer();
		this.applyPatch({
			runId: result.runId,
			stepIndex: result.stepIndex,
			state: result.state,
			endedAt: result.endedAt,
			outputText: result.outputText,
		});
		if (this.status) {
			// Prefer caller-provided aggregate (parallel sum across all
			// steps); fall back to single-step result.usage.
			const aggregate = options?.totalUsage ?? result.usage;
			// Shared run-level terminal convention (state/endedAt/lastUpdate/
			// runnerHeartbeatAt/phase:'idle'/phaseStartedAt:undefined/cleared
			// currentTool/activityState/version/totalTokens) so the async and
			// sync writers finalize byte-consistently. Clearing phase stops
			// dashboards computing `streaming Xs` on a long-finished run
			// (formatPhase treats idle/undefined as the empty string).
			this.applyTerminalScalars({
				state: result.state,
				endedAt: result.endedAt,
				...(aggregate ? { totalTokens: tokenUsageFromUsage(aggregate) } : {}),
			});
			this.status.outputText = result.outputText;
			if (result.error?.message) this.status.error = result.error.message;
			if (aggregate) {
				this.status.totalUsage = { ...aggregate };
			}
			const step = this.stepFor(result.stepIndex);
			step.status = result.state;
			step.endedAt = result.endedAt;
			step.durationMs = result.durationMs;
			if (result.error?.message) step.error = result.error.message;
			if (result.usage) {
				step.tokens = tokenUsageFromUsage(result.usage);
			}
			step.live = {
				...(step.live ?? {}),
				outputText: result.outputText,
				toolCallCount: result.toolCallCount,
				toolResultCount: result.toolResultCount,
				toolErrorCount: result.toolErrorCount,
			};
		}
		this.writeNow();
	}

	dispose(): void {
		this.clearTimer();
	}

	/**
	 * Apply the one terminal run-level convention (ex-finalizeRunScalars), driven
	 * by BOTH finalize() and finalizeTerminal(): set terminal state/timestamps,
	 * bump runnerHeartbeatAt to endedAt, clear the live phase to 'idle' (with
	 * phaseStartedAt undefined so formatPhase yields the empty string), clear the
	 * current tool + activity, stamp the schema version, and persist the run total
	 * token usage when provided. Mutates this.status in place.
	 */
	private applyTerminalScalars(args: {
		state: PersistedRunStatus["state"];
		endedAt: number;
		totalTokens?: TokenUsage;
	}): void {
		if (!this.status) return;
		stampTerminalScalars(this.status, args);
	}

	private ensureInitialized(): void {
		if (!this.status) {
			this.initialize({ state: "running", startedAt: Date.now() });
		}
	}

	private applyPatch(patch: StatusPatch): void {
		if (!this.status) return;
		applyPatchToStatus(this.status, patch);
	}

	private stepFor(stepIndex: number): StatusStep {
		if (!this.status) throw new Error("StatusWriter is not initialized");
		while (this.status.steps.length <= stepIndex) {
			this.status.steps.push({ status: "queued" });
		}
		return this.status.steps[stepIndex]!;
	}

	private scheduleWrite(): void {
		if (this.timer) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.writeNow();
		}, this.debounceMs);
	}

	private writeNow(): void {
		if (!this.status) return;
		writeJsonImpl(this.statusPath, this.status);
	}

	private clearTimer(): void {
		if (!this.timer) return;
		clearTimeout(this.timer);
		this.timer = undefined;
	}
}

let writeJsonImpl = writeStatusJson;

export function __setStatusWriterWriteJsonForTest(fn: (filePath: string, payload: object) => void): () => void {
	const previous = writeJsonImpl;
	writeJsonImpl = fn;
	return () => {
		writeJsonImpl = previous;
	};
}

let statusUpdateObserverForTest:
	| ((runId: string, patch: Partial<PersistedRunStatus>, options: { flush?: boolean }, runRecordDir?: string) => void)
	| undefined;

/** Fires inside mergePatch (TERMINAL policy) for the caller-forwards-phase test hook. */
export function __setSyncRunStatusUpdateObserverForTest(observer: typeof statusUpdateObserverForTest): () => void {
	const previous = statusUpdateObserverForTest;
	statusUpdateObserverForTest = observer;
	return () => {
		statusUpdateObserverForTest = previous;
	};
}

/**
 * Deep merge with index-wise array merge (ex-sync-run-persistence mergeValue),
 * backing {@link StatusWriter.mergePatch}. Kept distinct from applyPatch: the
 * free-form Partial<PersistedRunStatus> patch language (mergePatch) does NOT converge
 * with the structured StatusPatch language (enqueue); routing the foreground
 * mirror through enqueue would gain step.live.* and change the on-disk step
 * shape.
 */
function mergeValue(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
	for (const [key, value] of Object.entries(source)) {
		if (value === undefined) continue;
		if (Array.isArray(value)) {
			const existing = Array.isArray(target[key]) ? [...(target[key] as unknown[])] : [];
			for (let i = 0; i < value.length; i++) {
				const next = value[i];
				if (
					next &&
					typeof next === "object" &&
					!Array.isArray(next) &&
					existing[i] &&
					typeof existing[i] === "object" &&
					!Array.isArray(existing[i])
				) {
					existing[i] = mergeValue(
						{ ...(existing[i] as Record<string, unknown>) },
						next as Record<string, unknown>,
					);
				} else if (next !== undefined) {
					existing[i] = next;
				}
			}
			target[key] = existing;
		} else if (
			value &&
			typeof value === "object" &&
			!Array.isArray(value) &&
			target[key] &&
			typeof target[key] === "object" &&
			!Array.isArray(target[key])
		) {
			target[key] = mergeValue({ ...(target[key] as Record<string, unknown>) }, value as Record<string, unknown>);
		} else {
			target[key] = value;
		}
	}
	return target;
}

/**
 * Apply the one terminal run-level convention onto a {@link PersistedRunStatus}
 * in place (ex-StatusWriter.applyTerminalScalars body): set terminal
 * state/timestamps, bump runnerHeartbeatAt to endedAt, clear the live phase to
 * 'idle' (with phaseStartedAt undefined so formatPhase yields the empty
 * string), clear the current tool + activity, stamp the schema version, and
 * persist the run total token usage when provided.
 */
export function stampTerminalScalars(
	status: PersistedRunStatus,
	fields: { state: PersistedRunStatus["state"]; endedAt: number; totalTokens?: TokenUsage },
): void {
	status.state = fields.state;
	status.endedAt = fields.endedAt;
	status.lastUpdate = fields.endedAt;
	status.runnerHeartbeatAt = fields.endedAt;
	status.phase = "idle";
	status.phaseStartedAt = undefined;
	status.currentTool = undefined;
	status.currentToolStartedAt = undefined;
	status.activityState = undefined;
	status.version = STATUS_JSON_VERSION;
	if (fields.totalTokens) status.totalTokens = fields.totalTokens;
}

/**
 * Read-modify-write a run's status.json to a terminal state through the same
 * atomic {@link writeStatusJson} the writer uses. Fail-closed: if the file is
 * absent or fails the validating codec, returns null WITHOUT writing.
 * Idempotent: if the persisted run is no longer 'running', returns it unchanged
 * with NO write. Otherwise stamps the terminal convention (preserving the
 * existing total token usage) and persists atomically.
 *
 * Used to finalize an ungracefully killed/lost in-process runner whose frozen
 * status.json is still pinned at state:'running' so it becomes resumable.
 *
 * Also persists a stale QUEUED orphan (a child blocked on a leaf permit when its
 * owning per-activation registry died) to terminal-lost. A queued record never
 * advances its heartbeat — the ticker only starts after the permit is acquired —
 * so queued reaping keys on the SAME mtime-staleness ceiling the read path
 * ({@link readStatus}) already uses to derive such records to lost: only a queued
 * record whose status.json mtime is older than {@link STALE_MTIME_THRESHOLD_MS}
 * had zero progress and a dead owner. A live queued run (fresh mtime, still
 * waiting for a permit) is returned unchanged with NO write. The 'running' path is
 * unconditional (callers gate it on a hard-dead heartbeat) and stays byte-stable.
 */
export function reconcileRunToTerminalOnDisk(
	runRecordDir: string,
	state: "lost" | "interrupted" | "failed",
	now: number = Date.now(),
): PersistedRunStatus | null {
	const statusPath = path.join(runRecordDir, "status.json");
	let raw: string;
	let mtimeMs: number;
	try {
		raw = fs.readFileSync(statusPath, "utf-8");
		mtimeMs = fs.statSync(statusPath).mtimeMs;
	} catch {
		return null;
	}
	const parsed = parsePersistedRunStatus(raw);
	if (!parsed.ok) return null;
	const status = parsed.value;
	if (status.state !== "running" && status.state !== "queued") return status;
	// A queued record is only reaped once its mtime is stale past the shared ceiling;
	// a fresh queued run is a live permit-waiter and must never be written. Running is
	// reaped unconditionally here (the call site gates it on a hard-dead heartbeat).
	if (status.state === "queued" && now - mtimeMs <= STALE_MTIME_THRESHOLD_MS) return status;
	const updated: PersistedRunStatus = { ...status };
	stampTerminalScalars(updated, {
		state,
		endedAt: now,
		...(updated.totalTokens ? { totalTokens: updated.totalTokens } : {}),
	});
	writeStatusJson(statusPath, updated);
	return updated;
}

export function writeStatusJson(filePath: string, payload: object): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const tempPath = path.join(
		path.dirname(filePath),
		`.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
	);
	try {
		fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), "utf-8");
		fs.renameSync(tempPath, filePath);
	} finally {
		if (fs.existsSync(tempPath)) {
			try {
				fs.unlinkSync(tempPath);
			} catch {}
		}
	}
}
