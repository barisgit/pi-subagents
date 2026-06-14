import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	buildParallelWorktreeSuffix,
	createParallelWorktreeSetup,
	resolveParallelTaskCwd,
	runParallelPath,
} from "../../src/dispatch/run-parallel-path.ts";
import type { WorktreeSetup } from "../../src/dispatch/worktree.ts";
import type { ExecutionContextData, ExecutorDeps, TaskParam } from "../../src/dispatch/subagent-executor.ts";

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

	it("prefers the worktree agentCwd above all else", () => {
		const setup = { worktrees: [{ agentCwd: "/wt/agent-0" }] } as unknown as WorktreeSetup;
		assert.equal(resolveParallelTaskCwd(task, "/base", setup, 0), "/wt/agent-0");
	});

	it("falls back to params cwd joined with task cwd when no worktree", () => {
		assert.equal(resolveParallelTaskCwd(task, "/base", undefined, 0), "/base/task-sub");
	});

	it("uses task cwd alone when there is no params cwd", () => {
		assert.equal(resolveParallelTaskCwd(task, undefined, undefined, 0), "task-sub");
	});
});

describe("createParallelWorktreeSetup", () => {
	const tasks: TaskParam[] = [{ agent: "fixer", task: "x" }];

	it("returns {} when worktrees are disabled", () => {
		const result = createParallelWorktreeSetup(false, "/base", "run-1", tasks, undefined, undefined);
		assert.deepEqual(result, {});
	});

	it("returns an errorResult when worktree creation throws", () => {
		// /nonexistent-base is not a git repo, so createWorktrees throws and is caught.
		const result = createParallelWorktreeSetup(true, "/nonexistent-base-xyz", "run-1", tasks, undefined, undefined);
		assert.ok(result.errorResult);
		assert.equal(result.errorResult!.isError, true);
		assert.equal(result.setup, undefined);
	});
});

describe("buildParallelWorktreeSuffix", () => {
	it("returns an empty string when there is no worktree setup", () => {
		assert.equal(buildParallelWorktreeSuffix(undefined, "/tmp/work/.artifacts", []), "");
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
