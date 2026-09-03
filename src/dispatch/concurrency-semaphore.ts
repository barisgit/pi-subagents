export interface ConcurrencyPermit {
	release(): void;
	runWhileParked<T>(fn: () => Promise<T> | T, signal?: AbortSignal): Promise<T>;
}

interface Waiter {
	resolve: () => void;
	removeAbortListener: () => void;
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
	private maxPermits: number;
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

	get limit(): number {
		return this.maxPermits;
	}

	/**
	 * Change the permit ceiling live. Growing wakes queued waiters up to the new
	 * limit; shrinking only lowers the ceiling — already-active permits are never
	 * revoked, so the count drains below the new limit as they release (no waiter
	 * is dispatched while activePermits >= maxPermits). Lets config changes take
	 * effect on reload without recreating the process-wide pool.
	 */
	resize(maxPermits: number): void {
		if (!Number.isInteger(maxPermits) || maxPermits < 1) {
			throw new RangeError("ConcurrencySemaphore maxPermits must be a positive integer");
		}
		this.maxPermits = maxPermits;
		this.dispatchWaiters();
	}

	acquire(): Promise<ConcurrencyPermit>;
	acquire(signal: AbortSignal): Promise<ConcurrencyPermit | undefined>;
	acquire(signal?: AbortSignal): Promise<ConcurrencyPermit | undefined> {
		const permit = this.createPermit();
		return signal ? this.acquirePermit(permit, signal) : this.acquirePermit(permit);
	}

	private createPermit(): SemaphorePermit {
		return new SemaphorePermit(
			() => this.releasePermitSlot(),
			(permit, signal) => this.reacquirePermit(permit, signal),
		);
	}

	private acquirePermit(permit: SemaphorePermit): Promise<ConcurrencyPermit>;
	private acquirePermit(permit: SemaphorePermit, signal: AbortSignal): Promise<ConcurrencyPermit | undefined>;
	private acquirePermit(permit: SemaphorePermit, signal?: AbortSignal): Promise<ConcurrencyPermit | undefined> {
		if (signal?.aborted) return Promise.resolve(undefined);
		if (this.activePermits < this.maxPermits && this.waiters.length === 0) {
			this.activePermits++;
			permit.markHeld();
			return Promise.resolve(permit);
		}

		return new Promise((resolve) => {
			const waiter: Waiter = {
				removeAbortListener: () => {},
				resolve: () => {
					waiter.removeAbortListener();
					permit.markHeld();
					resolve(permit);
				},
			};
			this.waiters.push(waiter);
			if (signal) {
				const onAbort = () => {
					const index = this.waiters.indexOf(waiter);
					if (index < 0) return;
					this.waiters.splice(index, 1);
					signal.removeEventListener("abort", onAbort);
					resolve(undefined);
				};
				waiter.removeAbortListener = () => signal.removeEventListener("abort", onAbort);
				signal.addEventListener("abort", onAbort, { once: true });
			}
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

	private async reacquirePermit(permit: SemaphorePermit, signal?: AbortSignal): Promise<boolean> {
		if (signal) return (await this.acquirePermit(permit, signal)) !== undefined;
		await this.acquirePermit(permit);
		return true;
	}

	static create(maxPermits: number): ConcurrencySemaphore {
		return new ConcurrencySemaphore(maxPermits);
	}
}

class SemaphorePermit implements ConcurrencyPermit {
	private readonly releaseSlot: () => void;
	private readonly reacquire: (permit: SemaphorePermit, signal?: AbortSignal) => Promise<boolean>;
	private state: "pending" | "held" | "parked" | "cancelled" | "released" = "pending";

	constructor(
		releaseSlot: () => void,
		reacquire: (permit: SemaphorePermit, signal?: AbortSignal) => Promise<boolean>,
	) {
		this.releaseSlot = releaseSlot;
		this.reacquire = reacquire;
	}

	release(): void {
		if (this.state === "cancelled") {
			this.state = "released";
			return;
		}
		if (this.state !== "held") throw new Error(`Cannot release semaphore permit while ${this.state}`);
		this.state = "released";
		this.releaseSlot();
	}

	async runWhileParked<T>(fn: () => Promise<T> | T, signal?: AbortSignal): Promise<T> {
		if (this.state !== "held") throw new Error(`Cannot park semaphore permit while ${this.state}`);
		this.state = "parked";
		this.releaseSlot();
		try {
			return await fn();
		} finally {
			if (!(await this.reacquire(this, signal))) this.state = "cancelled";
		}
	}

	markHeld(): void {
		this.state = "held";
	}
}
