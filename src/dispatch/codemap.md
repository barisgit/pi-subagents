# src/dispatch/

## Responsibility

Subagent dispatch and child-agent execution layer for the pi-subagents extension. This folder owns the full lifecycle of running a child agent: tool entrypoint, input preparation, run-record creation, the sync/async/parallel execution paths, the in-process agent session bridge, the per-activation child registry, cwd routing, model fallback, resume, and inter-agent communication. Run-state persistence lives in `../state/`; contracts/types live in `../protocol/`.

## Design

- `subagent-executor.ts` is the orchestrator/router (the largest module): it exposes `executeInternal`/`execute`/`openWorkflowGroup` and routes each call to the correct execution path. It is deliberately thin on logic and delegates to the extracted path modules.
- Async mode is resolved in `subagent-executor.ts` after nested authorization/depth guards. Host calls preserve explicit/default async semantics; child-session subagent and Workflow calls are coerced to foreground execution so the caller owns the result and the existing parked-permit path prevents nested deadlock.
- Execution paths are extracted as pure `(data, deps)` functions: `run-async-path.ts` (detached async single + parallel; returns `null` when not async so the router falls through), `run-parallel-path.ts` (foreground parallel with per-run cwd resolution and shared foreground control), and `run-single-path.ts` (single foreground run). `resume-run.ts` handles resuming a prior run.
- Executor-side input handling and control verbs are extracted alongside: `dispatch-input.ts` (slim-input validation + run/count normalization, `validateSubagentToolInput`), `execution-input.ts` (execution-input validation, fork-reuse resolution, `withForkContext`/error-result builders), `interrupt-control.ts` (foreground status/interrupt targeting + async interrupt wait machinery).
- Type/helper homes were split to fix import direction and break cycles: `executor-types.ts` is a pure type leaf (dispatch path/step/model types); `executor-helpers.ts` holds runtime helper VALUES (`safeEmit`, `validationError`, `emptyUsage`, `normalizeAvailableModels` consumers, aggregate-completion + result-conversion builders); `child-step-runner.ts` builds and runs a single child step; `child-agent-registry.ts` is the in-memory `ChildAgentRegistry` (per-activation, NOT a global singleton; holds the live `RunView` mirror); `prepare-child-step.ts` assembles child config/model/tools before dispatch.
- `layer0-runs.ts` is the single run-record dispatch funnel: `openRunRecord` (formerly `openRunPersistence`) constructs the one `StatusWriter` and appends to the run registry for every variant (`group-child` | `sync-foreground` | `async-detached`).
- `in-process-executor.ts` runs children through the host `AgentSession` — async children run IN-PROCESS, not as subprocesses. Child loader/session construction runs inside `shared/child-session-context.ts` so concurrent extension activations remain session-scoped. The dispatch layer does not spawn child processes. `startChildAgent` (the single chokepoint all paths funnel through) acquires one leaf permit from `leaf-concurrency.ts` before prompting, publishes only created sessions through the listener-only process relay, and unpublishes/release-cleans when the child settles. Each attached session branch owns a `RunTranscriptPreviewWriter`: it writes the initial branch, coalesces event-driven updates over 50 ms, flushes at message/tool/agent/compaction boundaries, and disposes with a final flush before replacement or terminal cleanup. Fork reuse seeds canonical `session.jsonl` history and best-effort clones a validated `session.preview.json` sidecar for the target step.
- Concurrency: `leaf-concurrency.ts` is the process-global limit on active leaf agents (config `maxConcurrentAgents`, default 4), held in a `globalThis`+`Symbol.for` singleton so fresh in-process module instances share it. `openWorkflowGroup()` also creates a per-workflow admission semaphore at that same limit and acquires it before `spawnRun`, bounding direct-child run records as well as active sessions. Parents awaiting descendants park leaf permits (`runWhileParked`) to avoid nested deadlock. `concurrency-semaphore.ts` is the shared FIFO primitive; pipeline item-chain backpressure is owned by `workflow/`.
- Supporting modules: `foreground-run-controller.ts` (foreground lifecycle control wrapper), `model-fallback.ts` (`normalizeAvailableModels`, fallback model selection), `concurrency-semaphore.ts` (FIFO async semaphore primitive used by `leaf-concurrency.ts`), `parallel-utils.ts` (normalize/summarize parallel inputs), `fork-context.ts` (same-role fork prompt/context; one memoized persisted-parent branch per step, selected past the dispatching `subagent` call), `agent-scope.ts` (user/project/both scope resolution), `top-level-async.ts` (top-level async dispatch policy), `intercom-bridge.ts` (inter-agent comms instructions), `prompt-template-bridge.ts` (prompt-template delegation hooks), `subagent-prompt-runtime.ts` (PI_SUBAGENT_* prompt env + project-context/skills stripping), `resolve-tool-patterns.ts` (glob→regex tool-pattern expansion).

## Flow

1. Entry: `subagent-tool.ts` (`createSubagentToolDefinitions`) and `subagent-control.ts` register the `subagent` tool/control verbs against `subagent-executor`.
2. `executeInternal` resolves scope (`agent-scope`), prepares the child step (`prepare-child-step` → model via `model-fallback`, tools via `resolve-tool-patterns`, prompt via `subagent-prompt-runtime`/`fork-context`/`prompt-template-bridge`). `in-process-executor` lets Pi exhaust same-model retries, reopens the same persisted child history on ordered fallback models for provider failures, and keeps transport failures on the current model in an interruptible `waiting_network` loop with capped exponential backoff.
3. Run record opened through `layer0-runs.openRunRecord` (one `StatusWriter` + registry append).
4. Routed to a path: sync single → `child-step-runner`/`in-process-executor`; async → `run-async-path` (detached); foreground parallel → `run-parallel-path` (with per-run cwd resolution + `foreground-run-controller`); resume → `resume-run`. Every path's leaf execution is gated by `leaf-concurrency.ts` inside `startChildAgent`.
5. Child runs in-process via `in-process-executor` (host `AgentSession`); created/retried sessions are temporarily published to the host dashboard observer, results are recorded in `child-agent-registry` (live RunView mirror) and persisted via the StatusWriter, and `intercom-bridge` wires parent/child messaging. Each attached branch also drives a 50ms-coalesced transcript preview writer, with immediate/open, lifecycle-boundary, final, and disposal flushes; fork reuse clones the canonical session plus its validated preview sidecar. Separately, child session events are mirrored into progress updates: `tool_execution_update` partials set the `tool_streaming` phase and append nested partial text (`nestedPartialProgressText`, capped recent-output ring), emitted through `createProgressUpdateCoalescer` (300ms trailing edge; immediate first emit, flushed on `tool_execution_end`/`message_end`, stopped in `finally`) so update floods cannot spam `onUpdate`.

## Integration

- Consumed by: `../runtime/extension-runtime.ts` (constructs the registry + wires the tool) and `../surfaces/` slash/bridge entrypoints.
- Depends on: `../state/` (`status-writer`, `runs-registry`, `run-view`, `status-patch`, `session-paths`, `run-transcript-preview`), `../protocol/` (`types`, `status-types`, `schemas`, `submit-result`), `../shared/` (`agents`, `skills`, `runtime-env`, `control-policy`, `model`/settings).
- Cycle status: the executor↔path runtime cycles were eliminated (madge `--circular src/dispatch` = 0 dispatch-internal cycles) by moving types to `executor-types.ts` and helper values to `executor-helpers.ts`/`child-step-runner.ts`.

### File index

- `agent-scope.ts` — resolves requested agent scope (user/project/both) for dispatch.
- `child-agent-registry.ts` — per-activation in-memory `ChildAgentRegistry` holding the live `RunView` mirror + abort handles and exposing retained step sessions in order for live dashboard rendering (not a singleton; does not survive reload).
- `child-step-runner.ts` — builds and runs a single child step (`buildAsyncChildStep`, `runInProcessChildStep`, result conversion); also exports `createProgressUpdateCoalescer`, the trailing-edge emit throttle that coalesces `tool_execution_update` progress emits (injectable timer fns for tests).
- `concurrency-semaphore.ts` — FIFO async semaphore primitive (`acquire`→permit `release`/`runWhileParked`); used by active-leaf, workflow-child-admission, and pipeline item-chain limits.
- `leaf-concurrency.ts` — process-global active-leaf concurrency pool (`globalThis`+`Symbol.for`; `maxConcurrentAgents`, default 4); `acquireLeafPermit`/`parkLeafPermit` gate all dispatch paths at `startChildAgent`, while workflows reuse the resolved limit for pre-run admission.
- `executor-helpers.ts` — runtime helper values: emit/validation/usage helpers + aggregate-completion and result-conversion builders.
- `executor-types.ts` — pure type leaf for dispatch path/step/model types.
- `foreground-run-controller.ts` — wraps foreground run lifecycle control (set/start/end) for sync + parallel paths.
- `fork-context.ts` — resolves and memoizes one persisted-parent branch per step, selects a safe leaf past the dispatching `subagent` tool call, and supplies inherited branch context for fork-reuse seeding.
- `in-process-executor.ts` — runs child agents through the host `AgentSession`, publishes each created/reopened live session to current observers, owns each attached branch's coalesced preview writer through final disposal, and seeds fork-reuse `session.jsonl` plus validated `session.preview.json` history (async children run in-process).
- `intercom-bridge.ts` — injects inter-agent communication instructions and orchestrator targeting.
- `layer0-runs.ts` — single run-record dispatch funnel (`openRunRecord`, `spawnRun`, `openGroup`, `finalizeRun`).
- `model-fallback.ts` — available-model normalization, ordered candidate selection, and separate provider-fallback versus no-response transport error classification.
- `parallel-utils.ts` — normalizes and summarizes parallel dispatch inputs.
- `prepare-child-step.ts` — assembles child config/model/tools/prompt before dispatch.
- `prompt-template-bridge.ts` — registers prompt-template delegation hooks.
- `resolve-tool-patterns.ts` — converts simple `*` glob tool patterns to RegExp and expands allowed tools.
- `resume-run.ts` — resumes a prior run (single-child resume path, hand-built completion payload).
- `dispatch-input.ts` — slim-input validation + dispatch-param/count normalization (`validateSubagentToolInput`, `normalizeRunDispatchParams`).
- `execution-input.ts` — execution-input validation, requested-agent collection, fork-reuse resolution, `withForkContext`/error-result builders.
- `interrupt-control.ts` — foreground status/interrupt helpers + async interrupt wait machinery (`interruptAsyncRun`, `interruptAllAsyncRuns`).
- `run-async-path.ts` — detached async single + parallel dispatch path; returns `null` when not async.
- `run-parallel-path.ts` — foreground parallel dispatch with per-run cwd resolution and shared foreground control.
- `run-single-path.ts` — single foreground run dispatch path (`runSinglePath`).
- `subagent-control.ts` — formats foreground control + notification/attention events and control verbs.
- `subagent-executor.ts` — orchestrator/router: `executeInternal`/`execute`/`openWorkflowGroup`, routes to the path modules.
- `subagent-prompt-runtime.ts` — PI_SUBAGENT_* prompt env constants + project-context/skills strip helpers.
- `subagent-tool.ts` — `createSubagentToolDefinitions`: registers the public `subagent` tool against the executor.
- `top-level-async.ts` — enforces top-level async dispatch policy (`AsyncOverrideParams`).
