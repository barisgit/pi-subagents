import assert from "node:assert/strict";
import * as path from "node:path";
import { describe, it } from "node:test";
import { resolveParallelTaskCwd, runParallelPath } from "../../src/dispatch/run-parallel-path.ts";
import type { ExecutionContextData, ExecutorDeps, TaskParam } from "../../src/dispatch/executor-types.ts";

function firstText(result: { content: Array<{ type: string; text?: string }> }): string {
	const entry = result.content[0];
	return entry && "text" in entry ? (entry.text ?? "") : "";
}

function makeData(overrides: Partial<ExecutionContextData>): ExecutionContextData {
	const base = {
		params: { tasks: [] },
		effectiveCwd: "/tmp/work",
		ctx: { modelRegistry: { getAvailable: () => [] }, model: undefined },
		agents: [],
		runId: "run-1",
		rootRunId: "run-1",
		artifactsDir: "/tmp/work/.artifacts",
		intercomBridge: { active: false },
	};
	return { ...base, ...overrides } as unknown as ExecutionContextData;
}

function makeDeps(): ExecutorDeps {
	return {
		config: {},
		state: { foregroundControls: new Map() },
	} as unknown as ExecutorDeps;
}

describe("resolveParallelTaskCwd precedence", () => {
	const task: TaskParam = { agent: "fixer", task: "x", cwd: "task-sub" };

	it("joins the task cwd to the top-level cwd", () => {
		assert.equal(resolveParallelTaskCwd(task, "/base"), path.resolve("/base", "task-sub"));
	});

	it("uses an absolute task cwd as an override", () => {
		assert.equal(resolveParallelTaskCwd({ ...task, cwd: "/other" }, "/base"), "/other");
	});

	it("uses task cwd alone when there is no params cwd", () => {
		assert.equal(resolveParallelTaskCwd(task, undefined), "task-sub");
	});
});

describe("runParallelPath early returns", () => {
	it("returns a Max tasks error when tasks exceed the parallel cap", async () => {
		const tasks = Array.from({ length: 9 }, (_, i) => ({ agent: "fixer", task: `t${i}` }));
		const result = await runParallelPath(makeData({ params: { tasks } }), makeDeps());
		assert.equal(result.isError, true);
		assert.equal(firstText(result), "Max 8 tasks");
		assert.equal(result.details!.mode, "parallel");
	});

	it("returns an Unknown agent error when a task agent is not registered", async () => {
		const data = makeData({ params: { tasks: [{ agent: "ghost", task: "x" }] }, agents: [] });
		const result = await runParallelPath(data, makeDeps());
		assert.equal(result.isError, true);
		assert.equal(firstText(result), "Unknown agent: ghost");
		assert.equal(result.details!.mode, "parallel");
	});
});
