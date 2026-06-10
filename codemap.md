# Code map

## Entry point
- `index.ts` — root extension entry point; registers tools, slash commands, notifications, widgets, and async/status APIs while importing implementation from `src/`.

## `src/dispatch/`
- `agent-scope.ts` — validates same-role fork scope and inherited agent context.
- `agent-selection.ts` — resolves requested agent personas for dispatch.
- `concurrency-semaphore.ts` — bounds parallel child starts.
- `fork-context.ts` — builds forked same-agent prompts and context.
- `in-process-executor.ts` — runs child agents through the host process bridge.
- `intercom-bridge.ts` — injects inter-agent communication instructions.
- `layer0-runs.ts` — handles layer-zero run lifecycle helpers.
- `model-fallback.ts` — chooses fallback models for child agents.
- `parallel-utils.ts` — normalizes and summarizes parallel dispatch inputs.
- `prompt-template-bridge.ts` — registers prompt-template delegation hooks.
- `resolve-tool-patterns.ts` — expands allowed tool pattern configuration.
- `sdk-0.75-compat.ts` — adapts older SDK event/result shapes.
- `subagent-control.ts` — formats foreground control and notification events.
- `subagent-executor.ts` — orchestrates subagent runs, async/background mode, worktrees, progress, and resume.
- `subagent-prompt-runtime.ts` — prepares runtime prompt sections for children.
- `top-level-async.ts` — enforces top-level async dispatch policy.
- `worktree.ts` — creates and cleans isolated worktree execution roots.

## `src/state/`
- `async-status.ts` — stores async status and completion metadata.
- `completion-dedupe.ts` — prevents duplicate completion notices.
- `lineage.ts` — tracks parent/child lineage for nested runs.
- `run-history.ts` — records historical run entries.
- `run-liveness.ts` — classifies silent, stuck, and attention-needed runs.
- `run-phase.ts` — formats phase/progress labels.
- `run-shape.ts` — centralizes single and parallel run display shape.
- `run-status.ts` — inspects current run status for tools and slash commands.
- `run-transcript.ts` — persists transcript snippets for completed runs.
- `runs-registry.ts` — reads and writes run registry records.
- `session-paths.ts` — resolves session-scoped storage paths.
- `session-tokens.ts` — tracks session token accounting.
- `slash-live-state.ts` — snapshots slash-command live render state.
- `status-writer.ts` — writes status files for active runs.
- `sync-run-persistence.ts` — persists foreground run results.
- `usage-totals.ts` — aggregates token and usage totals.

## `src/surfaces/`
- `agent-management.ts` — applies create/edit/archive actions to agent definitions.
- `agent-manager-detail.ts` — renders agent detail views.
- `agent-manager-edit.ts` — renders agent editing flows.
- `agent-manager-list.ts` — renders agent list views.
- `agent-manager-parallel.ts` — renders parallel manager interactions.
- `agent-manager.ts` — coordinates the Agents Manager TUI.
- `agent-serializer.ts` — serializes agent markdown/frontmatter.
- `agent-templates.ts` — supplies built-in agent templates.
- `async-guidance.ts` — formats user guidance for async/background runs.
- `async-job-tracker.ts` — tracks async jobs for widget display.
- `formatters.ts` — formats durations, paths, and display text.
- `idle-tracker.ts` — observes idle/notification thresholds.
- `notify.ts` — registers subagent completion and attention notifications.
- `render-helpers.ts` — shared TUI rendering helpers.
- `render.ts` — renders run progress, results, and widgets.
- `single-output.ts` — formats single-run output blocks.
- `slash-bridge.ts` — connects slash-command subagent dispatch.
- `slash-commands.ts` — registers `/run`, `/chain`, `/parallel`, and manager commands.
- `subagents-status.ts` — renders aggregate subagent status.
- `text-editor.ts` — supports inline text editing interactions.

## `src/workflow/`
- `workflow-group-state.ts` — tracks grouped workflow child state.
- `workflow.ts` — exposes JavaScript workflow orchestration over subagents.

## `src/protocol/`
- `schemas.ts` — defines public tool input schemas.
- `submit-result.ts` — implements the child completion tool contract.
- `types.ts` — declares shared wire/API types.

## `src/shared/`
- `agents.ts` — discovers agent markdown files and persona directories.
- `artifacts.ts` — manages artifact directory paths and cleanup.
- `current-pi.ts` — stores the active Pi host reference.
- `file-coalescer.ts` — coalesces child output files.
- `frontmatter.ts` — parses and writes markdown frontmatter.
- `logger.ts` — writes extension diagnostic logs.
- `settings.ts` — resolves extension and per-agent settings.
- `skills.ts` — discovers skills and resolves skill paths.
- `utils.ts` — shared text, filesystem, and helper utilities.

## Tests
- `test/unit/` — unit tests, including source layout validation and path-resolution coverage.
- `test/integration/` — integration tests run with the TypeScript loader hook.
- `test/support/` — shared test helpers and loader/isolation hooks.
- `test/fixtures/` — reusable test fixture files.

## Scripts
- `scripts/` — local gates and maintenance scripts, including TypeScript baseline checking and source-vocabulary validation.
