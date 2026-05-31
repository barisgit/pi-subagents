import * as fs from "node:fs";
import * as path from "node:path";
import type { ChildAgentResult, ChildAgentExitState, StatusPatch } from "./in-process-executor.ts";
import type { RunPhase } from "./run-phase.ts";
import { tokenUsageFromUsage } from "./usage-totals.ts";

type StatusState = ChildAgentExitState | "queued" | "running" | "paused" | "lost";

type TokenUsage = { input: number; output: number; cacheRead?: number; cacheWrite?: number; total: number };
type StatusUsage = { input: number; output: number; cacheRead?: number; cacheWrite?: number; cost?: number; turns?: number };

export const STATUS_JSON_VERSION = 1;

type StatusStep = {
	agent?: string;
	label?: string;
	status: StatusState | string;
	startedAt?: number;
	endedAt?: number;
	durationMs?: number;
	currentTool?: string;
	currentToolStartedAt?: number;
	lastActivityAt?: number;
	error?: string;
	sessionFile?: string;
	tokens?: TokenUsage;
	live?: {
		color?: string;
		thinking?: string;
		outputText?: string;
		toolCallCount?: number;
		toolResultCount?: number;
		toolErrorCount?: number;
		phase?: RunPhase;
		phaseStartedAt?: number;
	};
};

export interface StatusMeta {
	mode?: "single" | "chain" | "parallel";
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

type StatusPayload = {
	version: typeof STATUS_JSON_VERSION;
	runId: string;
	mode: "single" | "chain" | "parallel";
	label?: string;
	cwd?: string;
	parentRunId?: string;
	state: StatusState;
	startedAt: number;
	endedAt?: number;
	lastUpdate?: number;
	currentStep?: number;
	currentTool?: string;
	currentToolStartedAt?: number;
	lastActivityAt?: number;
	steps: StatusStep[];
	sessionFile?: string;
	outputFile?: string;
	sessionDir?: string;
	outputText?: string;
	error?: string;
	totalTokens?: TokenUsage;
	totalUsage?: StatusUsage;
	/** Current execution phase persisted on every patch. */
	phase?: RunPhase;
	/** Milliseconds since epoch when the current phase was entered. */
	phaseStartedAt?: number;
	/** Milliseconds since epoch of last runner heartbeat (bumped on every patch). */
	runnerHeartbeatAt?: number;
	/** Milliseconds since epoch of the latest accepted resume. */
	resumedAt?: number;
	/** Number of accepted resumes for this run. */
	resumeCount?: number;
};

export class StatusWriter {
	private readonly opts: { runRecordDir: string; runId: string; debounceMs?: number };
	private readonly statusPath: string;
	private readonly debounceMs: number;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private status: StatusPayload | undefined;

	constructor(opts: { runRecordDir: string; runId: string; debounceMs?: number }) {
		this.opts = opts;
		this.debounceMs = opts.debounceMs ?? 500;
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
		this.writeNow();
	}

	enqueue(patch: StatusPatch): void {
		this.ensureInitialized();
		this.applyPatch(patch);
		this.scheduleWrite();
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
			this.status.state = result.state;
			this.status.endedAt = result.endedAt;
			this.status.lastUpdate = result.endedAt;
			this.status.outputText = result.outputText;
			// Clear phase on terminal write so dashboards stop computing
			// `streaming Xs` / `tool: bash Xs` for runs that finished long ago
			// (formatPhase treats idle/undefined as the empty string).
			this.status.phase = "idle";
			this.status.phaseStartedAt = undefined;
			this.status.currentTool = undefined;
			this.status.currentToolStartedAt = undefined;
			if (result.error?.message) this.status.error = result.error.message;
			// Prefer caller-provided aggregate (chain/parallel sum across all
			// steps); fall back to single-step result.usage.
			const aggregate = options?.totalUsage ?? result.usage;
			if (aggregate) {
				this.status.totalUsage = { ...aggregate };
				this.status.totalTokens = tokenUsageFromUsage(aggregate);
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

let writeJsonImpl = writeJson;

export function __setStatusWriterWriteJsonForTest(fn: (filePath: string, payload: object) => void): () => void {
	const previous = writeJsonImpl;
	writeJsonImpl = fn;
	return () => {
		writeJsonImpl = previous;
	};
}

function writeJson(filePath: string, payload: object): void {
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
