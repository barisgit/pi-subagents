import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { describe, it } from "node:test";
import {
	appendTokenSample,
	childResultToSingleResult,
	combineOptionalSignals,
	createProgressUpdateCoalescer,
} from "../../src/dispatch/child-step-runner.ts";

describe("appendTokenSample", () => {
	it("keeps only the latest 120 samples", () => {
		const samples: Array<{ ts: number; tokens: number }> = [];
		for (let index = 0; index < 150; index++) {
			appendTokenSample(samples, { ts: index, tokens: index * 10 });
		}

		assert.equal(samples.length, 120);
		assert.deepEqual(samples[0], { ts: 30, tokens: 300 });
		assert.deepEqual(samples.at(-1), { ts: 149, tokens: 1490 });
	});
});

describe("createProgressUpdateCoalescer", () => {
	it("bounds a burst to leading and trailing updates", () => {
		let callback: (() => void) | undefined;
		let emits = 0;
		const coalescer = createProgressUpdateCoalescer({
			emit: () => emits++,
			setTimeoutFn: (next) => {
				callback = next;
				return 1 as never;
			},
			clearTimeoutFn: () => {
				callback = undefined;
			},
		});

		coalescer.request();
		coalescer.request();
		coalescer.request();
		assert.equal(emits, 1);
		callback?.();
		assert.equal(emits, 2);
	});

	it("flushes once and prevents callbacks after settlement", () => {
		let callback: (() => void) | undefined;
		let emits = 0;
		const coalescer = createProgressUpdateCoalescer({
			emit: () => emits++,
			setTimeoutFn: (next) => {
				callback = next;
				return 1 as never;
			},
			clearTimeoutFn: () => {},
		});

		coalescer.request();
		coalescer.request();
		const lateCallback = callback;
		coalescer.stop();
		assert.equal(emits, 2);
		lateCallback?.();
		coalescer.request();
		assert.equal(emits, 2);
	});
});

describe("combineOptionalSignals", () => {
	it("removes listeners from the remaining signals after one aborts", () => {
		const first = new AbortController();
		const second = new AbortController();

		const combined = combineOptionalSignals(first.signal, second.signal);
		assert.equal(getEventListeners(second.signal, "abort").length, 1);
		first.abort("stop");

		assert.equal(combined.signal.aborted, true);
		assert.equal(combined.signal.reason, "stop");
		assert.equal(getEventListeners(second.signal, "abort").length, 0);
	});

	it("dispose removes listeners from all source signals without aborting", () => {
		const first = new AbortController();
		const second = new AbortController();

		const combined = combineOptionalSignals(first.signal, second.signal);
		assert.equal(getEventListeners(first.signal, "abort").length, 1);
		assert.equal(getEventListeners(second.signal, "abort").length, 1);
		combined.dispose();

		assert.equal(getEventListeners(first.signal, "abort").length, 0);
		assert.equal(getEventListeners(second.signal, "abort").length, 0);
		assert.equal(combined.signal.aborted, false);
		first.abort("late");
		assert.equal(combined.signal.aborted, false);
	});
});

describe("childResultToSingleResult", () => {
	it("preserves reported zero duration and tool count", () => {
		const progress = {
			agent: "test-agent",
			status: "running" as const,
			task: "test task",
			recentTools: [],
			recentOutput: [],
			toolCount: 3,
			tokens: 0,
			durationMs: 25,
		};
		const result = childResultToSingleResult(
			{
				runId: "run-1",
				stepIndex: 0,
				state: "complete",
				exitCode: 0,
				outputText: "done",
				toolCallCount: 0,
				toolResultCount: 0,
				toolErrorCount: 0,
				durationMs: 0,
				startedAt: 0,
				endedAt: 0,
				sessionFile: "session.jsonl",
			},
			{
				resultShell: {
					agent: "test-agent",
					task: "test task",
					exitCode: 0,
					usage: { input: 0, output: 0 },
				},
				progress,
				startedAt: Date.now() - 100,
				artifactConfig: {
					enabled: false,
					includeInput: false,
					includeOutput: false,
					includeJsonl: false,
					includeMetadata: false,
					cleanupDays: 0,
				},
			},
		);

		assert.equal(result.progressSummary?.durationMs, 0);
		assert.equal(result.progressSummary?.toolCount, 0);
	});
});
