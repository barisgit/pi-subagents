# src/

## Responsibility

Implementation root for the pi-subagents extension. All logic imported by the thin `index.ts` entry lives here, organized into layered modules. See the root [Repository Atlas](../codemap.md) for project-wide context and invariants.

## Layering (import direction is downward)

```
runtime/   → activation, wiring, role lifecycle (top)
surfaces/  → presentation: dashboard, renderers, slash, notifications
dispatch/  → subagent execution: paths, registry, cwd routing, resume
workflow/  → JS workflow orchestration over dispatch
state/     → run-state + persistence (RunView, StatusWriter, registry)
api/       → frozen cross-extension public boundary
protocol/  → pure DTOs / wire types / schemas / codec (leaf)
shared/    → low-level utilities, agent/skill discovery, env policy (leaf)
```

`protocol/` and `shared/` are pure leaves: imported downward by every other layer and must never import upward into `dispatch`/`surfaces`/`runtime`/`state`. The `runview-unification` charter broke the former executor↔path runtime cycles (madge `src/dispatch` = 0 cycles); the only remaining documented cycle is the pre-existing `protocol/types ↔ protocol/status-types` type pair.

## Subdirectories

| Directory | Responsibility | Map |
|-----------|----------------|-----|
| `dispatch/` | Subagent dispatch + child-agent execution, including process-global active-leaf and per-workflow child-admission limits (29 files) | [Map](dispatch/codemap.md) |
| `surfaces/` | Presentation/UI: renderers, dashboard, slash, notify (20 files) | [Map](surfaces/codemap.md) |
| `state/` | Run-state + persistence: RunView, StatusWriter, registry, bounded transcript previews (19 files) | [Map](state/codemap.md) |
| `shared/` | Low-level leaf utilities + agent/skill discovery + live-session relay (18 files) | [Map](shared/codemap.md) |
| `protocol/` | Pure DTOs, schemas, PersistedRunStatus codec (4 files) | [Map](protocol/codemap.md) |
| `runtime/` | Activation wiring, activation-owned live-session directory/renderer catalog + root-role lifecycle (3 files) | [Map](runtime/codemap.md) |
| `workflow/` | Bounded JS workflow orchestration over subagents, including pipeline item-chain backpressure (2 files) | [Map](workflow/codemap.md) |
| `api/` | Frozen cross-extension public API boundary (1 file) | [Map](api/codemap.md) |
