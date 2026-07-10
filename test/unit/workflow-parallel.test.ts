import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { runWorkflowScript } from "../../src/workflow/workflow.ts";

const delays: Record<string, number> = { first: 60, second: 10, third: 30 };

describe("workflow parallel global (VAL-PARALLEL)", () => {
	it("runs thunks concurrently and returns results in input order", async () => {
		let inFlight = 0;
		let maxInFlight = 0;
		const startedAt = Date.now();
		const value = await runWorkflowScript({
			dispatch: async (_role, task) => {
				inFlight += 1;
				maxInFlight = Math.max(maxInFlight, inFlight);
				await delay(delays[task] ?? 0);
				inFlight -= 1;
				return { result: task };
			},
			script: `
const results = await parallel([
	() => agent('explorer', 'first'),
	() => agent('explorer', 'second'),
	() => agent('explorer', 'third'),
]);
return results;
`,
		});
		const durationMs = Date.now() - startedAt;

		assert.deepEqual(value, ["first", "second", "third"]);
		assert.equal(maxInFlight, 3);
		assert.ok(durationMs < 95, `expected concurrent runtime under serial delay sum; got ${durationMs}ms`);
	});

	it("reaps a parallel group only after every member settles, even when one fails fast", async () => {
		// Reviewer repro: a fail-fast group must NOT reap (onParallelGroupSettled)
		// when the script-facing Promise.all rejects on the first failure — a slower
		// sibling that calls agent() late must still have its dispatch resolve
		// (and, in the tool, its childStarted fire) before the pending slot is reaped.
		const events: string[] = [];
		await runWorkflowScript({
			onParallelGroupSettled: () => events.push("reaped"),
			dispatch: async (_role, task) => {
				if (task === "fail") {
					events.push("dispatch:fail");
					return { isError: true, exitCode: 1, error: "boom" };
				}
				events.push("dispatch:slow:start");
				await delay(40);
				events.push("dispatch:slow:end");
				return { result: task };
			},
			script: `
try {
	await parallel([
		() => agent('explorer', 'fail'),
		() => agent('explorer', 'slow'),
	]);
} catch (error) {
	// expected: the fast failure surfaces; the slow sibling must still settle.
}
`,
		});

		// The reaper must fire only after the slow sibling's dispatch resolved — never
		// in the window between the fast failure and the slow sibling settling.
		const reapedAt = events.indexOf("reaped");
		const slowEndAt = events.indexOf("dispatch:slow:end");
		assert.ok(reapedAt !== -1, "group must be reaped");
		assert.ok(slowEndAt !== -1, "slow sibling must fully settle");
		assert.ok(
			reapedAt > slowEndAt,
			`reaper fired before the slow sibling settled (premature reap): ${events.join(" -> ")}`,
		);
	});

	it("ignores a hostile poisoned thunks.map and still dispatches every member", async () => {
		// Reviewer repro: a script that poisons the array's own .map to throw AFTER
		// invoking the first thunk would (with a script-driven .map) strand a reserved
		// pending slot and skip later members. parallel() must build memberPromises
		// with a HOST-OWNED loop, so a poisoned .map has no effect: every member still
		// dispatches exactly once.
		const dispatched: string[] = [];
		const value = await runWorkflowScript({
			dispatch: async (_role, task) => {
				dispatched.push(task);
				return { result: task };
			},
			script: `
const xs = [() => agent('explorer', 'alpha'), () => agent('explorer', 'beta')];
xs.map = (cb) => { cb(xs[0], 0, xs); throw new Error('map boom'); };
await parallel(xs);
return 'ok';
`,
		});

		assert.equal(value, "ok");
		assert.deepEqual(dispatched.slice().sort(), ["alpha", "beta"]);
	});

	it("assimilates a custom thenable member exactly once (no double dispatch)", async () => {
		// Reviewer repro: sharing the raw thunk return value between Promise.all and
		// Promise.allSettled lets BOTH call a custom thenable's .then — dispatching the
		// agent twice, untagged, outside the ALS group. Normalizing each member with
		// Promise.resolve(...) inside the store assimilates the thenable once.
		const dispatched: string[] = [];
		const value = await runWorkflowScript({
			dispatch: async (_role, task) => {
				dispatched.push(task);
				return { result: task };
			},
			script: `
let thenCalls = 0;
const thenable = {
	then(resolve) {
		thenCalls += 1;
		resolve(agent('explorer', 'thenable-' + thenCalls));
	},
};
await parallel([() => thenable, () => agent('explorer', 'plain')]);
return 'ok';
`,
		});

		assert.equal(value, "ok");
		// Exactly one thenable dispatch ("thenable-1") — never a second ("thenable-2").
		assert.ok(dispatched.includes("thenable-1"), `expected one thenable dispatch; got ${dispatched.join(", ")}`);
		assert.ok(!dispatched.includes("thenable-2"), `thenable dispatched twice: ${dispatched.join(", ")}`);
	});
});
