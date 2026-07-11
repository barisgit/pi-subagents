// Process-wide holder for the live `pi` (ExtensionAPI) of the current activate.
//
// Why this exists despite looking like a service-locator:
//   The SDK invalidates the previous `pi` on ctx.reload/newSession/fork/
//   switchSession ("ctx is stale after session replacement"). Any handler that
//   captured the old `pi` and calls an action method (sendMessage, etc.) will
//   throw. Long-lived in-process executor closures + lifecycle handlers may
//   fire after the next activate has replaced `pi`, so they cannot use the
//   pi captured at registration time.
//
// Scope is intentionally narrow: ONLY action-method call sites (sendMessage,
// safeEmit on pi.events, etc.) that may run across an activate boundary reach
// for this. Event subscriptions stay on pi.events and are re-attached every
// host activate. Per-activate state stays in closures. The holder is pinned
// on globalThis so it survives module re-imports the extension runtime
// performs on each activate.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { logger } from "./logger.ts";

const STORE_KEY = "__piSubagentCurrentPi";
type Store = { pi?: ExtensionAPI; piId?: string; setAt?: number; setCount?: number };

function store(): Store {
	const g = globalThis as Record<string, unknown>;
	let s = g[STORE_KEY] as Store | undefined;
	if (!s) {
		s = { setCount: 0 };
		g[STORE_KEY] = s;
	}
	return s;
}

function tagPi(pi: ExtensionAPI): string {
	const p = pi as unknown as { __piId?: string };
	if (!p.__piId) {
		p.__piId = `pi-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
	}
	return p.__piId;
}

export function setCurrentPi(pi: ExtensionAPI): void {
	const s = store();
	s.pi = pi;
	s.piId = tagPi(pi);
	s.setAt = Date.now();
	s.setCount = (s.setCount ?? 0) + 1;
}

export function getCurrentPi(): ExtensionAPI {
	const s = store();
	const pi = s.pi;
	if (!pi) {
		logger.error("getCurrentPi() called before setCurrentPi()", new Error("no pinned pi"));
		throw new Error("pi-subagents: getCurrentPi() called before setCurrentPi()");
	}
	return pi;
}
