import { processGlobal } from "../shared/process-global.ts";

interface ParentState {
	activeAsyncIds: Set<string>;
	agentInFlight: boolean;
	pendingReprompts: Array<() => boolean>;
	version: number;
	waiters: Set<() => void>;
	cancelDescendants: Set<() => void>;
}

/** Keep a nested parent live until its aggregate completion notification is enqueued. */
export function holdNestedAsyncRollup(parentRunId: string, groupRunId: string): void {
	markNestedAsyncStarted(parentRunId, groupRunId);
}

export function registerNestedAsyncCancellation(parentRunId: string, cancel: () => void): () => void {
	const state = stateFor(parentRunId);
	state.cancelDescendants.add(cancel);
	return () => state.cancelDescendants.delete(cancel);
}

interface NestedAsyncRegistry {
	parents: Map<string, ParentState>;
}

const REGISTRY_KEY = "pi.subagents.nestedAsyncParents";

function registry(): NestedAsyncRegistry {
	return processGlobal<NestedAsyncRegistry>(REGISTRY_KEY, () => ({ parents: new Map() }));
}

function stateFor(runId: string): ParentState {
	let state = registry().parents.get(runId);
	if (!state) {
		state = {
			activeAsyncIds: new Set(),
			agentInFlight: false,
			pendingReprompts: [],
			version: 0,
			waiters: new Set(),
			cancelDescendants: new Set(),
		};
		registry().parents.set(runId, state);
	}
	return state;
}

function changed(state: ParentState): void {
	state.version++;
	for (const resolve of state.waiters) resolve();
	state.waiters.clear();
}

export function registerNestedAsyncParent(runId: string): void {
	stateFor(runId);
}

export function markNestedAsyncStarted(parentRunId: string, childRunId: string): void {
	const state = stateFor(parentRunId);
	state.activeAsyncIds.add(childRunId);
	changed(state);
}

export function markNestedAsyncFinished(parentRunId: string, childRunId: string): void {
	const state = stateFor(parentRunId);
	state.activeAsyncIds.delete(childRunId);
	changed(state);
}

export function markNestedParentTurn(parentRunId: string, inFlight: boolean): void {
	const state = stateFor(parentRunId);
	state.agentInFlight = inFlight;
	changed(state);
}

export function enqueueNestedCompletionReprompt(parentRunId: string, send: () => boolean): void {
	const state = stateFor(parentRunId);
	state.pendingReprompts.push(send);
	changed(state);
}

export function nestedAsyncParentSnapshot(parentRunId: string): {
	active: boolean;
	agentInFlight: boolean;
	pendingReprompts: number;
	version: number;
} | null {
	const state = registry().parents.get(parentRunId);
	if (!state) return null;
	return {
		active: state.activeAsyncIds.size > 0,
		agentInFlight: state.agentInFlight,
		pendingReprompts: state.pendingReprompts.length,
		version: state.version,
	};
}

export function flushNestedCompletionReprompts(parentRunId: string): void {
	const state = registry().parents.get(parentRunId);
	if (!state || state.pendingReprompts.length === 0) return;
	const sends = state.pendingReprompts.splice(0, state.pendingReprompts.length);
	let queued = false;
	for (const send of sends) {
		try {
			queued = send() || queued;
		} catch {
			// A failed delivery must not leave speculative parent activity behind.
		}
	}
	state.agentInFlight = queued;
	changed(state);
}

export function waitForNestedAsyncParentChange(
	parentRunId: string,
	version: number,
	signal: AbortSignal,
): Promise<void> {
	const state = stateFor(parentRunId);
	if (state.version !== version || signal.aborted) return Promise.resolve();
	return new Promise((resolve) => {
		const done = () => {
			signal.removeEventListener("abort", done);
			state.waiters.delete(done);
			resolve();
		};
		state.waiters.add(done);
		signal.addEventListener("abort", done, { once: true });
	});
}

export function releaseNestedAsyncParent(parentRunId: string): void {
	const state = registry().parents.get(parentRunId);
	if (!state) return;
	for (const resolve of state.waiters) resolve();
	state.waiters.clear();
	state.pendingReprompts.length = 0;
	for (const cancel of state.cancelDescendants) cancel();
	state.cancelDescendants.clear();
	registry().parents.delete(parentRunId);
}
