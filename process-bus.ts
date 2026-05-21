// Process-wide in-memory event bus for pi-subagents.
//
// Why not `pi.events`?
//   The SDK's EventBus is tied to an AgentSession. Across ctx.reload(),
//   ctx.newSession(), ctx.fork(), or ctx.switchSession() the old `pi` and its
//   EventBus go stale: emits land on a bus with zero listeners (the in-process
//   executor's long-lived closures captured the old pi), and using the old pi
//   from a fired handler throws "ctx is stale after session replacement".
//
// Our async lifecycle events (started/complete) outlive any single agent
// session: the in-process executor keeps running across reloads, and the
// widget/notify wiring should always see them. So they belong on a bus we
// own, scoped to the node process and pinned on globalThis so it survives
// module re-imports performed by the extension runtime on each activate.
//
// This bus also gives us a natural channel for future cross-agent messaging.

import { EventEmitter } from "node:events";

const STORE_KEY = "__pi_subagents_process_bus__";

interface Store {
	bus?: EventEmitter;
}

function getStore(): Store {
	const g = globalThis as Record<string, unknown>;
	let s = g[STORE_KEY] as Store | undefined;
	if (!s) {
		s = {};
		g[STORE_KEY] = s;
	}
	return s;
}

export function getProcessBus(): EventEmitter {
	const store = getStore();
	if (!store.bus) {
		const bus = new EventEmitter();
		bus.setMaxListeners(0);
		store.bus = bus;
	}
	return store.bus;
}

/** Subscribe to a channel; returns an unsubscribe function. */
export function onProcessBus(channel: string, handler: (data: unknown) => void): () => void {
	const bus = getProcessBus();
	bus.on(channel, handler);
	return () => bus.off(channel, handler);
}

export function emitProcessBus(channel: string, data: unknown): void {
	getProcessBus().emit(channel, data);
}
