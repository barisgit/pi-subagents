export interface ConcurrencyPermit {
	release(): void;
	runWhileParked<T>(fn: () => Promise<T> | T): Promise<T>;
}

interface Waiter {
	resolve: () => void;
}

/**
 * FIFO async semaphore for globally bounding running leaf sessions.
 *
 * Fresh acquires and parked-session reacquires use the same FIFO queue. A permit
 * holder that awaits children should call runWhileParked(); it releases its
 * permit for the awaited work and queues at the tail to reacquire before
 * continuing, so blocked parents do not consume leaf capacity.
 */
export class ConcurrencySemaphore {
	private readonly maxPermits: number;
	private activePermits = 0;
	private readonly waiters: Waiter[] = [];

	constructor(maxPermits: number) {
		if (!Number.isInteger(maxPermits) || maxPermits < 1) {
			throw new RangeError("ConcurrencySemaphore maxPermits must be a positive integer");
		}
		this.maxPermits = maxPermits;
	}

	get activeCount(): number {
		return this.activePermits;
	}

	get queuedCount(): number {
		return this.waiters.length;
	}

	acquire(): Promise<ConcurrencyPermit> {
		return this.acquirePermit(this.createPermit());
	}

	private createPermit(): SemaphorePermit {
		return new SemaphorePermit(
			() => this.releasePermitSlot(),
			async (permit) => {
				await this.reacquirePermit(permit);
			},
		);
	}

	private acquirePermit(permit: SemaphorePermit): Promise<ConcurrencyPermit> {
		if (this.activePermits < this.maxPermits && this.waiters.length === 0) {
			this.activePermits++;
			permit.markHeld();
			return Promise.resolve(permit);
		}

		return new Promise((resolve) => {
			this.waiters.push({
				resolve: () => {
					permit.markHeld();
					resolve(permit);
				},
			});
		});
	}

	private releasePermitSlot(): void {
		this.activePermits--;
		this.dispatchWaiters();
	}

	private dispatchWaiters(): void {
		while (this.activePermits < this.maxPermits && this.waiters.length > 0) {
			const waiter = this.waiters.shift();
			if (!waiter) return;
			this.activePermits++;
			waiter.resolve();
		}
	}

	private async reacquirePermit(permit: SemaphorePermit): Promise<void> {
		await this.acquirePermit(permit);
	}

	static create(maxPermits: number): ConcurrencySemaphore {
		return new ConcurrencySemaphore(maxPermits);
	}
}

class SemaphorePermit implements ConcurrencyPermit {
	private readonly releaseSlot: () => void;
	private readonly reacquire: (permit: SemaphorePermit) => Promise<void>;
	private state: "pending" | "held" | "parked" | "released" = "pending";

	constructor(releaseSlot: () => void, reacquire: (permit: SemaphorePermit) => Promise<void>) {
		this.releaseSlot = releaseSlot;
		this.reacquire = reacquire;
	}

	release(): void {
		if (this.state !== "held") throw new Error(`Cannot release semaphore permit while ${this.state}`);
		this.state = "released";
		this.releaseSlot();
	}

	async runWhileParked<T>(fn: () => Promise<T> | T): Promise<T> {
		if (this.state !== "held") throw new Error(`Cannot park semaphore permit while ${this.state}`);
		this.state = "parked";
		this.releaseSlot();
		try {
			return await fn();
		} finally {
			await this.reacquire(this);
		}
	}

	markHeld(): void {
		this.state = "held";
	}
}
