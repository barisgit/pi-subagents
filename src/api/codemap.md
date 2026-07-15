# src/api/

## Responsibility
Frozen cross-extension public API boundary for pi-subagents. It publishes a session-scoped `SubagentExposedAPI` and lineage events so sibling extensions can list agents, spawn raw host subagents, and identify whether they are running in a host or child session.

- `exposed-subagent-api.ts` — emits `SUBAGENT_EXPOSE_API_EVENT` / `SUBAGENT_LINEAGE_EVENT`, implements host `spawnRaw`/`list`/`lineage`, and child-session stub API plus lineage claiming.

## Design
The API surface is event-published rather than imported directly by consumers. `createHostSubagentApi()` builds a stable `SubagentExposedAPI` object for root sessions with raw spawning, discovery, usage, lineage, and `hasActiveAsyncRuns()` liveness. `registerChildSessionApi()` publishes the same shape inside child sessions but intentionally stubs `spawnRaw` and `list` because nested raw spawning is unsupported by the in-process executor.

Host lineage is mutable closure state (`hostLineage`) with a best-effort host shape available before `session_start`; after the session id is known, it updates `rootSessionId`, writes host lineage into `../state/lineage.ts`, and republishes. Child lineage is initially `null`, then claimed on `session_start` via `claimPendingChildLineage(sid, fallback)` and republished. This makes eager listeners safe: they always receive an API event immediately, then receive refined lineage later.

`spawnRaw()` adapts the public `SpawnRawInput` into `executor.executeInternal()` using a synthetic raw agent config named `__raw__`. It defaults raw tools to `read`, `grep`, `find`, and `ls`, supports caller-supplied model/thinking/system prompt/inheritance/default progress fields, and builds a fallback headless `ExtensionContext` from `SubagentState` when no UI context exists.

## Flow
1. Host activation calls `createHostSubagentApi(...)` with the idle tracker's canonical `hasActiveAsyncRuns` query.
2. The host API immediately emits `SUBAGENT_EXPOSE_API_EVENT` with spawning, discovery, usage, lineage, and async-liveness methods, plus `SUBAGENT_LINEAGE_EVENT` with provisional host lineage.
3. On host `session_start`, the API records `rootSessionId`, calls `setHostLineage(sessionId, currentAgent)`, and republishes both API and lineage events.
4. Root role activation calls returned `setCurrentAgent(name)`, mutating `hostLineage.currentAgent`, updating the lineage store when possible, and republishing for listeners.
5. Child activation calls `registerChildSessionApi(pi)`, immediately publishes stub API/null lineage, then on child `session_start` claims pending child lineage and republishes.
6. External callers invoke `spawnRaw(input)` only from host sessions; the call is translated into `executor.executeInternal("subagent-spawn-raw", { agent: "__raw__", task, async, cwd, metadata, rawAgentConfig }, abortSignal, undefined, context)` and returns a `SpawnResult`.

## Integration
- Consumed by other extensions via `pi.events` listeners for `SUBAGENT_EXPOSE_API_EVENT` and `SUBAGENT_LINEAGE_EVENT`; the API shape is a frozen public contract and should not be changed casually.
- Depends on protocol types from `../protocol/types.ts`: `SubagentExposedAPI`, `SubagentLineage`, `SpawnRawInput`, `SpawnResult`, `Details`, `ExtensionConfig`, and event constants.
- Delegates execution to `../dispatch/subagent-executor.ts` through `executor.executeInternal()`; discovery/listing delegates to `../shared/agents.ts` with config and registered persona dirs.
- Coordinates durable lineage with `../state/lineage.ts` (`setHostLineage`, `claimPendingChildLineage`) so host and child sessions can be related across in-process executor boundaries.
