import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { processGlobal } from "./process-global.ts";

const CHILD_SESSION_CONTEXT_KEY = "pi-subagents.child-session-context";

type ChildSessionMessage = Parameters<AgentSession["sendCustomMessage"]>[0];
type ChildSessionMessageOptions = Parameters<AgentSession["sendCustomMessage"]>[1];

export type ChildSessionMessageDelivery = (
	message: ChildSessionMessage,
	options?: ChildSessionMessageOptions,
) => Promise<void>;

interface ChildSessionContext {
	deliverMessage?: ChildSessionMessageDelivery;
}

function childSessionContext(): AsyncLocalStorage<ChildSessionContext> {
	return processGlobal(CHILD_SESSION_CONTEXT_KEY, () => new AsyncLocalStorage<ChildSessionContext>());
}

/** Run loader/session construction in a child-scoped async context. */
export function runInChildSessionContext<T>(action: () => T, deliverMessage?: ChildSessionMessageDelivery): T {
	return childSessionContext().run({ deliverMessage }, action);
}

/** True only in the async call tree constructing an in-process child session. */
export function isInsideChildSession(): boolean {
	return childSessionContext().getStore() !== undefined;
}

/** Delivery owned by the in-process AgentSession currently being constructed. */
export function getChildSessionMessageDelivery(): ChildSessionMessageDelivery | undefined {
	return childSessionContext().getStore()?.deliverMessage;
}
