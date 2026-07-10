import { AsyncLocalStorage } from "node:async_hooks";
import { processGlobal } from "./process-global.ts";

const CHILD_SESSION_CONTEXT_KEY = "pi-subagents.child-session-context";

function childSessionContext(): AsyncLocalStorage<true> {
	return processGlobal(CHILD_SESSION_CONTEXT_KEY, () => new AsyncLocalStorage<true>());
}

/** Run loader/session construction in a child-scoped async context. */
export function runInChildSessionContext<T>(action: () => T): T {
	return childSessionContext().run(true, action);
}

/** True only in the async call tree constructing an in-process child session. */
export function isInsideChildSession(): boolean {
	return childSessionContext().getStore() === true;
}
