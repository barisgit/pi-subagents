import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { statusToSummary } from "../../async-status.ts";
import { StatusWriter } from "../../status-writer.ts";
import { writeSyncRunStatusUpdate } from "../../sync-run-persistence.ts";
import { RUNS_DIR, type AsyncStatus } from "../../types.ts";

function createTempDir(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function removeTempDir(dir: string): void {
	fs.rmSync(dir, { recursive: true, force: true });
}

function readStatus(dir: string): AsyncStatus {
	return JSON.parse(fs.readFileSync(path.join(dir, "status.json"), "utf-8")) as AsyncStatus;
}

function writeStatus(dir: string, status: AsyncStatus): void {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify(status, null, 2), "utf-8");
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

let testsRun = 0;

afterEach(() => {
	testsRun++;
});

after(() => {
	process.stdout.write(`# tests ${testsRun}\n`);
});

function uniqueRunId(prefix: string): string {
	return `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function newShapeStatus(runId: string): AsyncStatus {
	return {
		runId,
		mode: "single",
		label: "schema compat",
		state: "running",
		startedAt: 10_000,
		lastUpdate: 10_200,
		runnerHeartbeatAt: 10_200,
		phase: "thinking",
		phaseStartedAt: 10_100,
		cwd: "/repo",
		currentStep: 0,
		currentTool: "read",
		currentToolStartedAt: 10_150,
		steps: [{
			agent: "fixer",
			label: "write tests",
			status: "running",
			lastActivityAt: 10_200,
			currentTool: "read",
			currentToolStartedAt: 10_150,
			live: {
				color: "cyan",
				thinking: "checking schema",
				phase: "thinking",
				phaseStartedAt: 10_100,
				toolCount: 1,
				tokens: 42,
			},
		}],
		sessionFile: "session.jsonl",
		totalTokens: { input: 2, output: 3, total: 5 },
	};
}

function pretendLegacyReader(status: AsyncStatus): { steps: Array<{ live?: Record<string, unknown> } & Record<string, unknown>> } & Record<string, unknown> {
	const {
		runId,
		parentRunId,
		mode,
		label,
		state,
		activityState,
		displayState,
		lastActivityAt,
		currentTool,
		currentToolStartedAt,
		startedAt,
		endedAt,
		lastUpdate,
		runnerHeartbeatAt,
		cwd,
		currentStep,
		steps,
		sessionDir,
		outputFile,
		totalTokens,
		totalUsage,
		sessionFile,
	} = status;
	return {
		runId,
		parentRunId,
		mode,
		label,
		state,
		activityState,
		displayState,
		lastActivityAt,
		currentTool,
		currentToolStartedAt,
		startedAt,
		endedAt,
		lastUpdate,
		runnerHeartbeatAt,
		cwd,
		currentStep,
		steps: (steps ?? []).map((step) => {
			const {
				agent,
				label,
				status,
				activityState,
				displayState,
				lastActivityAt,
				currentTool,
				currentToolStartedAt,
				startedAt,
				endedAt,
				durationMs,
				tokens,
				skills,
				model,
				attemptedModels,
				modelAttempts,
				error,
				live,
				sessionFile,
			} = step;
			const legacyLive = live
				? {
					color: live.color,
					thinking: live.thinking,
					currentToolArgs: live.currentToolArgs,
					recentTools: live.recentTools,
					tokenSamples: live.tokenSamples,
					lastToolEndAt: live.lastToolEndAt,
					toolCount: live.toolCount,
					tokens: live.tokens,
				}
				: undefined;
			return {
				agent,
				label,
				status,
				activityState,
				displayState,
				lastActivityAt,
				currentTool,
				currentToolStartedAt,
				startedAt,
				endedAt,
				durationMs,
				tokens,
				skills,
				model,
				attemptedModels,
				modelAttempts,
				error,
				...(legacyLive ? { live: legacyLive } : {}),
				sessionFile,
			};
		}),
		sessionDir,
		outputFile,
		totalTokens,
		totalUsage,
		sessionFile,
	};
}

describe("schema-compat", () => {
	it("schema-compat legacy async status without phase reads with undefined phase", () => {
		const dir = createTempDir("pi-schema-compat-legacy-async-");
		const writer = new StatusWriter({ runRecordDir: dir, runId: "legacy-async", debounceMs: 1 });
		try {
			const startedAt = Date.now();
			writer.initialize({
				mode: "single",
				label: "legacy shape",
				state: "running",
				startedAt,
				cwd: "/repo",
				currentStep: 0,
				steps: [{ agent: "fixer", label: "compat", status: "running", startedAt, lastActivityAt: startedAt }],
			});

			const status = readStatus(dir);
			assert.equal("phase" in status, false);
			assert.equal("phaseStartedAt" in status, false);

			let summary!: ReturnType<typeof statusToSummary>;
			assert.doesNotThrow(() => {
				summary = statusToSummary(dir, status);
			});
			assert.equal(summary.phase, undefined);
			assert.equal(summary.phaseStartedAt, undefined);
			assert.equal(summary.steps[0]?.phase, undefined);
			assert.equal(summary.steps[0]?.phaseStartedAt, undefined);
			assert.equal(summary.id, "legacy-async");
			assert.equal(summary.mode, "single");
			assert.equal(summary.label, "legacy shape");
			assert.equal(summary.cwd, "/repo");
			assert.equal(summary.currentStep, 0);
			assert.equal(summary.steps[0]?.agent, "fixer");
			assert.equal(summary.steps[0]?.label, "compat");
			assert.equal(summary.steps[0]?.status, "running");
		} finally {
			writer.dispose();
			removeTempDir(dir);
		}
	});

	it("schema-compat new async status with phase reads phase fields", async () => {
		const dir = createTempDir("pi-schema-compat-new-async-");
		const writer = new StatusWriter({ runRecordDir: dir, runId: "new-async", debounceMs: 1 });
		try {
			const startedAt = Date.now();
			writer.initialize({
				mode: "single",
				state: "running",
				startedAt,
				currentStep: 0,
				steps: [{ agent: "fixer", status: "running", startedAt }],
			});
			writer.enqueue({
				runId: "new-async",
				stepIndex: 0,
				state: "running",
				phase: "tool_running",
				phaseStartedAt: startedAt + 10,
				runnerHeartbeatAt: startedAt + 20,
			});
			await delay(20);

			const status = readStatus(dir);
			let summary!: ReturnType<typeof statusToSummary>;
			assert.doesNotThrow(() => {
				summary = statusToSummary(dir, status);
			});
			assert.equal(summary.phase, "tool_running");
			assert.equal(summary.phaseStartedAt, startedAt + 10);
			assert.equal(summary.steps[0]?.phase, "tool_running");
			assert.equal(summary.steps[0]?.phaseStartedAt, startedAt + 10);
			assert.equal(summary.id, "new-async");
			assert.equal(summary.steps[0]?.agent, "fixer");
		} finally {
			writer.dispose();
			removeTempDir(dir);
		}
	});

	it("schema-compat legacy sync status without phase reads with undefined phase", () => {
		const runId = uniqueRunId("legacy-sync");
		const runRecordDir = createTempDir("pi-schema-compat-legacy-sync-");
		try {
			const legacyStatus: AsyncStatus = {
				runId,
				mode: "single",
				state: "running",
				startedAt: 20_000,
				lastUpdate: 20_100,
				runnerHeartbeatAt: 20_100,
				cwd: "/repo",
				currentStep: 0,
				steps: [{ agent: "fixer", status: "running", startedAt: 20_000 }],
			};
			writeStatus(runRecordDir, legacyStatus);

			assert.doesNotThrow(() => writeSyncRunStatusUpdate(runId, { lastUpdate: 20_200, runnerHeartbeatAt: 20_200 }, { flush: true }, runRecordDir));
			const status = readStatus(runRecordDir);
			assert.equal(status.phase, undefined);
			assert.equal(status.phaseStartedAt, undefined);
			assert.equal(status.runId, runId);
			assert.equal(status.mode, "single");
			assert.equal(status.state, "running");
			assert.equal(status.cwd, "/repo");
			assert.equal(status.currentStep, 0);
			assert.equal(status.steps?.[0]?.agent, "fixer");
			assert.equal(status.steps?.[0]?.status, "running");
			assert.equal(status.lastUpdate, 20_200);
			assert.equal(status.runnerHeartbeatAt, 20_200);
		} finally {
			removeTempDir(runRecordDir);
			removeTempDir(path.join(RUNS_DIR, runId));
		}
	});

	it("schema-compat roundtrip preserves new status structure", () => {
		const dir = createTempDir("pi-schema-compat-roundtrip-");
		try {
			const original = newShapeStatus("roundtrip-new");
			writeStatus(dir, original);

			const readBack = readStatus(dir);
			let summary!: ReturnType<typeof statusToSummary>;
			assert.doesNotThrow(() => {
				summary = statusToSummary(dir, readBack);
			});
			assert.equal(summary.phase, "thinking");
			assert.equal(summary.phaseStartedAt, 10_100);
			assert.equal(summary.steps[0]?.phase, "thinking");
			assert.equal(summary.steps[0]?.phaseStartedAt, 10_100);

			writeStatus(dir, readBack);
			const reread = readStatus(dir);
			assert.deepEqual(reread, original);
		} finally {
			removeTempDir(dir);
		}
	});

	it("schema-compat old reader strips unknown phase fields", () => {
		const status = newShapeStatus("forward-compat-new");
		let legacy!: ReturnType<typeof pretendLegacyReader>;

		assert.doesNotThrow(() => {
			legacy = pretendLegacyReader(status);
		});

		assert.equal(legacy.runId, "forward-compat-new");
		assert.equal(legacy.mode, "single");
		assert.equal(legacy.state, "running");
		assert.equal(legacy.steps[0]?.agent, "fixer");
		assert.equal(legacy.steps[0]?.status, "running");
		assert.equal(legacy.steps[0]?.live?.thinking, "checking schema");
		assert.equal("phase" in legacy, false);
		assert.equal("phaseStartedAt" in legacy, false);
		assert.equal("phase" in (legacy.steps[0]?.live ?? {}), false);
		assert.equal("phaseStartedAt" in (legacy.steps[0]?.live ?? {}), false);
	});
});
