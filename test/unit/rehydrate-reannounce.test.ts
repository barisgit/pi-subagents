import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { createAsyncJobTracker } from "../../src/surfaces/async-job-tracker.ts";
import { appendRunEntry, setRegistryPathForTests, type RunsRegistryEntry } from "../../src/state/runs-registry.ts";
import { SUBAGENT_ASYNC_STARTED_EVENT } from "../../src/protocol/types.ts";

const tmpRoots: string[] = [];

function tmpRegistry(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "rehydrate-reannounce-test-"));
	tmpRoots.push(root);
	setRegistryPathForTests(path.join(root, "registry", "runs-index.jsonl"));
	return root;
}

function createState() {
	return {
		baseCwd: "/repo",
		currentSessionId: null,
		asyncJobs: new Map(),
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null as ReturnType<typeof setInterval> | null,
	};
}

function createPi(emitted: Array<{ channel: string; data: unknown }>) {
	return {
		events: {
			emit: (channel: string, data: unknown) => {
				emitted.push({ channel, data });
			},
		},
	};
}

function seedRunningRun(root: string, runId: string, rootSessionId: string): void {
	const runRecordDir = path.join(root, "runs", runId);
	fs.mkdirSync(runRecordDir, { recursive: true });
	fs.writeFileSync(
		path.join(runRecordDir, "status.json"),
		JSON.stringify({
			runId,
			mode: "single",
			state: "running",
			startedAt: Date.now() - 1000,
			lastUpdate: Date.now(),
			runnerHeartbeatAt: Date.now(),
			cwd: root,
			currentStep: 0,
			steps: [{ agent: "explorer", status: "running", startedAt: Date.now() - 1000 }],
		}),
		"utf8",
	);
	appendRunEntry({
		runId,
		runRecordDir,
		mode: "single",
		source: "async",
		agentName: "explorer",
		cwd: root,
		rootSessionId,
		startedAt: Date.now() - 1000,
	} as RunsRegistryEntry);
}

afterEach(() => {
	setRegistryPathForTests(null);
	for (const root of tmpRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("rehydrate re-announce", () => {
	it("re-emits async-started for reclaimed in-flight runs so cross-extension listeners rebuild state after reload", () => {
		const root = tmpRegistry();
		const sessionId = "host-session-1";
		seedRunningRun(root, "reclaimed-run", sessionId);

		const emitted: Array<{ channel: string; data: unknown }> = [];
		const state = createState();
		const startedRuns: string[] = [];
		const idleTracker = {
			onAsyncStarted: (runId: string) => startedRuns.push(runId),
			onAsyncFinished: (_runId: string) => {},
		};
		const tracker = createAsyncJobTracker(createPi(emitted) as never, state as never, {
			pollIntervalMs: 60_000,
			idleTracker: idleTracker as never,
		});
		const ctx = {
			hasUI: false,
			sessionManager: { getSessionId: () => sessionId },
		};

		try {
			const added = tracker.rehydrateFromRegistry(ctx as never);
			assert.equal(added, 1);
			assert.ok(state.asyncJobs.has("reclaimed-run"));

			const started = emitted.filter((e) => e.channel === SUBAGENT_ASYNC_STARTED_EVENT);
			assert.equal(started.length, 1);
			const payload = started[0]!.data as {
				runId?: string;
				reclaimed?: boolean;
				asyncDir?: string;
				agent?: string;
			};
			assert.equal(payload.runId, "reclaimed-run");
			assert.equal(payload.reclaimed, true);
			assert.equal(payload.agent, "explorer");
			assert.ok(payload.asyncDir);

			assert.deepEqual(startedRuns, ["reclaimed-run"]);
		} finally {
			if (state.poller) clearInterval(state.poller);
		}
	});

	it("does not announce terminal runs or runs from other sessions", () => {
		const root = tmpRegistry();
		seedRunningRun(root, "other-session-run", "some-other-session");

		const emitted: Array<{ channel: string; data: unknown }> = [];
		const state = createState();
		const tracker = createAsyncJobTracker(createPi(emitted) as never, state as never, { pollIntervalMs: 60_000 });
		const ctx = {
			hasUI: false,
			sessionManager: { getSessionId: () => "host-session-2" },
		};

		try {
			const added = tracker.rehydrateFromRegistry(ctx as never);
			assert.equal(added, 0);
			assert.equal(emitted.filter((e) => e.channel === SUBAGENT_ASYNC_STARTED_EVENT).length, 0);
		} finally {
			if (state.poller) clearInterval(state.poller);
		}
	});

	it("finalizes a kill+restarted zombie (dead runner identity, FRESH heartbeat) to lost on the first sweep", () => {
		const root = tmpRegistry();
		const sessionId = "host-session-3";
		const runId = "zombie-run";
		const runRecordDir = path.join(root, "runs", runId);
		fs.mkdirSync(runRecordDir, { recursive: true });
		// A process kill + quick restart leaves status.json frozen at running with a
		// heartbeat only seconds old — but the runner identity (pid+token) is dead.
		const child = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
		fs.writeFileSync(
			path.join(runRecordDir, "status.json"),
			JSON.stringify({
				runId,
				mode: "single",
				state: "running",
				startedAt: Date.now() - 5_000,
				lastUpdate: Date.now(),
				runnerHeartbeatAt: Date.now(),
				runnerPid: child.pid,
				runnerToken: "token-of-the-killed-process",
				cwd: root,
				currentStep: 0,
				steps: [{ agent: "explorer", status: "running", startedAt: Date.now() - 5_000 }],
			}),
			"utf8",
		);
		appendRunEntry({
			runId,
			runRecordDir,
			mode: "single",
			source: "async",
			agentName: "explorer",
			cwd: root,
			rootSessionId: sessionId,
			startedAt: Date.now() - 5_000,
		} as RunsRegistryEntry);

		const emitted: Array<{ channel: string; data: unknown }> = [];
		const state = createState();
		const tracker = createAsyncJobTracker(createPi(emitted) as never, state as never, { pollIntervalMs: 60_000 });
		const ctx = { hasUI: false, sessionManager: { getSessionId: () => sessionId } };

		try {
			const added = tracker.rehydrateFromRegistry(ctx as never);
			assert.equal(added, 0, "zombie must not be reclaimed into asyncJobs");
			assert.equal(emitted.filter((e) => e.channel === SUBAGENT_ASYNC_STARTED_EVENT).length, 0);
			const persisted = JSON.parse(fs.readFileSync(path.join(runRecordDir, "status.json"), "utf8")) as {
				state: string;
			};
			assert.equal(persisted.state, "lost", "first sweep must finalize the zombie to lost on disk");
		} finally {
			if (state.poller) clearInterval(state.poller);
		}
	});
});
