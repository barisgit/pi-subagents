# src/workflow/

## Responsibility
Workflow orchestration tool layer for model-authored JavaScript control flow over subagents. It provides the `workflow` tool, sandbox globals (`meta`, `agent`, `parallel`, `pipeline`, `phase`), live/final progress shaping, optional declarative workflow metadata, and durable group lifecycle/script markers used by dashboards and async status surfaces.

- `workflow.ts` — implements `runWorkflowScript()` and `createWorkflowTool()`: sandboxed JS execution, failure attribution, first/once `meta()` declaration, orchestration globals, progress emission, sync/async workflow execution, and result/error shaping.
- `workflow-group-state.ts` — validated, best-effort persistence for workflow group lifecycle, canonical current phase, and bounded deduplicated reached-phase history (`workflow-group.json`), plus the additive `{ script, meta? }` workflow record (`workflow-script.json`) without making the group look like a leaf run.

## Design
`workflow.ts` combines a restricted `node:vm` sandbox with host-owned dispatch adapters. Scripts see five globals: optional first/once `meta({ name, description, phases })` (phase title strings or `{ title, detail? }` objects), `agent(role, task, opts?)`, `parallel(thunks)`, `pipeline(items, ...stages)`, and `phase(title)`. `agent()` normalizes child dispatch results into `SubmitResultEnvelope` success values or `WorkflowAgentError` failures and can validate a workflow-authored result schema. `parallel()` wraps thunks in `AsyncLocalStorage` group IDs so concurrent child runs can be grouped and the live renderer can reserve denominator slots before every child has started; `pipeline()` streams each item through async stages without inserting a whole-stage barrier.

Unhandled rejection containment is process-wide and reload-safe: a singleton registry stored on `globalThis` installs permanent `unhandledRejection` / `rejectionHandled` listeners, uses `Symbol.for("pi.subagents.workflow.runToken")` plus an issued-token `WeakSet` to attribute floated `WorkflowAgentError`s, and tracks host-created `TrackingPromise` instances in a per-run `owned` set. The runtime deterministically drains all workflow-created promises, then fails the workflow if an attributable promise was left unhandled.

Progress is represented by `WorkflowPhaseEmitter`, a callable phase function augmented with state methods. It keeps canonical `results`, `childPhases`, reached phase titles, and `pendingByGroup` maps, then builds a single `Details` snapshot for streaming frames plus sync and immediate async results. `workflow-group-state.ts` avoids `status.json`; workflow groups remain containers whose display status is synthesized from children plus lifecycle/current/reached-phase markers.

## Flow
1. `createWorkflowTool()` registers tool name `workflow`, parameters `{ script, async? }`, and instructions covering the sandbox contract, uncapped request-scaled fan-out, overlapping plain-subagent and Workflow use, and freely composable orchestration patterns without a default topology.
2. On execute, the tool opens an optional `WorkflowGroupHandle`, persists the script to `asyncDir` with `writeWorkflowScript()`, creates a `WorkflowPhaseEmitter`, and builds a dispatch bridge.
3. `runWorkflowScript()` creates a VM context containing `agent`, `parallel`, `pipeline`, and `phase`; each `agent()` call dispatches either through the workflow group (`group.dispatchChild`) or an injected dispatch callback.
4. Child start increments `childIndex`, records phase/parallel metadata, emits a running placeholder, and dispatches the child. Child settlement replaces the placeholder with the final `SingleResult` and emits an updated details snapshot.
5. `parallel(thunks)` allocates a UUID group, announces expected size, executes thunks once inside `AsyncLocalStorage`, dispatch-tags nested `agent()` calls with `parallelGroupId`, and reaps phantom pending slots after all group members settle. `pipeline(items, ...stages)` similarly tags each stage with a group while allowing each item to advance to its next stage as soon as that item is ready.
6. Sync workflows await `runWorkflowScript()` and return the script value as text plus `emitter.snapshot()` details. Async workflows start `run()` in the background, immediately return a running async details payload, and later call `finishAsync()` or `failWorkflow()` with current phase tags.
7. Any raw workflow-level error is caught by the tool, optionally recorded as a synthetic failed workflow child through `group.failWorkflow()`, and returned as an error result without invalid `Details` shape.

## Integration
- Consumed by `../dispatch/subagent-tool.ts` / runtime registration as the `workflow` tool.
- Dispatches through `WorkflowGroupHandle` implementations supplied by the subagent executor/async record layer; child results use `SingleResult`, `AgentProgress`, `Details`, and `SubmitResultEnvelope` protocol shapes.
- Uses `../surfaces/async-guidance.ts` to format async return guidance and status hints.
- Persists group script, lifecycle, and current phase via `workflow-group-state.ts` for dashboard/status readers; marker writes are best-effort and must never fail a workflow.
- Live rendering relies on `Details.mode = "parallel"`, `workflow: true`, ordered `results`, derived `progress`, `agentGroups`, optional `expectedAgents`, `label`, `runId`, `asyncId`, and `asyncDir` fields.
