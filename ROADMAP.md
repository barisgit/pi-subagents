# Roadmap: pi-subagents after unshitification + paneOverlay migration

Start by treating `unshitification` as shipped and stable: the active charter was completed, the dashboard now uses `pi-extension-utils@0.3.1` `paneOverlay`, and the working tree should only contain this roadmap unless the user has made new changes. The most important next move is **live UX smoke in Pi**: reload extensions, open `/subagents-status`, verify the paneOverlay dashboard feels right, then decide the next charter from the open questions below.

## Current state

- Repo: `/Users/blaz/Programming_local/Projects/pi-extensions/pi-subagents`
- Branch: `unshitification`
- Recent commits, newest first:
  - `4d06587` — Dashboard: use paneOverlay for fullscreen status shell
  - `4bf6aa7` — Root roles: stop inventing user-specific persona names
  - `14205a8` — Adopt pi-extension-utils pane kit and fullscreen helper
  - `637fefc` — Integrate pi-extension-utils: coordinated widgets + fullscreen dashboard
  - `e12e56a` — Review fix: widget hides only parallel containers; doc staleness
  - `e39283e` — Modularize flat root sources into `src/` modules
  - `3f8817d` — Evict chain mode; workflow supersedes chain
  - `508701d` — Taxonomy presentation: workflow phases as tree levels, parallel containers flattened
  - `c79b09e` — Resend notifications dropped by user interrupts
- Charter `2ef8e46d-8339-4797-9fae-2c7ed427e4ae` (`unshitification`) is complete: 7/7 VALs passed.
- `pi-extension-utils@0.3.1` is published and consumed from npm; `paneOverlay` resolves as a function.
- `/subagents-status` still opens through `client.ui.fullscreen(...)` in `src/surfaces/slash-commands.ts`.
- Working tree after writing this file should show only `?? ROADMAP.md` unless the roadmap is committed.

## Verification already run

Last green gates after `4d06587`:

```bash
cd /Users/blaz/Programming_local/Projects/pi-extensions/pi-subagents
npm run test:unit                         # all pass
npm run typecheck                         # 0 errors
npm run check:source-vocabulary           # pass
```

During paneOverlay migration, targeted checks also passed:

```bash
node --experimental-strip-types --import ./test/support/isolate-registry.mjs \
  --test test/integration/subagents-status.test.ts \
         test/unit/dashboard-collapse.test.ts \
         test/unit/workflow-dashboard.test.ts
# 40/40 pass
```

Manual smoke after the final commit was recommended but not confirmed in this thread.

## What shipped in the unshitification arc

- Dashboard taxonomy:
  - Workflow is rendered as the real entity.
  - Workflow phases render as tree levels between the workflow row and child runs.
  - Parallel workflow children show parallel markers where relevant.
  - Plain parallel containers are flattened; the batch relationship is receipt/marker-level, not a persistent dashboard entity.
- Widget taxonomy:
  - Async workflow renders as one widget row; children are hidden there.
  - Parallel children are visible while useful; pending-delivery state is explicit.
  - Completed rows can be retained until notification delivery.
- Notifications:
  - Workflow async completion sends one notification with the workflow return value.
  - Rollup/batch notification delivery is tracked; widget rows do not disappear before delivery.
  - Notifications dropped by user interrupt were addressed earlier (`c79b09e`), but live reliability should still be watched.
- Chain eviction:
  - Chain mode removed as an execution/presentation path; workflow supersedes it.
  - Docs and descriptions were updated away from chain as a recommended control-flow mechanism.
- Source layout:
  - Flat root implementation moved under `src/` modules: dispatch, protocol, shared, state, surfaces, workflow.
  - `codemap.md` updated for navigation.
- Shared utility adoption:
  - `pi-extension-utils` adopted for coordinated widgets, fullscreen lease, pane kit, and now `paneOverlay`.
  - Local `render-helpers.ts` was deleted earlier; chrome/nav helpers now come from utils.

## Current `/subagents-status` paneOverlay state

- File: `src/surfaces/subagents-status.ts`
- `SubagentsStatusComponent` now wraps a `paneOverlay<void, OverlayDisplayRow>` instance.
- `paneOverlay` owns:
  - top/bottom chrome
  - standard legend
  - split sizing and resize keys
  - primary/detail pane layout
  - cursor/scroll behavior for standard keys
- Dashboard keeps local domain logic:
  - `displayRows()` and workflow phase rows
  - collapse state
  - registry/session/branch-anchor reload and filtering
  - `buildLeftLine`, `buildRightLines`, transcript/event rendering
  - foreground/sync dedupe
  - render-diff refresh timer
- Removed during cleanup:
  - local `LEGEND_ENTRIES`
  - local old chrome methods (`topBorder`, `bottomBorder`, `bodyRow`, `buildLegendLines`)
  - local PgUp/PgDn legend/key expectations
- Current standard legend comes from `paneOverlay` and intentionally does **not** include `pgup/pgdn`.
- Current tests assert no `pgup/pgdn page` legend row.

## Important user preferences / constraints

- User gets angry at hardcoded personal preset names in extension logic. Do not add magic role names like `main` or `orchestrator`; those are user-defined agent presets, not extension semantics.
- Keep root-role selection generic: explicit/configured/restored role first, then first discovered main-surface role.
- User prefers live UX iteration over theoretical completion: after dashboard/UI changes, reload Pi and smoke actual `/subagents-status`.
- No speculative over-engineering. Make small, behavior-backed changes.
- Gates matter: run `npm run test:unit`, `npm run typecheck`, `npm run lint`, and `npm run check:source-vocabulary` before commits.
- Do not publish npm packages without explicit user coordination; OTP may be required.

## Failed approaches / do not repeat

- Do not use fake compatibility legend rows to satisfy old tests. This caused duplicate `PgUp/PgDn` rows in the live dashboard. Fix tests to the helper’s actual contract instead.
- Do not pass `Number.MAX_SAFE_INTEGER` or other unbounded widths into `buildRightLines`; it can hit `String.repeat` and crash Pi with `RangeError: Invalid string length`.
- Do not commit `pi-subagents` changes that depend on unpublished `pi-extension-utils`; first publish utils, then reinstall from npm and verify `import('pi-extension-utils').then(u => typeof u.paneOverlay)`.
- Do not reintroduce PgUp/PgDn as standard dashboard keys unless the utils package explicitly supports them again. They were deliberately removed from `paneOverlay`.
- Do not treat parallel batches as durable display entities unless a future design explicitly reverses the taxonomy. Current model: parallel is a helper/receipt; workflow is the entity.

## Open questions / next roadmap candidates

1. **Live paneOverlay smoke and polish**
   - Reload Pi and open `/subagents-status`.
   - Verify fullscreen open/close, widget blank/restore, focus with tab/left/right, j/k, u/d, resize, collapse, `a` all-sessions.
   - Watch for visual drift from pre-paneOverlay dashboard, especially right-pane scroll behavior and footer wording.

2. **paneOverlay API gaps**
   - `paneOverlay` owns detail scroll state; `SubagentsStatusComponent` still keeps legacy mirrored right-scroll helpers for tests (`getRightPaneScrollTop`, `scrollRightPaneByPage`).
   - Consider adding a first-class scroll-state accessor or adapter to `pi-extension-utils` if tests/consumers need to observe/control detail scroll.
   - Decide whether `paneOverlay` should expose row/pane widths to row renderers; current adapter estimates with `lastLeftWidth`/`lastRightWidth` before render.

3. **Agent Manager migration**
   - `/agents` still uses its own component structure, though it imports shared helpers from `pi-extension-utils`.
   - Candidate next charter: migrate `/agents` manager to `client.ui.fullscreen` + `paneOverlay` or a related utility if it fits.
   - Be careful: `/agents` is not the same as `/subagents-status`; avoid forcing a master/detail abstraction if the UX does not match.

4. **Workflow durability**
   - Previously deferred: resume/replay workflows after laptop sleep, process crash, or network interruption.
   - Old design direction: durable primitive like `step(label, fn)` with memo/replay by execution position + input hash; API should be retroactive/minimal.
   - This deserves a separate charter.

5. **Notification reliability hardening**
   - Interrupt/drop bugs were addressed, but the user specifically noticed cases where notifications never arrived.
   - Continue live testing after new overlay changes; pending-delivery indicators should make delivery gaps visible.
   - Consider deeper event-delivery audit if live smoke still finds missing rollups.

6. **Post-modularization cleanup**
   - `src/surfaces/subagents-status.ts` remains large and complex even after paneOverlay.
   - Do not split just for aesthetics; split only along stable seams (row model, right-pane rendering, reload/filtering) with tests.
   - `codemap.md` is the navigation artifact for future agents.

7. **Documentation / changelog**
   - If preparing a PR/release, add a concise changelog entry for: workflow taxonomy dashboard, chain eviction, modularization, utils/paneOverlay adoption, root-role no-magic-name fix.
   - Avoid copying huge implementation detail; link commits or `codemap.md`.

## Recommended next actions

1. Start with a clean check:
   ```bash
   cd /Users/blaz/Programming_local/Projects/pi-extensions/pi-subagents
   git status --short
   git log --oneline -5
   ```
   Expected: only `ROADMAP.md` untracked if this file was not committed.

2. Reload Pi/extensions and manually smoke `/subagents-status`:
   - fullscreen opens
   - widgets blank while open and restore on close
   - legend has no duplicate rows and no `pgup/pgdn`
   - `tab` and left/right switch focus
   - `j/k`, `u/d`, `[`/`]`, `enter/o`, `a`, `q/esc` work

3. If smoke passes, ask user whether to commit this roadmap or leave it untracked; then push `unshitification` if desired.

4. If smoke finds a bug, keep the fix narrow in `src/surfaces/subagents-status.ts` or `pi-extension-utils` depending on ownership, then rerun:
   ```bash
   npm run test:unit
   npm run typecheck
   npm run check:source-vocabulary
   ```

5. For the next real feature arc, create a new charter. Recommended first options:
   - `workflow durability`
   - `notification reliability live-hardening`
   - `agent-manager paneOverlay/fullscreen migration`

## Key files and artifacts

- `src/surfaces/subagents-status.ts` — dashboard component and paneOverlay adapter.
- `src/surfaces/slash-commands.ts` — `/subagents-status` open path using `client.ui.fullscreen(...)`.
- `test/integration/subagents-status.test.ts` — dashboard integration/legend/navigation tests.
- `test/unit/dashboard-tree-rows.test.ts` — tree/half-page/dashboard layout tests.
- `test/unit/workflow-dashboard.test.ts` — workflow phase tree/dashboard reader tests.
- `codemap.md` — repo structure after modularization.
- `package.json` / `package-lock.json` — depends on `pi-extension-utils ^0.3.1`.
- `/Users/blaz/Programming_local/Projects/pi-extensions/pi-extension-utils` — shared utils repo; published `0.3.1` contains `paneOverlay`.

## Suggested skills / modes

- `qa-validation` — for gates and live smoke after UI/runtime changes.
- `design` — for user-facing dashboard/overlay polish, legend wording, hierarchy/readability.
- `pi-charter` — for the next multi-step arc (workflow durability, notification reliability, or agent-manager migration).
- `cartography` — only if future refactors split major files or move modules again.

## Gotchas

- Full test suite had a one-off order/flaky failure earlier in `subagents-status` but passed on rerun; do not overreact without reproduction.
- `node_modules/pi-extension-utils` was vendored temporarily during local testing; final commit uses npm `0.3.1` and lockfile points to registry.
- `~/.pi/agent/subagent.json` previously had a trailing comma and caused config fallback weirdness; it was fixed during the session, but future config edits should be JSON-validated.
- The root-role fix is safety-critical: do not regress to hardcoded persona fallbacks.
- `paneOverlay` close behavior is one-shot/idempotent; old dashboard tests expected repeated `done` calls. Wrapper currently preserves user-facing close enough, but do not rely on duplicate close callbacks as a product behavior.
