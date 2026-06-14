import * as fs from "node:fs";
import * as path from "node:path";
import type { ChildAgentResult, ChildAgentExitState, PersistedRunStatus, PersistedRunStep, StatusPatch } from "../protocol/status-types.ts";
import type { TokenUsage } from "../protocol/types.ts";
import { tokenUsageFromUsage } from "./usage-totals.ts";

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
		const startedAt = meta.startedAt ?? Date.now();
		this.status = {
			version: STATUS_JSON_VERSION,
			runId: this.opts.runId,
			mode: meta.mode ?? "single",
			state: meta.state ?? "queued",
			startedAt,
			lastUpdate: meta.lastActivityAt ?? startedAt,
			...(meta.lastActivityAt !== undefined ? { lastActivityAt: meta.lastActivityAt } : {}),
			...(meta.runnerHeartbeatAt !== undefined ? { runnerHeartbeatAt: meta.runnerHeartbeatAt } : {}),
			...(meta.resumedAt !== undefined ? { resumedAt: meta.resumedAt } : {}),
			...(meta.resumeCount !== undefined ? { resumeCount: meta.resumeCount } : {}),
			steps: meta.steps ? meta.steps.map((step) => ({ ...step, live: step.live ? { ...step.live } : undefined })) : [],
			...(meta.label ? { label: meta.label } : {}),
			...(meta.cwd ? { cwd: meta.cwd } : {}),
			...(meta.parentRunId ? { parentRunId: meta.parentRunId } : {}),
			...(meta.currentStep !== undefined ? { currentStep: meta.currentStep } : {}),
			...(meta.sessionFile ? { sessionFile: meta.sessionFile } : {}),
			...(meta.outputFile ? { outputFile: meta.outputFile } : {}),
			...(meta.sessionDir ? { sessionDir: meta.sessionDir } : {}),
		};
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
		const terminal = patch.state === "complete" || patch.state === "failed" || patch.state === "paused";
		if (!options.flush && !terminal && this.lastWriteAt > 0 && now - this.lastWriteAt < this.throttleMs) return;
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
	finalizeTerminal(end: { state?: "complete" | "failed"; steps?: Array<Partial<StatusStep>>; totalTokens?: TokenUsage; sessionFile?: string }): void {
		this.ensureInitialized();
		if (!this.status) return;
		const endedAt = Date.now();
		const steps = this.status.steps.map((step, index) => {
			const patch = end.steps?.[index] ?? {};
			const status = patch.status ?? (end.state === "failed" ? "failed" : step.status === "failed" ? "failed" : "complete");
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

	async finalize(result: ChildAgentResult, options?: { totalUsage?: { input: number; output: number; cacheRead?: number; cacheWrite?: number; cost?: number; turns?: number } }): Promise<void> {
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
	private applyTerminalScalars(args: { state: string; endedAt: number; totalTokens?: TokenUsage }): void {
		if (!this.status) return;
		this.status.state = args.state as StatusState;
		this.status.endedAt = args.endedAt;
		this.status.lastUpdate = args.endedAt;
		this.status.runnerHeartbeatAt = args.endedAt;
		this.status.phase = "idle";
		this.status.phaseStartedAt = undefined;
		this.status.currentTool = undefined;
		this.status.currentToolStartedAt = undefined;
		this.status.activityState = undefined;
		this.status.version = STATUS_JSON_VERSION;
		if (args.totalTokens) this.status.totalTokens = args.totalTokens;
	}

	private ensureInitialized(): void {
		if (!this.status) {
			this.initialize({ state: "running", startedAt: Date.now() });
		}
	}

	private applyPatch(patch: StatusPatch): void {
		if (!this.status) return;
		const now = Date.now();
		this.status.lastUpdate = patch.endedAt ?? now;
		this.status.currentStep = patch.stepIndex;
		const isTerminalStepPatch = patch.endedAt !== undefined && (patch.state === "complete" || patch.state === "failed" || patch.state === "interrupted");
		if (patch.state && !isTerminalStepPatch) this.status.state = patch.state;
		if (patch.endedAt !== undefined) this.status.endedAt = patch.endedAt;
		if (patch.outputText !== undefined && !isTerminalStepPatch) this.status.outputText = patch.outputText;
		if (patch.activity) {
			this.status.lastActivityAt = patch.activity.updatedAt;
			if (patch.activity.toolName !== undefined) {
				this.status.currentTool = patch.activity.toolName;
				this.status.currentToolStartedAt = patch.activity.updatedAt;
			} else if (patch.activity.state !== "tool_running") {
				this.status.currentTool = undefined;
				this.status.currentToolStartedAt = undefined;
			}
		}

		// Merge phase: preserve last-known phase fields when a patch omits them (high-frequency patches must not erase phase state).
		if (patch.phase !== undefined) this.status.phase = patch.phase;
		if (patch.phaseStartedAt !== undefined) this.status.phaseStartedAt = patch.phaseStartedAt;
		// Bump runnerHeartbeatAt on every patch to signal the runner is alive.
		this.status.runnerHeartbeatAt = patch.runnerHeartbeatAt ?? now;

		const step = this.stepFor(patch.stepIndex);
		if (patch.state) step.status = patch.state;
		if (patch.endedAt !== undefined) step.endedAt = patch.endedAt;
		if (patch.activity) {
			step.lastActivityAt = patch.activity.updatedAt;
			if (patch.activity.toolName !== undefined) {
				step.currentTool = patch.activity.toolName;
				step.currentToolStartedAt = patch.activity.updatedAt;
			} else if (patch.activity.state !== "tool_running") {
				step.currentTool = undefined;
				step.currentToolStartedAt = undefined;
			}
		}
		if (patch.liveText !== undefined || patch.toolCallDelta || patch.toolResultDelta || patch.toolErrorDelta || patch.phase !== undefined || patch.phaseStartedAt !== undefined) {
			step.live = step.live ?? {};
			if (patch.liveText !== undefined) step.live.outputText = patch.liveText;
			if (patch.toolCallDelta) step.live.toolCallCount = (step.live.toolCallCount ?? 0) + patch.toolCallDelta;
			if (patch.toolResultDelta) step.live.toolResultCount = (step.live.toolResultCount ?? 0) + patch.toolResultDelta;
			if (patch.toolErrorDelta) step.live.toolErrorCount = (step.live.toolErrorCount ?? 0) + patch.toolErrorDelta;
			if (patch.phase !== undefined) step.live.phase = patch.phase;
			if (patch.phaseStartedAt !== undefined) step.live.phaseStartedAt = patch.phaseStartedAt;
		}
		// Persist live token usage so nested-child readers (which can only see the
		// on-disk status.json, not the runner's in-memory progress) show running
		// token counts instead of ~0 until finalize. Only step.tokens is set; the
		// run total is derived by summing steps when status.totalTokens is absent
		// (inlineTokenCount fallback), so a single live step never clobbers a
		// multi-step aggregate. finalize() later writes the authoritative total.
		if (patch.tokens && patch.tokens.total > 0) {
			step.tokens = { ...patch.tokens };
		}
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

let statusUpdateObserverForTest: ((runId: string, patch: Partial<PersistedRunStatus>, options: { flush?: boolean }, runRecordDir?: string) => void) | undefined;

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
				if (next && typeof next === "object" && !Array.isArray(next) && existing[i] && typeof existing[i] === "object" && !Array.isArray(existing[i])) {
					existing[i] = mergeValue({ ...(existing[i] as Record<string, unknown>) }, next as Record<string, unknown>);
				} else if (next !== undefined) {
					existing[i] = next;
				}
			}
			target[key] = existing;
		} else if (value && typeof value === "object" && !Array.isArray(value) && target[key] && typeof target[key] === "object" && !Array.isArray(target[key])) {
			target[key] = mergeValue({ ...(target[key] as Record<string, unknown>) }, value as Record<string, unknown>);
		} else {
			target[key] = value;
		}
	}
	return target;
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
