# `src/state/` codemap

## Responsibility (state management + status persistence)
Run-state and persistence layer for pi-subagents: canonical in-memory run display shape, disk-backed `status.json` hydration, append-only run registry discovery, status inspection, transcript/history readers, lineage/session path identity, and pure display/status kernels. The persisted status schema is cross-module: `PersistedRunStatus`, `PersistedRunStep`, `StatusPatch`, and `RunPhase` live in `src/protocol/status-types.ts`, not in this directory.

## Design
- `run-view.ts` defines the ONE canonical in-memory dashboard type: `RunView`/`RunViewStep`, with `LiveRun` provenance (`ownership: "live" | "foreign"`) kept outside the view. Former `ForegroundRunSummary` + `AsyncRunSummary` are intentionally thin aliases/projections onto this type.
- Two `RunView` producers feed the same shape: live-from-memory registry mirrors owned by the in-process `ChildAgentRegistry`, and foreign-from-disk hydration through `async-status.ts` (`statusToRunView`, `readRunViewForEntry`, `readLeafRunViewCached`).
- `status-writer.ts` is the ONE `StatusWriter` implementation for writing `status.json`; it owns `FlushPolicy = "terminal" | "eager"`, `statusFromMeta`, terminal scalar conventions, atomic JSON writes, and the former foreground/sync deep-merge path. The former `sync-run-persistence.ts` file is deleted; only an `ex-sync-run-persistence` comment remains in `mergeValue`.
- `status-patch.ts` is pure shared mutation logic: `applyPatchToStatus` applies structured `StatusPatch` in place, `stepFor` grows persisted steps, and `StatusWriter` plus live mirrors share it to avoid disk/in-memory divergence.
- `run-phase.ts`, `run-liveness.ts`, and `run-shape.ts` are pure display kernels: phase state transitions/labels, heartbeat/activity-derived display state + ordering, and single/parallel handle/label/badge formatting.
- `runs-registry.ts` is append-only discovery state: global `runs-index.jsonl` plus per-session shards, guarded by `parseRunsRegistryEntryLine`; readers tolerate malformed lines and missing files.
- Caches are bounded or stat-keyed where display is hot: `async-status.ts` caches terminal leaf summaries by `status.json` mtime/size, `run-transcript.ts` caches parsed transcript lines by status/session-file stats, and `completion-dedupe.ts` uses global TTL maps.

## Flow
1. Dispatch resolves per-run storage with `session-paths.ts` and appends metadata through `runs-registry.ts`.
2. A run is seeded with `statusFromMeta`; `StatusWriter.initialize` writes initial `status.json`, while the live registry mirror can seed the same canonical `RunView` from the same meta.
3. Runtime session events advance phase with `run-phase.ts`; structured patches flow through `applyPatchToStatus` into both `StatusWriter.enqueue`/`finalize` and the live in-memory mirror.
4. Disk readers call `readStatus` for `PersistedRunStatus`, then `async-status.ts` converts it via `statusToRunView`; `readRunViewForEntry` overlays registry lineage/workflow fields, uses owned live views when present, hydrates foreign runs from disk when absent, synthesizes queued stubs briefly, and builds group summaries from child entries.
5. Status surfaces call `run-status.ts` and `formatAsyncRunList` to list scoped registry views or inspect a specific run/group; active rows are derived each tick, terminal rows may be cached.
6. Transcript/history side channels are read separately: `run-transcript.ts` discovers per-step `session.jsonl` files from status first and parses step/tool/final-text lines; `run-history.ts` records small best-effort JSONL history by agent.

## Integration
- Producers: dispatch/runtime code (`child-agent-registry.ts`, `layer0-runs.ts`, in-process executors) uses `StatusWriter`, `statusFromMeta`, `applyPatchToStatus`, `appendRunEntry`, and `resolveChildSessionFile`.
- Consumers: `/subagents-status`, `/runs`, right-pane/transcript UI, completion notifications, and run inspect tools consume `RunView` via `async-status.ts`, `run-status.ts`, `run-transcript.ts`, `completion-dedupe.ts`, and pure display kernels.
- Persistence contracts: `status.json` conforms to `src/protocol/status-types.ts::PersistedRunStatus`; registry entries conform to `RunsRegistryEntry`; session files are JSONL under `<runRecordDir>/run-<stepIndex>/session.jsonl` unless status points to fork-reuse files.
- Lineage contracts: `lineage.ts` stores host/child session ancestry on `globalThis`, resolves `rootSessionId`, and lets registry/session-scoped overlays render nested run trees.

- `async-status.ts` — hydrates `PersistedRunStatus` into canonical `RunView`, lists registry-backed runs, scopes overlays, caches terminal leaf views, synthesizes group/queued views, and formats run lists.
- `completion-dedupe.ts` — builds stable completion keys, stores global TTL seen maps, prunes duplicates, and evicts by run id.
- `group-status.ts` — pure reducer for Layer0 group state: pending/queued/running children => running; failed/interrupted => failed; otherwise complete.
- `lineage.ts` — global session lineage registry for host/child identity, pending child claims, root-session resolution, depth, run id, and root run id.
- `run-history.ts` — best-effort per-agent JSONL history recorder/loader at `~/.pi/agent/run-history.jsonl` with read-time rotation.
- `run-liveness.ts` — pure heartbeat/activity classifier and display sort comparator for `quiet`, `working`, `tool_running`, `needs_attention`, and `lost`.
- `run-phase.ts` — pure session-event phase state machine and formatter for waiting/thinking/writing/tool/retry/queued/paused labels.
- `run-shape.ts` — pure single/parallel presentation helpers for run handles, agent labels, colors, and shape badges.
- `run-status.ts` — tool/slash inspection entry point for listing scoped runs or resolving a run/group by id/dir from registry + status files.
- `run-transcript.ts` — cached transcript reader that discovers per-step session files, parses session JSONL into step/tool/final-text lines, and uses status metadata for timing/tokens.
- `run-view.ts` — canonical in-memory `RunView`/`RunViewStep` display schema plus `LiveRun` provenance wrapper; no IO.
- `runs-registry.ts` — append/read layer for global and per-session registry JSONL, with env/test path overrides and guarded line parsing.
- `session-paths.ts` — resolves canonical run record dirs and per-step `session.jsonl` paths, including fork-context seeding paths without collapsing child storage into parent storage.
- `session-tokens.ts` — scans latest session JSONL in a directory and sums input/output/cache token buckets defensively.
- `slash-live-state.ts` — in-memory live/final slash-command result snapshots keyed by request id, with placeholder progress, updates, restoration, and clearing.
- `status-patch.ts` — pure shared `StatusPatch` applier for status/run-step state, live text/tool counters, phase, heartbeat, and live token persistence.
- `status-writer.ts` — single `StatusWriter` for `status.json`, `statusFromMeta`, eager debounce, terminal throttle/merge/finalize, terminal scalar normalization, and atomic JSON writes.
- `usage-totals.ts` — pure token-usage normalization helpers from aggregate usage or rolled-up totals into persisted/display `TokenUsage`.
