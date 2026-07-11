import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { childCompletionRunId, runAsyncPath } from "../../src/dispatch/run-async-path.ts";
import type { ExecutionContextData, ExecutorDeps } from "../../src/dispatch/executor-types.ts";

function makeData(overrides: Partial<ExecutionContextData>): ExecutionContextData {
	const base = {
		params: {},
		effectiveCwd: "/tmp/work",
		ctx: { modelRegistry: { getAvailable: () => [] } },
		agents: [],
		runId: "run-1",
		rootRunId: "run-1",
		effectiveAsync: true,
		controlConfig: undefined,
	};
	return { ...base, ...overrides } as unknown as ExecutionContextData;
}

function makeDeps(): ExecutorDeps {
	return { config: {} } as unknown as ExecutorDeps;
}

function firstText(result: { content: Array<{ type: string; text?: string }> }): string {
	const entry = result.content[0];
	return entry && "text" in entry ? (entry.text ?? "") : "";
}

describe("childCompletionRunId", () => {
	it("appends the step index when total > 1", () => {
		assert.equal(childCompletionRunId("disp", 2, 3), "disp:2");
	});

	it("returns the dispatch runId unchanged when total === 1", () => {
		assert.equal(childCompletionRunId("disp", 0, 1), "disp");
	});
});

describe("runAsyncPath early returns", () => {
	it("returns null when effectiveAsync is false (router fall-through)", () => {
		const data = makeData({ effectiveAsync: false, params: { agent: "fixer", task: "x" } });
		assert.equal(runAsyncPath(data, makeDeps()), null);
	});

	it("returns an Unknown agent error (single) when the agent is not registered", () => {
		const data = makeData({ params: { agent: "ghost", task: "x" }, agents: [] });
		const result = runAsyncPath(data, makeDeps());
		assert.ok(result);
		assert.equal(result!.isError, true);
		assert.equal(firstText(result!), "Unknown agent: ghost");
		assert.equal(result!.details!.mode, "single");
		assert.deepEqual(result!.details!.results, []);
	});

	it("returns an Unknown agent error (parallel) when a task agent is not registered", () => {
		const data = makeData({ params: { tasks: [{ agent: "ghost", task: "x" }] }, agents: [] });
		const result = runAsyncPath(data, makeDeps());
		assert.ok(result);
		assert.equal(result!.isError, true);
		assert.equal(firstText(result!), "Unknown agent: ghost");
		assert.equal(result!.details!.mode, "parallel");
	});

	it("returns a Max tasks error when tasks exceed the parallel cap", () => {
		const tasks = Array.from({ length: 9 }, (_, i) => ({ agent: "fixer", task: `t${i}` }));
		const data = makeData({ params: { tasks } });
		const result = runAsyncPath(data, makeDeps());
		assert.ok(result);
		assert.equal(result!.isError, true);
		assert.equal(firstText(result!), "Max 8 tasks");
		assert.equal(result!.details!.mode, "parallel");
	});
});
