# src/surfaces/

## Responsibility

Presentation/surface layer for the pi-subagents pi-coding-agent extension. This folder owns the user-facing terminal UI surfaces, slash-command entrypoints, status dashboard, above-editor async widget, custom transcript messages, completion/control notifications, and small surface adapters for file-output and agent management. It translates protocol/state/run records into compact terminal renderings and UI events; execution, persistence, schemas, and run-state semantics live in sibling `state/`, `protocol/`, and `shared/` modules.

## Design

- Rendering is intentionally split by surface. The old monolithic `render.ts` was split into `render-result.ts` (largest, result/details rendering), `render-inline.ts` (nested child summaries), `render-shared.ts` (ANSI/width/theme/spinner primitives), `render-widget.ts` (async widget), and `message-renderers.ts` (custom transcript components).
- `subagents-status.ts` is the fullscreen dashboard component. It owns TUI lifecycle, paneOverlay integration, refresh cadence, selection/collapse state, split sizing, and scope controls.
- `dashboard-row-model.ts` is the pure row-derivation model: `deriveDisplayRows`, canonical declared/runtime workflow phase merging (including durable childless reached history), session-tree filtering, parent/child ordering, container detection, pending-delivery metadata, and live/foreign ownership assignment. It encodes the display taxonomy where workflow groups are durable orchestration entities and parallel groups are receipt/container rows around child work.
- `dashboard-run-source.ts` is the narrow adapter from fetched async overlay plus in-memory foreground runs to scoped/sorted `LiveRun[]`; the dashboard fetches, this module derives.
- `dashboard-detail-renderer.ts` renders right-pane details from `LiveRun`: workflow metadata description and ordered phase plan plus script/step outline for workflow groups, a mini chat-transcript for ordinary runs (clipped prompt preview, per-step activity gist, interleaved dim assistant narration, one line per tool call with a table-driven hint via `humanizeToolArgs` plus a dim result-preview line, bordered final markdown block), and nested child summaries.
- Notifications are separated by concern: `notify.ts` sends host transcript notifications and delivery events, `control-notices.ts` renders attention/control notices, and `idle-tracker.ts` detects all-idle transitions.
- Slash commands are event-bridged: `slash-commands.ts` parses `/run` and `/parallel`, emits bridge requests, and opens `/subagents-status`; `slash-bridge.ts` executes requests against the active extension context with abort/update/response events.
- Agent CRUD is surfaced through `agent-management.ts` and `agent-serializer.ts`; formatting shims (`formatters.ts`, `async-guidance.ts`) keep old surface import paths stable while delegating to `shared/formatting.ts`.
- The active dashboard input path delegates scrolling/navigation to `paneOverlay`; there is no surface-owned PgUp/PgDn paging action wired in the overlay config. Legacy private cursor helpers remain in `subagents-status.ts`, but `handleInput` forwards to `paneOverlay`, which owns scroll behavior.

## Flow

1. Commands or tools create runs. `/run` and `/parallel` parse inline config, validate agents, apply `--bg`/`--fork`, and send params through the slash bridge or async execution path.
2. Async starts/completions update `SubagentState.asyncJobs`. `async-job-tracker.ts` polls run records/status, derives activity/display state, reads durable workflow phases ahead of child fallbacks, restores metadata-backed terminal workflow rows after reload, and calls `renderWidget`.
3. `render-widget.ts` orders jobs newest-first with attention pinned, nests child rows, hides workflow children under workflow group rows, renders metadata-aware workflow names and declared phase progress, and drives animation only while live non-lost jobs exist. `async-job-tracker.ts` supplies run IDs to bounded stale-heartbeat checks so a post-sleep child can refresh while an unrefreshed reload orphan still becomes terminal.
4. Foreground and slash results use `render-result.ts` for compact/expanded cards. It guards malformed details, renders progress/tool history/tokens/duration/sparklines, delegates nested child lookup/rendering to `render-inline.ts`, and manages result animation timers.
5. `/subagents-status` opens `SubagentsStatusComponent`. It fetches async overlay data plus foreground controls, expands registry roots, converts registry entries to `RunView`, asks `dashboard-run-source.ts`/`dashboard-row-model.ts` for `LiveRun[]` and display rows, then renders left rows and right detail lines through `paneOverlay`.
6. Completion events flow through `notify.ts`: policy (`each`/`rollup`/`silent`) decides message shape, dedupe prevents repeated notifications, workflow groups notify once, and delivered events let widgets/dashboard retire pending rows.
7. Control/attention and all-idle events are separate signals: control notices become custom transcript cards, while idle tracking emits when host loop and async set both drain.

## Integration

- Depends on pi-coding-agent extension APIs for commands, shortcuts, context/UI/theme, session manager, events, and `sendMessage`.
- Depends on pi-tui for components (`Container`, `Box`, `Markdown`, `Text`), width/truncation, keys, and fullscreen/custom rendering.
- Depends on `pi-extension-utils` for `paneOverlay`, split-pane layout, cursor utilities, and optional widget/fullscreen client integration.
- Reads run state from `../state/*`: async status/registry/transcripts, run liveness/phase/shape/view, workflow script state, slash live state, and completion dedupe.
- Reads protocol types/events from `../protocol/types.ts` and slash/tool input schemas from `../protocol/schemas.ts`.
- Uses shared utilities for agent discovery/colors, formatting, logger, current Pi resolution, and status file reads.
- Public surface entrypoints used elsewhere include `registerSlashCommands`, `registerSlashSubagentBridge`, `registerSubagentNotify`, `createAsyncJobTracker`, `createIdleTracker`, `renderSubagentResult`, `renderWidget`, `stopWidgetAnimation`, `stopResultAnimations`, `SubagentsStatusComponent`, and `foregroundRunsFromState`.

### File index

- `agent-management.ts` — handles surface-level agent list/create/update/delete-style actions and wraps responses as agent tool results.
- `agent-serializer.ts` — serializes agent config/frontmatter and updates individual frontmatter fields on disk.
- `async-guidance.ts` — compatibility shim for async guidance text and `/subagents-status` hint formatting.
- `async-job-tracker.ts` — maintains async widget job lifecycle, polling, rehydration, activity attention, pending-delivery, and cleanup.
- `control-notices.ts` — registers custom control notice rendering and formats attention/control transition messages.
- `dashboard-detail-renderer.ts` — renders selected dashboard row details, including workflow scripts/steps and humanized transcript tool/narration output.
- `dashboard-row-model.ts` — pure transform from `LiveRun[]` plus collapse/scope state to ordered dashboard display rows and metadata.
- `dashboard-run-source.ts` — combines async overlay and foreground runs, removes duplicates, applies ownership and session/branch scope.
- `formatters.ts` — re-exports shared duration/token/tool/path formatters and formats compact usage strings.
- `idle-tracker.ts` — tracks host-loop plus async-run idleness and emits all-idle events on busy-to-idle transitions.
- `message-renderers.ts` — builds live slash result components and subagent notification transcript cards.
- `notify.ts` — sends completion notifications, batches/rolls up child results, dedupes, handles workflow semantics, and emits delivery confirmations.
- `render-inline.ts` — finds nested child runs from registry/status and renders compact inline nested summaries/tallies.
- `render-result.ts` — renders foreground subagent result cards, progress details, outputs, stats, child activity, sparklines, and animations.
- `render-shared.ts` — shared terminal width, ANSI-safe truncation, spinner, theme, token-stat, and agent-name tint helpers.
- `render-widget.ts` — renders the async jobs widget above the editor and manages widget animation/request-render state.
- `single-output.ts` — resolves output paths, injects output instructions, snapshots files, persists fallback output, and finalizes display text.
- `slash-bridge.ts` — bridges slash UI requests to subagent execution with cancel, started, update, and response events.
- `slash-commands.ts` — registers `/run`, `/parallel`, `/subagents-status`, argument completions, bg/fork parsing, and dashboard shortcut.
- `subagents-status.ts` — fullscreen status dashboard component with paneOverlay split panes, scoped run loading, row rendering, refresh, collapse, and selection.
