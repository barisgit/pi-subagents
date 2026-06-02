import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { runWorkflowScript } from "../../workflow.ts";

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
				return { status: "ok", summary: task, result: task };
			},
			script: `
const results = await parallel([
	() => agent('explorer', 'first'),
	() => agent('explorer', 'second'),
	() => agent('explorer', 'third'),
]);
return results.map((result) => result.result);
`,
		});
		const durationMs = Date.now() - startedAt;

		assert.deepEqual(value, ["first", "second", "third"]);
		assert.equal(maxInFlight, 3);
		assert.ok(durationMs < 95, `expected concurrent runtime under serial delay sum; got ${durationMs}ms`);
	});
});
