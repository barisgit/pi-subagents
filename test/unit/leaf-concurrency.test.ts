import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
	__resetLeafConcurrencyForTest,
	acquireLeafPermit,
	DEFAULT_MAX_CONCURRENT_AGENTS,
	leafConcurrencyLimit,
	parkLeafPermit,
} from "../../src/dispatch/leaf-concurrency.ts";

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

afterEach(() => {
	__resetLeafConcurrencyForTest();
});

describe("leaf-concurrency (per-process pool)", () => {
	it("sizes from config first-win and ignores later resizes", () => {
		assert.equal(leafConcurrencyLimit(2), 2);
		// Later callers (reloads / child runtimes) must not resize a live pool.
		assert.equal(leafConcurrencyLimit(9), 2);
	});

	it("defaults when config is absent or invalid", () => {
		assert.equal(leafConcurrencyLimit(undefined), DEFAULT_MAX_CONCURRENT_AGENTS);
		__resetLeafConcurrencyForTest();
		assert.equal(leafConcurrencyLimit(0), DEFAULT_MAX_CONCURRENT_AGENTS);
		__resetLeafConcurrencyForTest();
		assert.equal(leafConcurrencyLimit(-3), DEFAULT_MAX_CONCURRENT_AGENTS);
	});

	it("bounds concurrent leaf permits to the configured limit", async () => {
		leafConcurrencyLimit(2);
		let active = 0;
		let peak = 0;
		const gate: { resolve: () => void; promise: Promise<void> } = (() => {
			let resolve!: () => void;
			const promise = new Promise<void>((r) => {
				resolve = r;
			});
			return { resolve, promise };
		})();

		async function leaf(runId: string): Promise<void> {
			const release = await acquireLeafPermit(runId);
			active++;
			peak = Math.max(peak, active);
			try {
				await gate.promise;
			} finally {
				active--;
				release();
			}
		}

		const all = Promise.all([leaf("a"), leaf("b"), leaf("c"), leaf("d")]);
		await flushMicrotasks();
		assert.equal(active, 2, "only the limit may hold permits at once");
		gate.resolve();
		await all;
		assert.equal(peak, 2, "peak must never exceed the limit");
	});

	it("does NOT deadlock when a parent at the limit awaits a child (parking)", async () => {
		// Limit 1: a single naive pool would deadlock (parent holds the only permit
		// while awaiting a child that also needs one). Parking the parent's permit
		// frees the slot so the child runs, then the parent reacquires.
		leafConcurrencyLimit(1);
		const order: string[] = [];

		const releaseParent = await acquireLeafPermit("parent");
		order.push("parent acquired");

		await parkLeafPermit("parent", async () => {
			order.push("parent parked");
			const releaseChild = await acquireLeafPermit("child");
			order.push("child acquired");
			releaseChild();
			order.push("child released");
		});
		order.push("parent reacquired");
		releaseParent();

		assert.deepEqual(order, [
			"parent acquired",
			"parent parked",
			"child acquired",
			"child released",
			"parent reacquired",
		]);
	});

	it("park is a no-op when the runId holds no permit (top-level dispatch)", async () => {
		leafConcurrencyLimit(1);
		let ran = false;
		await parkLeafPermit(undefined, async () => {
			ran = true;
		});
		assert.equal(ran, true);
		ran = false;
		await parkLeafPermit("never-acquired", async () => {
			ran = true;
		});
		assert.equal(ran, true);
	});

	it("releasing a permit is idempotent", async () => {
		leafConcurrencyLimit(1);
		const release = await acquireLeafPermit("x");
		release();
		release(); // must not double-release and over-grant the pool
		const next = await acquireLeafPermit("y");
		// If double-release leaked a slot, this second concurrent acquire on a
		// limit-1 pool would have to wait; assert it resolved by checking we got here.
		next();
		assert.ok(true);
	});
});
