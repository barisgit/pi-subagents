import * as fs from "node:fs";
import * as path from "node:path";
import type { RunPhase } from "./run-phase.ts";
import { RUNS_DIR, type AsyncStatus, type TokenUsage } from "../protocol/types.ts";
import { finalizeRunScalars, writeStatusJson } from "./status-writer.ts";

const MIN_UPDATE_INTERVAL_MS = 250;
const lastWriteByRun = new Map<string, number>();

export interface SyncRunStepInit {
	agent: string;
	label?: string;
	task?: string;
	sessionFile?: string;
}

export type SyncRunStatusPatch = Partial<AsyncStatus> & {
	phase?: RunPhase;
	phaseStartedAt?: number;
};

let statusUpdateObserverForTest: ((runId: string, patch: SyncRunStatusPatch, options: { flush?: boolean }, runRecordDir?: string) => void) | undefined;

export function __setSyncRunStatusUpdateObserverForTest(observer: typeof statusUpdateObserverForTest): () => void {
	const previous = statusUpdateObserverForTest;
	statusUpdateObserverForTest = observer;
	return () => {
		statusUpdateObserverForTest = previous;
	};
}

export function ensureSyncRunDir(runId: string): string {
	const dir = path.join(RUNS_DIR, runId);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

function statusPath(runId: string): string {
	return path.join(ensureSyncRunDir(runId), "status.json");
}

function runRecordStatusPath(runRecordDir: string): string {
	return path.join(runRecordDir, "status.json");
}

function writeStatus(runId: string, status: AsyncStatus, runRecordDir?: string): void {
	// Shared atomic temp+rename writer (status-writer.ts). Kills the previous
	// non-atomic writeFileSync torn-read window and keeps the terminal file
	// byte-stable for the leafSummaryCache mtime+size identity. The legacy
	// RUNS_DIR/<runId> path is still written here (not dropped); the optional
	// runRecordDir mirror is written when distinct.
	const legacyPath = statusPath(runId);
	writeStatusJson(legacyPath, status);
	if (runRecordDir) {
		const mirrorPath = runRecordStatusPath(runRecordDir);
		if (path.resolve(mirrorPath) !== path.resolve(legacyPath)) {
			writeStatusJson(mirrorPath, status);
		}
	}
	lastWriteByRun.set(runId, Date.now());
}

function readStatus(runId: string, runRecordDir?: string): AsyncStatus {
	if (runRecordDir) {
		try {
			return JSON.parse(fs.readFileSync(runRecordStatusPath(runRecordDir), "utf-8")) as AsyncStatus;
		} catch {
			// Fall back to the legacy mirror for compatibility with in-flight runs.
		}
	}
	return JSON.parse(fs.readFileSync(statusPath(runId), "utf-8")) as AsyncStatus;
}

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

export function writeSyncRunStatusStart(runId: string, init: {
	mode: AsyncStatus["mode"];
	startedAt?: number;
	cwd?: string;
	label?: string;
	parentRunId?: string;
	steps: SyncRunStepInit[];
}, runRecordDir?: string): void {
	const startedAt = init.startedAt ?? Date.now();
	// charter nested-subagent-display: sync runs now enter the async status pipeline.
	writeStatus(runId, {
		runId,
		...(init.parentRunId ? { parentRunId: init.parentRunId } : {}),
		mode: init.mode,
		...(init.label ? { label: init.label } : {}),
		state: "running",
		startedAt,
		lastUpdate: startedAt,
		runnerHeartbeatAt: startedAt,
		...(init.cwd ? { cwd: init.cwd } : {}),
		currentStep: 0,
		steps: init.steps.map((step) => ({
			agent: step.agent,
			...(step.label ? { label: step.label } : {}),
			status: "pending",
			...(step.sessionFile ? { sessionFile: step.sessionFile } : {}),
		})),
	}, runRecordDir);
}

export function writeSyncRunStatusUpdate(runId: string, patch: SyncRunStatusPatch, options: { flush?: boolean } = {}, runRecordDir?: string): void {
	statusUpdateObserverForTest?.(runId, patch, options, runRecordDir);
	let current: AsyncStatus;
	try {
		current = readStatus(runId, runRecordDir);
	} catch {
		return;
	}
	const now = Date.now();
	const terminal = patch.state === "complete" || patch.state === "failed" || patch.state === "paused";
	const lastWrite = lastWriteByRun.get(runId) ?? 0;
	if (!options.flush && !terminal && lastWrite > 0 && now - lastWrite < MIN_UPDATE_INTERVAL_MS) return;
	const merged = mergeValue({ ...current }, { ...patch, lastUpdate: patch.lastUpdate ?? now, runnerHeartbeatAt: patch.runnerHeartbeatAt ?? now }) as unknown as AsyncStatus;
	writeStatus(runId, merged, runRecordDir);
}

export function writeSyncRunStatusEnd(runId: string, end: {
	state?: "complete" | "failed";
	steps?: Array<Partial<NonNullable<AsyncStatus["steps"]>[number]>>;
	totalTokens?: TokenUsage;
	sessionFile?: string;
}, runRecordDir?: string): void {
	let current: AsyncStatus;
	try {
		current = readStatus(runId, runRecordDir);
	} catch {
		return;
	}
	const endedAt = Date.now();
	const steps = (current.steps ?? []).map((step, index) => {
		const patch = end.steps?.[index] ?? {};
		const status = patch.status ?? (end.state === "failed" ? "failed" : step.status === "failed" ? "failed" : "complete");
		const startedAt = patch.startedAt ?? step.startedAt ?? current.startedAt;
		return {
			...step,
			...patch,
			status,
			endedAt: patch.endedAt ?? endedAt,
			durationMs: patch.durationMs ?? (startedAt ? endedAt - startedAt : undefined),
		};
	});
	// Apply the shared terminal convention (state/endedAt/lastUpdate/
	// runnerHeartbeatAt/phase:'idle'/phaseStartedAt:undefined/cleared
	// currentTool+activityState/version:1/totalTokens) so the sync path
	// finalizes byte-consistently with the async StatusWriter.
	const finalStatus: AsyncStatus = {
		...current,
		steps,
		...(end.sessionFile ? { sessionFile: end.sessionFile } : {}),
	};
	finalizeRunScalars(finalStatus, {
		state: end.state ?? "complete",
		endedAt,
		...(end.totalTokens ? { totalTokens: end.totalTokens } : {}),
	});
	writeStatus(runId, finalStatus, runRecordDir);
}
