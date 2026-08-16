# src/runtime/

## Responsibility
Runtime activation layer for the pi-subagents extension. It owns per-activation wiring of the subagent tool/runtime, async tracking, slash/prompt-template bridges, UI renderers/widgets, persona directory events, child-session API publication, and root-session role lifecycle.

- `extension-runtime.ts` — `registerSubagentExtension(pi)` activation entry: creates session-scoped `SubagentState`, `ChildAgentRegistry`, executor, host API, role manager, tools, commands, renderers, event listeners, widget client, host-only live-session directory, and lifecycle cleanup.
- `renderer-catalog.ts` — host-activation-owned, lazily initialized all-tools `AgentSession` used only as the native tool-renderer catalog for persisted dashboard transcripts; creation runs in child-session context and cleanup is idempotent.
- `root-role-manager.ts` — `createRootRoleManager()` manages main/root role discovery, selection, activation, model/thinking/tool application, role status, preserved settings, and the `/role` command.

## Design
`extension-runtime.ts` is the composition root. Each extension activation builds an isolated runtime around the live `pi` instance: state maps/timers, `createSubagentExecutor`, `ChildAgentRegistry`, `createAsyncJobTracker`, persona-dir registry, slash bridges, prompt-template bridge, notification/rendering surfaces, and `RootRoleManager`. Host and child sessions are intentionally asymmetric: host activations pin `currentPi`, install global cleanup/unsubscribe hooks, own the live-session directory, and publish a host API; child activations register a scoped child API and only publish created sessions through the listener-only relay without creating an observer or clobbering the host.

`root-role-manager.ts` is a closure-backed state machine over `activeWorkflowName`, `activeRootRoleName`, and `activeRootRole`. It uses discovery (`discoverAgents` + preset/default-role selection), command completion, and UI selection as inputs, then applies role effects through Pi SDK calls. Runtime preset settings written by `pi.setModel()` / `pi.setThinkingLevel()` are wrapped by `withRuntimePresetSettingsPreserved()` so temporary role activation does not permanently mutate `~/.pi/agent/settings.json` keys (`defaultProvider`, `defaultModel`, `defaultThinkingLevel`).

## Flow
1. Activation starts in `registerSubagentExtension(pi)` and detects child sessions through the async-local construction context in `../shared/child-session-context.ts`.
2. Host activations pin `currentPi`, clean stale runtime listeners/timers from previous reloads, load config, configure XML stripping, create `SubagentState` plus one live-session directory, one pending native-tool component store, and one lazy renderer catalog, cleanup artifact dirs, and initialize idle/widget/async trackers. Child activations omit these host-owned dashboard resources.
3. Runtime constructs `ChildAgentRegistry`, persona-dir registry, `createSubagentExecutor()`, `createHostSubagentApi()`, and `createRootRoleManager()`; agent discovery is wrapped to include config, registered persona dirs, and resolved tool patterns.
4. Runtime registers message renderers, slash/prompt-template bridges, `subagent` and `workflow` tools, slash commands, `/role`, notify/control/persona event listeners, and `tool_result` widget refresh handling.
5. On `session_start`, runtime resets cwd/session/UI state, rehydrates async jobs, restores slash snapshots, republishes host API, and initializes the root role unless the session is delegated.
6. Root role initialization resolves requested workflow from flags/env/config, discovers main-surface agents, restores prior `role-state`, selects a role, appends new `role-state`, applies model/thinking/tools, updates UI status, and exposes current agent lineage through the host API.
7. The first dashboard open initializes the renderer catalog with an in-memory session containing every discovered tool; later opens reuse it. `before_agent_start` appends the active root role system prompt only in root sessions; `session_shutdown` and activation replacement dispose the live-session directory, pending tool components, and catalog/listener/timer/widget/bridge state.

## Integration
- Depends on Pi extension lifecycle/events: `pi.registerTool`, `pi.registerCommand`, `pi.registerMessageRenderer`, `pi.on("session_start"|"before_agent_start"|"tool_result"|"session_shutdown")`, `pi.events`.
- Delegates execution to `../dispatch/subagent-executor.ts`, in-process child handling to `../dispatch/in-process-executor.ts`, tool definitions to `../dispatch/subagent-tool.ts`, and prompt/slash bridges to dispatch/surfaces modules.
- Publishes/consumes protocol events and state from `../protocol/types.ts` including async started/complete/delivered, control events, persona-dir register/unregister, slash result type, and widget key.
- Integrates UI through `pi-extension-utils` widgets, `render-widget.ts`, `render-result.ts`, message renderers, notify/control notices, and status badges (`preset`, `role`).
- Shares cross-extension host/child identity through `../api/exposed-subagent-api.ts`; `root-role-manager` updates host lineage via `setHostCurrentAgent()` whenever the root role changes.
