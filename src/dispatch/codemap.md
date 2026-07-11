# src/dispatch/

## Responsibility

Subagent dispatch and child-agent execution layer for the pi-subagents extension. This folder owns the full lifecycle of running a child agent: tool entrypoint, input preparation, run-record creation, the sync/async/parallel execution paths, the in-process agent session bridge, the per-activation child registry, worktree isolation, model fallback, resume, and inter-agent communication. Run-state persistence lives in `../state/`; contracts/types live in `../protocol/`.

## Design

- `subagent-executor.ts` is the orchestrator/router (the largest module): it exposes `executeInternal`/`execute`/`openWorkflowGroup` and routes each call to the correct execution path. It is deliberately thin on logic and delegates to the extracted path modules.
- Execution paths are extracted as pure `(data, deps)` functions: `run-async-path.ts` (detached async single + parallel; returns `null` when not async so the router falls through) and `run-parallel-path.ts` (foreground parallel with worktree setup/cleanup and shared foreground control). `resume-run.ts` handles resuming a prior run.
- Type/helper homes were split to fix import direction and break cycles: `executor-types.ts` is a pure type leaf (dispatch path/step/model types); `executor-helpers.ts` holds runtime helper VALUES (`safeEmit`, `validationError`, `emptyUsage`, `normalizeAvailableModels` consumers, aggregate-completion + result-conversion builders); `child-step-runner.ts` builds and runs a single child step; `child-agent-registry.ts` is the in-memory `ChildAgentRegistry` (per-activation, NOT a global singleton; holds the live `RunView` mirror); `prepare-child-step.ts` assembles child config/model/tools before dispatch.
- `layer0-runs.ts` is the single run-record dispatch funnel: `openRunRecord` (formerly `openRunPersistence`) constructs the one `StatusWriter` and appends to the run registry for every variant (`group-child` | `sync-foreground` | `async-detached`).
- `in-process-executor.ts` runs children through the host `AgentSession` — async children run IN-PROCESS, not as subprocesses. Child loader/session construction runs inside `shared/child-session-context.ts` so concurrent extension activations remain session-scoped. `worktree.ts` is the ONLY `child_process` spawn in the codebase (git worktree add/remove). `startChildAgent` (the single chokepoint all paths funnel through) acquires one leaf permit from `leaf-concurrency.ts` before prompting and releases it when the child settles.
- Concurrency: `leaf-concurrency.ts` is the ONE per-process limit on concurrently executing leaf agents (config `maxConcurrentAgents`, default 4), held in a `globalThis`+`Symbol.for` singleton so it is shared across the fresh module instances each in-process child loads. It uses `concurrency-semaphore.ts` (a FIFO async semaphore). MAX-LEAF semantics: a parent awaiting its own children parks its permit (`runWhileParked`) at every nested-dispatch seam (subagent parallel/single, foreground resume, sync workflow), so the pool cannot deadlock. There are NO per-call or per-batch concurrency knobs; sync parallel still uses `mapConcurrent` for ordered aggregation but unbounded (the leaf gate bounds).
- Supporting modules: `foreground-run-controller.ts` (foreground lifecycle control wrapper), `model-fallback.ts` (`normalizeAvailableModels`, fallback model selection), `concurrency-semaphore.ts` (FIFO async semaphore primitive used by `leaf-concurrency.ts`), `parallel-utils.ts` (normalize/summarize parallel inputs), `fork-context.ts` (same-role fork prompt/context), `agent-scope.ts` (user/project/both scope resolution), `top-level-async.ts` (top-level async dispatch policy), `intercom-bridge.ts` (inter-agent comms instructions), `prompt-template-bridge.ts` (prompt-template delegation hooks), `subagent-prompt-runtime.ts` (PI_SUBAGENT_* prompt env + project-context/skills stripping), `resolve-tool-patterns.ts` (glob→regex tool-pattern expansion).

## Flow

1. Entry: `subagent-tool.ts` (`createSubagentToolDefinitions`) and `subagent-control.ts` register the `subagent` tool/control verbs against `subagent-executor`.
2. `executeInternal` resolves scope (`agent-scope`), prepares the child step (`prepare-child-step` → model via `model-fallback`, tools via `resolve-tool-patterns`, prompt via `subagent-prompt-runtime`/`fork-context`/`prompt-template-bridge`).
3. Run record opened through `layer0-runs.openRunRecord` (one `StatusWriter` + registry append).
4. Routed to a path: sync single → `child-step-runner`/`in-process-executor`; async → `run-async-path` (detached); foreground parallel → `run-parallel-path` (with `worktree` + `foreground-run-controller`); resume → `resume-run`. Every path's leaf execution is gated by `leaf-concurrency.ts` inside `startChildAgent`.
5. Child runs in-process via `in-process-executor` (host `AgentSession`); results recorded in `child-agent-registry` (live RunView mirror) and persisted via the StatusWriter; `intercom-bridge` wires parent/child messaging.

## Integration

- Consumed by: `../runtime/extension-runtime.ts` (constructs the registry + wires the tool) and `../surfaces/` slash/bridge entrypoints.
- Depends on: `../state/` (`status-writer`, `runs-registry`, `run-view`, `status-patch`, `session-paths`), `../protocol/` (`types`, `status-types`, `schemas`, `submit-result`), `../shared/` (`agents`, `skills`, `runtime-env`, `control-policy`, `model`/settings).
- Cycle status: the executor↔path runtime cycles were eliminated (madge `--circular src/dispatch` = 0 dispatch-internal cycles) by moving types to `executor-types.ts` and helper values to `executor-helpers.ts`/`child-step-runner.ts`.

### File index

- `agent-scope.ts` — resolves requested agent scope (user/project/both) for dispatch.
- `child-agent-registry.ts` — per-activation in-memory `ChildAgentRegistry` holding the live `RunView` mirror + abort handles (not a singleton; does not survive reload).
- `child-step-runner.ts` — builds and runs a single child step (`buildAsyncChildStep`, `runInProcessChildStep`, result conversion).
- `concurrency-semaphore.ts` — FIFO async semaphore primitive (`acquire`→permit `release`/`runWhileParked`); used by `leaf-concurrency.ts`.
- `leaf-concurrency.ts` — the one per-process leaf-agent concurrency pool (`globalThis`+`Symbol.for` singleton; `maxConcurrentAgents`, default 4); `acquireLeafPermit`/`parkLeafPermit` gate all dispatch paths at `startChildAgent`.
- `executor-helpers.ts` — runtime helper values: emit/validation/usage helpers + aggregate-completion and result-conversion builders.
- `executor-types.ts` — pure type leaf for dispatch path/step/model types.
- `foreground-run-controller.ts` — wraps foreground run lifecycle control (set/start/end) for sync + parallel paths.
- `fork-context.ts` — builds same-role fork prompts and inherited context.
- `in-process-executor.ts` — runs child agents through the host `AgentSession` (async children run in-process).
- `intercom-bridge.ts` — injects inter-agent communication instructions and orchestrator targeting.
- `layer0-runs.ts` — single run-record dispatch funnel (`openRunRecord`, `spawnRun`, `openGroup`, `finalizeRun`).
- `model-fallback.ts` — `normalizeAvailableModels` + fallback model selection for children.
- `parallel-utils.ts` — normalizes and summarizes parallel dispatch inputs.
- `prepare-child-step.ts` — assembles child config/model/tools/prompt before dispatch.
- `prompt-template-bridge.ts` — registers prompt-template delegation hooks.
- `resolve-tool-patterns.ts` — converts simple `*` glob tool patterns to RegExp and expands allowed tools.
- `resume-run.ts` — resumes a prior run (single-child resume path, hand-built completion payload).
- `run-async-path.ts` — detached async single + parallel dispatch path; returns `null` when not async.
- `run-parallel-path.ts` — foreground parallel dispatch with worktree setup/cleanup and shared foreground control.
- `subagent-control.ts` — formats foreground control + notification/attention events and control verbs.
- `subagent-executor.ts` — orchestrator/router: `executeInternal`/`execute`/`openWorkflowGroup`, routes to the path modules.
- `subagent-prompt-runtime.ts` — PI_SUBAGENT_* prompt env constants + project-context/skills strip helpers.
- `subagent-tool.ts` — `createSubagentToolDefinitions`: registers the public `subagent` tool against the executor.
- `top-level-async.ts` — enforces top-level async dispatch policy (`AsyncOverrideParams`).
- `worktree.ts` — creates/cleans isolated git worktrees (the only `child_process` spawn in the codebase).
