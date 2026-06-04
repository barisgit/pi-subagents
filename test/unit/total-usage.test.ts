import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compactForegroundDetails, computeDetailsTotalUsage } from "../../utils.ts";
import { tokenUsageFromTotal, tokenUsageFromUsage, totalUsageTokens } from "../../usage-totals.ts";
import type { Details, SingleResult } from "../../types.ts";

describe("computeDetailsTotalUsage", () => {
	it("returns zeroed totals for empty results", () => {
		const total = computeDetailsTotalUsage([]);
		assert.deepEqual(total, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 });
	});

	it("sums every usage field across results", () => {
		const total = computeDetailsTotalUsage([
			{ usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, cost: 0.01, turns: 2 } },
			{ usage: { input: 200, output: 100, cacheRead: 20, cacheWrite: 0, cost: 0.04, turns: 3 } },
		]);
		assert.deepEqual(total, { input: 300, output: 150, cacheRead: 30, cacheWrite: 5, cost: 0.05, turns: 5 });
	});

	it("tolerates missing fields and missing usage", () => {
		const total = computeDetailsTotalUsage([
			{ usage: { input: 10, output: 5 } },
			{ usage: undefined },
			{ /* no usage at all */ } as { usage?: undefined },
			{ usage: { input: 0, output: 0, cacheRead: 7 } },
		]);
		assert.deepEqual(total, { input: 10, output: 5, cacheRead: 7, cacheWrite: 0, cost: 0, turns: 0 });
	});
});

describe("usage token totals", () => {
	it("sums input, output, cache read, and cache write for compact token stats", () => {
		const usage = { input: 74_000, output: 2_000, cacheRead: 180_000, cacheWrite: 4_000 };

		assert.equal(totalUsageTokens(usage), 260_000);
		assert.deepEqual(tokenUsageFromUsage(usage), {
			input: 74_000,
			output: 2_000,
			cacheRead: 180_000,
			cacheWrite: 4_000,
			total: 260_000,
		});
	});
});

describe("tokenUsageFromTotal", () => {
	it("builds a total-only TokenUsage the renderer can read", () => {
		const out = tokenUsageFromTotal(745_098);
		assert.deepEqual(out, { input: 0, output: 0, total: 745_098 });
	});

	it("returns undefined for zero or missing totals so no stale step.tokens is written", () => {
		assert.equal(tokenUsageFromTotal(0), undefined);
		assert.equal(tokenUsageFromTotal(undefined), undefined);
	});
});

describe("compactForegroundDetails", () => {
	it("populates totalUsage from results[] when not pre-set", () => {
		const details: Details = {
			mode: "parallel",
			results: [
				{ agent: "a", task: "t1", exitCode: 0, messages: [], usage: { input: 50, output: 25, cacheRead: 1, cacheWrite: 0, cost: 0.001, turns: 1 } } as SingleResult,
				{ agent: "b", task: "t2", exitCode: 0, messages: [], usage: { input: 70, output: 35, cacheRead: 2, cacheWrite: 0, cost: 0.002, turns: 1 } } as SingleResult,
			],
		};
		const out = compactForegroundDetails(details);
		assert.ok(out.totalUsage);
		assert.equal(out.totalUsage?.input, 120);
		assert.equal(out.totalUsage?.output, 60);
		assert.equal(out.totalUsage?.cacheRead, 3);
	});

	it("preserves explicit totalUsage passed in", () => {
		const explicit = { input: 999, output: 999, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
		const details: Details = {
			mode: "single",
			totalUsage: explicit,
			results: [
				{ agent: "a", task: "t", exitCode: 0, messages: [], usage: { input: 1, output: 1 } } as SingleResult,
			],
		};
		const out = compactForegroundDetails(details);
		assert.deepEqual(out.totalUsage, explicit);
	});
});
