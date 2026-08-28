# `src/state/` codemap

## Responsibility (state management + status persistence)
Run-state and persistence layer for pi-subagents: canonical in-memory run display shape, disk-backed `status.json` hydration, append-only run registry discovery, status inspection, transcript/history readers, lineage/session path identity, and pure display/status kernels. The persisted status schema is cross-module: `PersistedRunStatus`, `PersistedRunStep`, `StatusPatch`, and `RunPhase` live in `src/protocol/status-types.ts`, not in this directory.

## Design
- `run-view.ts` defines the ONE canonical in-memory dashboard type: `RunView`/`RunViewStep`, with `LiveRun` provenance (`ownership: "live" | "foreign"`) kept outside the view. Former `ForegroundRunSummary` + `AsyncRunSummary` are intentionally thin aliases/projections onto this type.
- Two `RunView` producers feed the same shape: live-from-memory registry mirrors owned by the in-process `ChildAgentRegistry`, and foreign-from-disk hydration through `async-status.ts` (`statusToRunView`, `readRunViewForEntry`, `readLeafRunViewCached`).
- `status-writer.ts` is the ONE `StatusWriter` implementation for writing `status.json`; it owns `FlushPolicy = "terminal" | "eager"`, `statusFromMeta`, terminal scalar conventions, atomic JSON writes, and the former foreground/sync deep-merge path. The former `sync-run-persistence.ts` file is deleted; only an `ex-sync-run-persistence` comment remains in `mergeValue`.
- `status-patch.ts` is pure shared mutation logic: `applyPatchToStatus` applies structured `StatusPatch` in place, `stepFor` grows persisted steps, and `StatusWriter` plus live mirrors share it to avoid disk/in-memory divergence.
- `run-phase.ts`, `run-liveness.ts`, `run-shape.ts`, and `workflow-display.ts` are pure display kernels: phase state transitions/labels, heartbeat/activity-derived display state + ordering, single/parallel handle/label/badge formatting, and declarative workflow name/progress/phase-plan shaping.
- `runs-registry.ts` is append-only discovery state: global `runs-index.jsonl` plus per-session shards, guarded by `parseRunsRegistryEntryLine`; readers tolerate malformed lines and missing files.
- Caches are bounded or stat-keyed where display is hot: `async-status.ts` caches terminal leaf summaries by `status.json` mtime/size; `RunMessageReader` uses validated `session.preview.json` sidecars for the fast tier and an LRU full-transcript cache capped by 10 entries and 32 MiB of source bytes; `completion-dedupe.ts` uses global TTL maps.

## Flow
1. Dispatch resolves per-run storage with `session-paths.ts` and appends metadata through `runs-registry.ts`.
2. A run is seeded with `statusFromMeta`; `StatusWriter.initialize` writes initial `status.json`, while the live registry mirror can seed the same canonical `RunView` from the same meta.
3. Runtime session events advance phase with `run-phase.ts`; structured patches flow through `applyPatchToStatus` into both `StatusWriter.enqueue`/`finalize` and the live in-memory mirror.
4. Disk readers call `readStatus` for `PersistedRunStatus`, then `async-status.ts` converts it via `statusToRunView`; `readRunViewForEntry` overlays registry lineage/workflow fields, uses owned live views when present, hydrates foreign runs from disk when absent, synthesizes queued stubs briefly, and builds group summaries from child entries.
5. Status surfaces call `run-status.ts` and `formatAsyncRunList` to list scoped registry views or inspect a specific run/group; active rows are derived each tick, terminal rows may be cached.
6. Transcript/history side channels are read separately: `run-transcript.ts` discovers ordered per-step sessions, serves validated preview sidecars, and falls back to Pi's `SessionManager` for full active-branch messages; full reads backfill legacy or missing previews, while `run-history.ts` records small best-effort JSONL history by agent.

## Integration
- Producers: dispatch/runtime code (`child-agent-registry.ts`, `layer0-runs.ts`, in-process executors) uses `StatusWriter`, `statusFromMeta`, `applyPatchToStatus`, `appendRunEntry`, and `resolveChildSessionFile`.
- Consumers: `/subagents-status`, `/runs`, right-pane/transcript UI, completion notifications, and run inspect tools consume `RunView` via `async-status.ts`, `run-status.ts`, `run-transcript.ts`, `completion-dedupe.ts`, and pure display kernels.
- Persistence contracts: `status.json` conforms to `src/protocol/status-types.ts::PersistedRunStatus`; registry entries conform to `RunsRegistryEntry`; session files are JSONL under `<runRecordDir>/run-<stepIndex>/session.jsonl` unless status points to fork-reuse files. Each session may have an adjacent version-1 `session.preview.json` sidecar; previews are sanitized and hard-bounded to 128 KiB.
- Lineage contracts: `lineage.ts` stores host/child session ancestry on `globalThis`, resolves `rootSessionId`, and lets registry/session-scoped overlays render nested run trees.

- `async-status.ts` — hydrates `PersistedRunStatus` into canonical `RunView`, lists registry-backed runs, scopes overlays, caches terminal leaf views, synthesizes group/queued views, and formats run lists.
- `completion-dedupe.ts` — builds stable completion keys, stores global TTL seen maps, prunes duplicates, and evicts by run id.
- `group-status.ts` — pure reducer for Layer0 group state: pending/queued/running children => running; failed/interrupted => failed; otherwise complete.
- `lineage.ts` — global session lineage registry for host/child identity, pending child claims, root-session resolution, depth, run id, and root run id.
- `run-history.ts` — best-effort per-agent JSONL history recorder/loader at `~/.pi/agent/run-history.jsonl` with read-time rotation.
- `run-liveness.ts` — heartbeat/activity classifier and display sort comparator for `quiet`, `working`, `tool_running`, `needs_attention`, and `lost`; matching process identities receive only a bounded fingerprinted grace after a stale observation so sleep can recover while reload orphans are still reaped.
- `run-phase.ts` — pure session-event phase state machine and formatter for waiting/thinking/writing/tool/retry/queued/paused labels.
- `run-shape.ts` — pure single/parallel presentation helpers for run handles, agent labels, colors, and shape badges.
- `run-status.ts` — tool/slash inspection entry point for listing scoped runs or resolving a run/group by id/dir from registry + status files.
- `run-transcript.ts` — canonical per-step session discovery, compact transcript parsing, validated preview-sidecar reads, legacy full-session backfill, and a stat-invalidated full-message LRU capped by 10 entries/32 MiB of source bytes (retaining one oversized newest entry).
- `run-transcript-preview.ts` — builds recent complete message-group previews, sanitizes and truncates payloads, validates version/step/messages/size, writes atomically by temporary-file rename, and supports reads, fork cloning, and coalesced flush/dispose writing.
- `run-view.ts` — canonical in-memory `RunView`/`RunViewStep` display schema plus `LiveRun` provenance wrapper; no IO.
- `runs-registry.ts` — append/read layer for global and per-session registry JSONL, with env/test path overrides and guarded line parsing.
- `session-paths.ts` — resolves canonical run record dirs and per-step `session.jsonl` paths, including fork-context seeding paths without collapsing child storage into parent storage.
- `session-tokens.ts` — scans latest session JSONL in a directory and sums input/output/cache token buckets defensively.
- `slash-live-state.ts` — in-memory live/final slash-command result snapshots keyed by request id, with placeholder progress, updates, restoration, and clearing.
- `status-patch.ts` — pure shared `StatusPatch` applier for status/run-step state, live text/tool counters, phase (including `waiting_network`), heartbeat, and live token persistence.
- `status-writer.ts` — single `StatusWriter` for `status.json`, `statusFromMeta`, eager debounce, terminal throttle/merge/finalize, terminal scalar normalization, and atomic JSON writes.
- `usage-totals.ts` — pure token-usage normalization helpers from aggregate usage or rolled-up totals into persisted/display `TokenUsage`.
- `workflow-display.ts` — shared workflow display name, canonical declared/ad-hoc phase progress, and completed/current/upcoming/unreached phase-plan shaping from durable reached history plus current-phase authority.
