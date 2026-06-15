# AGENTS.md — pi-subagents

Durable constraints for working in this repo. This file deliberately omits anything
you can discover in a few tool calls (how to run tests, file layout, dependencies —
see `package.json` and the `codemap.md` atlas). It captures only the non-obvious
rules and invariants that are easy to violate and expensive to get wrong.

## Agent-facing text must never name concrete agents

Never mention the concrete name of any builtin or user-defined agent in anything an
agent reads at runtime: skills, tool descriptions, JSON/TypeBox schemas, prompts,
system instructions, error/reprompt text, completion guidance.

Reason: the current config may not grant access to the agent you named (this is true
for both builtin and developer-defined agents). Naming one that isn't available
confuses the model and suggests capabilities that don't exist. Describe agents by
role/capability generically, or read available agents from config — never hardcode a
persona name into agent-facing copy.

Related, enforced by `npm run check:source-vocabulary`: source `.ts` (outside
comments) must not contain the words `charter`, `mission`, or `goal`. Keep the public
vocabulary neutral.

## Type safety is cranked to 11

- `npm run typecheck` (`tsc --noEmit`) must stay at **0 errors**. There is no error
  baseline to hide behind — any new type error is a failure, full stop.
- `npm run lint` (Biome) must report **0 errors**.
- Avoid `as any` / `as unknown`. The escape-hatch count is tracked and only goes down.
  If you need a cast, prove it's sound or add a validating guard instead.
- Validate at every disk/IO boundary. Untrusted JSON is parsed through a codec that
  returns a discriminated `{ ok: true; value } | { ok: false; reason }`, not cast with
  `as`. `parsePersistedRunStatus` (in `src/protocol/status-types.ts`) is the pattern —
  malformed input fails closed (returns null/none), never a half-populated trusted
  object.
- Prefer `import type` for type-only imports (helps cycle-breaking and elision).

## Build deep modules, not shallow ones

Ousterhout's rule. A module must hide real complexity behind a narrow interface. Do
not add:

- Re-export shim files (a file whose only content is `export { x } from "./y"`).
  Import from the canonical home. Such shims were removed; don't reintroduce them.
- Thin pass-through wrappers, indirection layers, or "manager/helper" files that only
  forward calls.
- Type-home churn that adds indirection instead of fixing import direction. New type
  homes must be low/pure leaves imported downward (`protocol/`, `shared/`), never
  upward into `dispatch`/`surfaces`/`runtime`/`state`.

When in doubt, fewer files with deeper interfaces beats many shallow ones.

## No storage facade — one backend only

There is exactly one filesystem backend for run persistence. Do NOT build a
`RunStore` / `RunRepository` / `StorageAdapter` / `RunPersistence` interface or any
swappable-backend abstraction. These are reserved tokens; an interface over a single
implementation is pure ceremony. The only sanctioned IO indirection is a validated
codec at the disk boundary (a guard, not an adapter).

## Canonical run representations — do not fork them

- One in-memory run type: `RunView` (`src/state/run-view.ts`), with exactly two
  producers — live-from-memory (the per-activation registry mirror) and
  foreign-from-disk (`statusToRunView`). Do not add a third representation or a
  parallel summary type; older names like `ForegroundRunSummary`/`AsyncRunSummary`
  are thin aliases and should stay that way.
- One persisted type: `PersistedRunStatus` (`src/protocol/status-types.ts`), written
  by one `StatusWriter` through one `openRunRecord` funnel (`src/dispatch/layer0-runs.ts`).

## Execution + persistence invariants

- **All** children (sync, async, parallel) run **in-process** via the host
  `AgentSession` — they share identical execution machinery; the only difference is
  lifecycle ownership (sync = the dispatching turn awaits; async = detached, same
  process). The only `child_process` spawn in the codebase is git, in
  `src/dispatch/worktree.ts`. Don't shell out for anything else.
- `ChildAgentRegistry` is **per-activation, not a singleton**; it does not survive
  reload/fork/new-session. Therefore `status.json` + the append-only run registry are
  the sole post-reload recovery path. Never make live runs render only from memory,
  and never remove that persistence.
- `status.json` on-disk shape must stay backward-readable. Any format change needs a
  compat read + test; don't break runs written by a prior version.
- No hardcoded role-name defaults (`main`/`orchestrator`) as persona defaults.
  Root-role selection is generic with fallback-to-first-discovered.

## Dashboard / surfaces

- No PgUp/PgDn paging and no duplicate legend row; `paneOverlay` owns scroll. Do not
  add a dashboard scroll API mirror for tests.
- Taxonomy is stable: `workflow` is the durable orchestration entity; `parallel` is a
  receipt/container. Don't promote `parallel` to a durable display entity.

## Formatting / lint

- Prettier owns formatting (tabs, see `.prettierrc.json`); Biome lints only
  (`biome.json` has `formatter.enabled: false`). They must not both format.
- A Husky + lint-staged pre-commit hook formats/lints staged files. Don't run a
  repo-wide `prettier --write` as part of an unrelated change — it buries real diffs.

## General

- Behavior-preserving refactors: keep changes surgical, match existing style, no
  speculative abstractions or adjacent refactors beyond the named seam.
- Tests may only be deleted when they cover genuinely removed behavior. Every
  surviving behavior keeps a test; new modules/types get tests at the new seam.
