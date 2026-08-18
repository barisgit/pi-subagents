# Repository Atlas: pi-subagents

## Project Responsibility

A pi-coding-agent extension that adds subagent dispatch to Pi: a `subagent` tool for delegating bounded work to named specialist agents, plus parallel/async execution, same-role forks, JavaScript workflow orchestration, a fullscreen status dashboard, an above-editor async widget, and completion notifications. Child agents run **in-process** through the host `AgentSession`; a listener-only process relay lets the host-owned dashboard directory observe live nested sessions without changing control ownership or persistence; ordered model failover preserves their persisted history, transport failures wait without consuming fallbacks, and bounded stale-heartbeat grace prevents laptop sleep from being confused with immortal reload orphans. `status.json` + an append-only run registry are the durable post-reload recovery path.

This codebase is the product of two completed refactoring charters:
- `subagents-deepening` (committed `2730d31`): made the four oversized modules deep at the right seam (index 1181→20, executor 3538→2207, render split, status 1544→949).
- `runview-unification` (this branch): introduced one canonical in-memory `RunView` (two producers: live-from-memory + foreign-from-disk), one `PersistedRunStatus` disk type, one `StatusWriter`, one `openRunRecord` dispatch funnel, broke the 11 dispatch import cycles to 0, and hardened the disk-IO boundary with a validated codec.

## System Entry Points

- `index.ts` — root extension entry point (thin shell, ~20 lines); registers tools, slash commands, notifications, widgets, and async/status APIs by importing implementation from `src/`.
- `src/runtime/extension-runtime.ts` — `activate()`: constructs the per-activation `ChildAgentRegistry` and wires tools/commands/notifications/widgets/role lifecycle.
- `package.json` — dependency manifest, npm scripts (`test:unit`, `test:integration`, `test:all`, `lint`, `format`, `check:source-vocabulary`), and `lint-staged` config.

## Tooling & Quality Gates

- **Prettier** owns formatting (`.prettierrc.json`: tabs, width 4, double quotes, semicolons, trailing-comma all). **Biome** lints only (`biome.json`: `formatter.enabled: false`). They do not conflict.
- **Husky + lint-staged** pre-commit hook runs `biome lint --write` then `prettier --write` on staged `.ts/.mjs` (+ Prettier on `.json`).
- **`.editorconfig`** + **`.vscode/settings.json`** pin Prettier as the format-on-save formatter with tab indentation.
- `npm run typecheck` (`tsc --noEmit`) — must stay at 0 errors.
- `npm run lint` (Biome) — must report 0 errors.
- `scripts/check-source-vocabulary.mjs` — forbids reintroducing hardcoded role-name defaults.

## Directory Map (Aggregated)

| Directory | Responsibility Summary | Detailed Map |
|-----------|------------------------|--------------|
| `src/dispatch/` | Subagent dispatch + child-agent execution: run-record funnel, sync/async paths, process-global active-leaf and per-workflow pre-run admission limits, registry, resume, intercom. (29 files) | [View Map](src/dispatch/codemap.md) |
| `src/surfaces/` | Presentation/UI layer: split renderers (result/inline/shared/widget), fullscreen dashboard + pure row-model, slash commands, notifications, async job widget, agent CRUD. (20 files) | [View Map](src/surfaces/codemap.md) |
| `src/state/` | Run-state + persistence: canonical in-memory `RunView` (two producers), one `StatusWriter`, status-patch applier, disk hydration, append-only registry, pure phase/liveness/shape kernels. (18 files) | [View Map](src/state/codemap.md) |
| `src/shared/` | Low-level leaf utilities (imported downward, no upward imports): agent/skill discovery, fs codecs, runtime-env policy, path constants, stale-runner grace, live-session relay, formatting, settings, logging. (18 files) | [View Map](src/shared/codemap.md) |
| `src/protocol/` | Protocol/vocabulary layer (pure DTOs, no fs): wire types, the canonical `PersistedRunStatus` + `parsePersistedRunStatus` codec, tool schemas, child completion contract. (4 files) | [View Map](src/protocol/codemap.md) |
| `src/runtime/` | Runtime activation: per-activation wiring of tool/widgets/bridges, one host-owned live-session directory, one lazy all-tools renderer catalog, and root-session role lifecycle (`/role`). (3 files) | [View Map](src/runtime/codemap.md) |
| `src/workflow/` | Bounded JavaScript orchestration: sandbox globals, pipeline item-chain backpressure, progress, and durable workflow lifecycle. (2 files) | [View Map](src/workflow/codemap.md) |
| `src/api/` | Frozen cross-extension public API boundary: session-scoped `SubagentExposedAPI` + lineage events for sibling extensions. (1 file) | [View Map](src/api/codemap.md) |

## Key Architectural Invariants

- **One canonical run type:** `RunView` (in-memory, `src/state/run-view.ts`) with exactly two producers — live-from-memory (registry mirror) and foreign-from-disk (`statusToRunView`). Former `ForegroundRunSummary`/`AsyncRunSummary` are thin aliases.
- **One persisted type:** `PersistedRunStatus` (`src/protocol/status-types.ts`), written by one `StatusWriter` through one `openRunRecord` funnel.
- **No storage facade:** there is exactly one filesystem backend; do NOT introduce a `RunStore`/`RunRepository`/`StorageAdapter`/`RunPersistence` interface (reserved tokens, enforced by the canonical verifier).
- **No hardcoded role defaults** (`main`/`orchestrator`); root-role selection is generic with fallback-to-first-discovered.
- **Dashboard taxonomy:** `workflow` is the durable entity; `parallel` is a receipt/container. No PgUp/PgDn paging (paneOverlay owns scroll). The live-session relay is display-only: the global hub retains listeners only, while the host activation owns and disposes session references.

## Tests

- `test/unit/` — unit tests (824 pass), including source-layout + path-resolution coverage.
- `test/integration/` — integration tests (132 pass, 10 pre-existing skips) via the TypeScript loader hook.
- `test/support/` — shared test helpers and loader/isolation hooks.
- `test/fixtures/` — reusable fixtures (excluded from Prettier; workflow recipe `.js` files carry YAML frontmatter).
