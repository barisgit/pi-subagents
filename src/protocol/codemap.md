# src/protocol/

## Responsibility

Protocol/vocabulary layer for pi-subagents: pure DTOs, wire/API contracts, TypeBox tool schemas, status.json persisted shapes, inter-extension event names/payloads, and child completion contract. This folder should not own filesystem/runtime policy; `types.ts` was purified so runtime paths such as `RUNS_DIR` and runtime-env policy live under `src/shared/`.

- `types.ts` — shared wire/API types: `Details`, `Usage`/`TokenUsage`, `AgentConfig`-adjacent preset/surface/config vocabulary (including `maxConcurrentAgents` and `workflow.maxPipelineItemsInFlight`), `AgentSurface`, async job/control/progress DTOs, intercom/subagent event constants, truncation helpers, depth/fork helpers, identity env helpers, and legacy nested-delegator allow sets.
- `status-types.ts` — canonical persisted status vocabulary: `RunPhase` (including `waiting_network`), `ChildAgentResult` with final/attempted model reporting, `LiveStepProgress`, `PersistedRunStep`, `PersistedRunStatus`, `StatusPatch`, and the disk-boundary codec `parsePersistedRunStatus(raw): { ok: true; value } | { ok: false; reason }`.
- `schemas.ts` — public `subagent` tool input schemas and matching static types: `TaskSchema`/`StepSchema`, `SubagentParams`, `Task`, `Step`, `SubagentToolInput`, plus slim back-compat schema export names.
- `output-contract.ts` — child completion contract via a trailing `<output>...</output>` prose delimiter (no finish tool): `SubmitResultEnvelope` (the persisted structured carrier), last-block extraction (`extractOutputBlock`/`hasOutputBlock`), the disk-boundary codec `parseOutputEnvelope(text, schema?)`, the universal system-prompt contract that identifies the block as the only parent-visible content and requires a complete self-contained handoff (`OUTPUT_SYSTEM_INSTRUCTION`/`buildOutputContractAppend`/`renderSchemaInstruction`), the reactive `OUTPUT_REPROMPT`/`schemaReprompt`, and the no-schema text fallback (the schema path fails the run closed instead).
- `workflow-meta.ts` — canonical `WorkflowMeta`/`WorkflowPhaseMeta` vocabulary and the validating `parseWorkflowMeta` codec used at VM and disk boundaries.

## Design

- Keep this layer serializable and vocabulary-first: contracts are plain TypeScript interfaces/types, constants, TypeBox JSON schemas, and small pure helpers.
- `status-types.ts` is the one canonical status.json type home. `PersistedRunStatus` + `PersistedRunStep` + `LiveStepProgress` unify former `AsyncStatus` and `StatusPayload`; divergent writer fields are optional so async and foreground/sync writers can share one persisted shape without changing existing bytes.
- `parsePersistedRunStatus` is the validated disk-boundary codec: malformed JSON returns `{ ok:false, reason:"invalid-json" }`; bad shape returns `{ ok:false, reason:"invalid-shape" }`; valid shape returns `{ ok:true, value }`. It validates required persisted fields (`runId`, `mode`, `state`, `startedAt`) and `steps` array-ness before downstream code trusts disk data.
- `output-contract.ts` makes structured child completion authoritative from the LAST `<output>` block in the final assistant message: `parseOutputEnvelope` extracts that block and, when a workflow supplies a schema, TypeBox-validates it. Resolution differs by path: with NO schema the block text is the result and a missing block falls back to the last assistant text (the default string contract); WITH a schema a missing/invalid block FAILS THE RUN CLOSED (exit 1, `error.reason = "schema_validation"`) after bounded reprompts, so a workflow never receives unvalidated text. The producer changed (a prose delimiter, not a tool result) but the persisted `SubmitResultEnvelope` `{ result }` carrier is unchanged.
- `parseWorkflowMeta` accepts phase title strings or `{ title, detail? }` objects, clones them into canonical host-owned objects, trims display strings, rejects C0/C1 controls with field-specific errors, canonicalizes phase prefixes, and rejects duplicate canonical phase titles.
- `schemas.ts` intentionally keeps the public tool surface small: dispatch/control fields only (`run`, `async`, `batch`, `cwd`, `message`, `action`, `id`) and per-task `agent`, `task`, `label`, `context`, `cwd`, `output`; `additionalProperties:false` at both task and top level.
- Known baseline: madge reports a pre-existing `protocol/types.ts` <-> `protocol/status-types.ts` type cycle (`types.ts` imports `RunPhase`; `status-types.ts` imports `ActivityState`, `ModelAttempt`, `RunDisplayState`, `TokenUsage`, `Usage`). It is documented as an existing baseline, not a new protocol responsibility.

## Flow

- Public callers submit `SubagentParams` (`schemas.ts`) to the subagent tool; runtime converts validated `SubagentToolInput`/`Step` data into dispatch execution.
- Dispatch/runtime populate `Details` and `SingleResult` (`types.ts`) for foreground returns, including per-step `Usage`, progress summaries, artifacts/truncation metadata, nested `children`, and optional structured child result (`SubmitResultEnvelope`, parsed from the child's `<output>` block).
- Status writers and in-process child registries exchange `StatusPatch`/`ChildAgentResult` (`status-types.ts`), persist the unified `PersistedRunStatus` shape, and stamp live `RunPhase`/`LiveStepProgress` for widget parity with inline rendering.
- Disk readers route raw status.json through `parsePersistedRunStatus` before hydrating run views; invalid or partial status files fail closed instead of being cast as trusted status.
- Child agents finish by ending their final message with a trailing `<output>...</output>` block (`output-contract.ts`); the agent loop terminates naturally on an assistant turn with no tool call. Extraction takes the LAST `<output>` block; a missing/invalid block triggers `OUTPUT_REPROMPT` and otherwise falls back to text with `fallbackSubmitResultEnvelope`.

## Integration

- `dispatch/` consumes `schemas.ts` types for tool inputs, `types.ts` DTOs for results/progress/config, `status-types.ts` for child lifecycle/status patches, and `output-contract.ts` for child completion enforcement/extraction.
- `state/` is the status persistence/reader side: `StatusWriter` writes `PersistedRunStatus`; `shared/utils.ts`/run-view hydration read via `parsePersistedRunStatus`; status surfaces consume `RunPhase`, `PersistedRunStep`, and `PersistedRunStatus` without redefining disk shapes.
- `surfaces/` render protocol DTOs (`Details`, `SingleResult`, `AgentProgress`, async job/control/event payloads) and should treat this folder as vocabulary, not presentation ownership.
- `api/` and other extensions integrate through `SubagentExposedAPI`, `SubagentLineage`, persona-dir events, async complete/start events, and identity env helpers from `types.ts`.
- `shared/` owns moved runtime/path policy (`RUNS_DIR`, runtime-env concerns); protocol imports should not reintroduce filesystem or runtime-path ownership here.
