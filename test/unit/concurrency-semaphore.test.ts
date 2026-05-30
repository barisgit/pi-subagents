import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConcurrencySemaphore, type ConcurrencyPermit } from "../../concurrency-semaphore.ts";

interface Deferred<T = void> {
	promise: Promise<T>;
	resolve: (value: T | PromiseLike<T>) => void;
	reject: (error: unknown) => void;
}

function deferred<T = void>(): Deferred<T> {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

describe("ConcurrencySemaphore", () => {
	it("leaf sessions count; parent awaiting children releases permit", async () => {
		const leafSemaphore = new ConcurrencySemaphore(2);
		const order: string[] = [];

		const firstLeaf = await leafSemaphore.acquire();
		order.push("first leaf acquired");
		const secondLeaf = await leafSemaphore.acquire();
		order.push("second leaf acquired");

		let thirdLeaf: ConcurrencyPermit | undefined;
		const thirdAcquire = leafSemaphore.acquire().then((permit) => {
			thirdLeaf = permit;
			order.push("third leaf acquired");
		});
		await flushMicrotasks();

		assert.deepEqual(order, ["first leaf acquired", "second leaf acquired"]);
		assert.equal(leafSemaphore.activeCount, 2);
		assert.equal(leafSemaphore.queuedCount, 1);

		firstLeaf.release();
		await thirdAcquire;

		assert.deepEqual(order, ["first leaf acquired", "second leaf acquired", "third leaf acquired"]);
		assert.equal(leafSemaphore.activeCount, 2);

		secondLeaf.release();
		thirdLeaf?.release();
		assert.equal(leafSemaphore.activeCount, 0);

		const deadlockSemaphore = new ConcurrencySemaphore(2);
		const blockedParentA = await deadlockSemaphore.acquire();
		const blockedParentB = await deadlockSemaphore.acquire();
		let childWithoutParkingAcquired = false;
		const blockedChild = deadlockSemaphore.acquire().then((permit) => {
			childWithoutParkingAcquired = true;
			permit.release();
		});
		await flushMicrotasks();

		assert.equal(childWithoutParkingAcquired, false);
		assert.equal(deadlockSemaphore.activeCount, 2);
		assert.equal(deadlockSemaphore.queuedCount, 1);

		blockedParentA.release();
		await blockedChild;
		blockedParentB.release();

		const nestedSemaphore = new ConcurrencySemaphore(2);
		const parentA = await nestedSemaphore.acquire();
		const parentB = await nestedSemaphore.acquire();
		const childAGate = deferred();
		const childBGate = deferred();
		const nestedOrder: string[] = [];
		let runningChildren = 0;
		let maxRunningChildren = 0;
		let maxObservedPermits = nestedSemaphore.activeCount;

		function recordPermits(): void {
			maxObservedPermits = Math.max(maxObservedPermits, nestedSemaphore.activeCount);
		}

		async function runParent(name: string, parentPermit: ConcurrencyPermit, childGate: Deferred): Promise<void> {
			await parentPermit.runWhileParked(async () => {
				nestedOrder.push(`${name} parked`);
				recordPermits();
				const childPermit = await nestedSemaphore.acquire();
				runningChildren++;
				maxRunningChildren = Math.max(maxRunningChildren, runningChildren);
				recordPermits();
				nestedOrder.push(`${name} child acquired`);
				await childGate.promise;
				runningChildren--;
				childPermit.release();
				recordPermits();
				nestedOrder.push(`${name} child released`);
			});
			recordPermits();
			nestedOrder.push(`${name} parent reacquired`);
			parentPermit.release();
			recordPermits();
			nestedOrder.push(`${name} parent released`);
		}

		const parentRuns = Promise.all([
			runParent("parent A", parentA, childAGate),
			runParent("parent B", parentB, childBGate),
		]);
		await flushMicrotasks();

		assert.deepEqual(nestedOrder, [
			"parent A parked",
			"parent B parked",
			"parent A child acquired",
			"parent B child acquired",
		]);
		assert.equal(runningChildren, 2);
		assert.equal(maxRunningChildren, 2);
		assert.equal(maxObservedPermits, 2);

		childAGate.resolve();
		childBGate.resolve();
		await parentRuns;

		assert.equal(nestedSemaphore.activeCount, 0);
		assert.equal(maxRunningChildren, 2);
		assert.equal(maxObservedPermits, 2);
		assert.deepEqual(nestedOrder, [
			"parent A parked",
			"parent B parked",
			"parent A child acquired",
			"parent B child acquired",
			"parent A child released",
			"parent B child released",
			"parent A parent reacquired",
			"parent A parent released",
			"parent B parent reacquired",
			"parent B parent released",
		]);
	});
});
