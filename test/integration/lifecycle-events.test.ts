import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { createMockPi, createTempDir, removeTempDir, tryImport } from "../support/helpers.ts";
import type { MockPi } from "../support/helpers.ts";
import { createResultWatcher } from "../../result-watcher.ts";
import {
	SUBAGENT_ASYNC_COMPLETE_EVENT,
	SUBAGENT_COMPLETED_EVENT,
	SUBAGENT_FAILED_EVENT,
	SUBAGENT_SPAWN_STARTED_EVENT,
} from "../../types.ts";

interface ExecutorModule {
	createSubagentExecutor?: (...args: unknown[]) => {
		execute: (
			id: string,
			params: Record<string, unknown>,
			signal: AbortSignal,
			onUpdate: undefined,
			ctx: Record<string, unknown>,
		) => Promise<{ isError?: boolean }>;
	};
}

const executorMod = await tryImport<ExecutorModule>("./subagent-executor.ts");
const available = !!executorMod?.createSubagentExecutor;
const createSubagentExecutor = executorMod?.createSubagentExecutor;

function makeState(cwd: string) {
	return {
		baseCwd: cwd,
		currentSessionId: null as string | null,
		asyncJobs: new Map(),
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: { schedule: () => false, clear: () => {} },
	};
}

function makeCtx(cwd: string) {
	return {
		cwd,
		hasUI: false,
		ui: {},
		sessionManager: {
			getSessionId: () => "session-123",
			getSessionFile: () => null,
		},
		modelRegistry: { getAvailable: () => [] },
	};
}

describe("subagent lifecycle events", { skip: !available ? "subagent executor not importable" : undefined }, () => {
	let tempDir: string;
	let mockPi: MockPi;

	before(() => {
		mockPi = createMockPi();
		mockPi.install();
	});

	after(() => {
		mockPi.uninstall();
	});

	beforeEach(() => {
		tempDir = createTempDir();
		mockPi.reset();
	});

	afterEach(() => {
		removeTempDir(tempDir);
	});

	function makeExecutor(events: EventEmitter) {
		const piEvents = {
			emit: (event: string, payload: unknown) => events.emit(event, payload),
			on: (event: string, listener: (...args: unknown[]) => void) => {
				events.on(event, listener);
				return () => events.off(event, listener);
			},
		};
		return createSubagentExecutor!({
			pi: {
				events: piEvents,
				getSessionName: () => undefined,
				setSessionName: () => {},
			},
			state: makeState(tempDir),
			config: {},
			asyncByDefault: false,
			tempArtifactsDir: tempDir,
			getSubagentSessionRoot: () => tempDir,
			expandTilde: (value: string) => value,
			discoverAgents: () => ({ agents: [{ name: "worker", description: "Worker" }] }),
		});
	}

	it("emits sync started and completed events with opaque metadata", async () => {
		mockPi.onCall({ output: "done" });
		const events = new EventEmitter();
		const observed: Array<{ event: string; payload: Record<string, unknown> }> = [];
		events.on(SUBAGENT_SPAWN_STARTED_EVENT, (payload) => observed.push({ event: SUBAGENT_SPAWN_STARTED_EVENT, payload }));
		events.on(SUBAGENT_COMPLETED_EVENT, (payload) => observed.push({ event: SUBAGENT_COMPLETED_EVENT, payload }));
		const metadata = { "test.traceId": "trace-1" };

		const result = await makeExecutor(events).execute(
			"subagent",
			{ agent: "worker", task: "Say done", metadata },
			new AbortController().signal,
			undefined,
			makeCtx(tempDir),
		);

		assert.equal(result.isError, undefined);
		assert.equal(observed.length, 2);
		assert.equal(observed[0]!.event, SUBAGENT_SPAWN_STARTED_EVENT);
		assert.equal(observed[1]!.event, SUBAGENT_COMPLETED_EVENT);
		assert.equal(observed[0]!.payload.metadata, metadata);
		assert.equal(observed[1]!.payload.metadata, metadata);
		assert.equal(observed[0]!.payload.agent, "worker");
		assert.equal(observed[1]!.payload.exitCode, 0);
	});

	it("emits sync failed event with metadata", async () => {
		mockPi.onCall({ exitCode: 1, stderr: "boom" });
		const events = new EventEmitter();
		const failed: Record<string, unknown>[] = [];
		events.on(SUBAGENT_FAILED_EVENT, (payload) => failed.push(payload));
		const metadata = { "test.traceId": "trace-2" };

		const result = await makeExecutor(events).execute(
			"subagent",
			{ agent: "worker", task: "Fail", metadata },
			new AbortController().signal,
			undefined,
			makeCtx(tempDir),
		);

		assert.equal(result.isError, true);
		assert.equal(failed.length, 1);
		assert.equal(failed[0]!.metadata, metadata);
		assert.equal(failed[0]!.exitCode, 1);
		assert.match(String(failed[0]!.error), /boom/);
	});

	it("emits async completion result metadata verbatim", async () => {
		const metadata = { "test.traceId": "async-trace" };
		const resultsDir = path.join(tempDir, "results");
		fs.mkdirSync(resultsDir, { recursive: true });
		fs.writeFileSync(
			path.join(resultsDir, "async-1.json"),
			JSON.stringify({ id: "async-1", agent: "worker", sessionId: "session-123", metadata }),
			"utf-8",
		);
		const events = new EventEmitter();
		const completed: Record<string, unknown>[] = [];
		events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, (payload) => completed.push(payload));
		const state = makeState(tempDir);
		state.currentSessionId = "session-123";
		const watcher = createResultWatcher({ events } as never, state as never, resultsDir, 1000);

		watcher.primeExistingResults();
		await new Promise((resolve) => setTimeout(resolve, 25));
		watcher.stopResultWatcher();

		assert.equal(completed.length, 1);
		assert.deepEqual(completed[0]!.metadata, metadata);
	});
});
