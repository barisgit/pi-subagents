# Subagent schema decisions

## Goal & non-goals

The goal is to hard-cut the LLM-facing subagent tool surface to a small, teachable contract: a ≤700-token tool description, one dispatch shape based on `run`, file-based agent authoring, no model-facing agent CRUD, and only the knobs needed for dispatch, control, context, batching, concurrency, worktrees, and output capture. The non-goal is backward compatibility: this charter intentionally provides no shim layer, no legacy aliases, and no gradual migration path in runtime code.

## Baseline (pre-charter)

The baseline version is recorded before any charter version bump so f12 can prove a major-version increase without relying on git history.

```text
pi-subagents@0.18.1 → bumping to 1.0.0
```

## Kept fields

Post-charter input keeps only the fields below.

### Top-level fields

| Field | Description | Default |
| --- | --- | --- |
| `run` | Array of work steps to dispatch; each step is a `Task`, and in chain mode a step may be `Task[]` for a parallel sub-step. | Omitted unless dispatching work. |
| `chain` | Runs `run` sequentially and threads `{previous}` between steps; when false, `run` items dispatch in parallel. | `false` |
| `async` | Starts work in the background and returns a run identifier instead of waiting for completion. | `false` |
| `batch` | Collapses completion notifications for a multi-task dispatch into one rollup. | `false` |
| `concurrency` | Caps how many parallel tasks run at once. | Runtime default when omitted. |
| `worktree` | Applies isolated worktree execution to every task. | `false` |
| `message` | Shared dispatch framing string, or the next user message for `action:"resume"`. | Omitted. |
| `action` | Control verb: `list`, `status`, `interrupt`, or `resume`. | Omitted for dispatch. |
| `id` | Identifier used by control verbs; batch/run id for status or interrupt, run id for resume. | Required only for actions that target a run. |

### Step shape

| Shape | Description | Default |
| --- | --- | --- |
| `Task` | A single subagent invocation. | Required element of `run`. |
| `Task[]` | A parallel sub-step inside `chain:true`; all members run before the next step receives merged `{previous}`. | Only valid inside chained dispatch. |

### Task fields

| Field | Description | Default |
| --- | --- | --- |
| `agent` | Agent persona to invoke, such as `fixer`, `explorer`, `qa`, or a project-defined agent. | Required. |
| `task` | Concrete instruction for that agent. | Required. |
| `label` | Short human-readable label for status and notifications. | Derived from task text when omitted. |
| `context` | Context mode: `fresh` starts clean; `fork` is same-role only and inherits the parent context. | `fresh` |
| `worktree` | Top-level only; per-task override is not accepted. | Use top-level `worktree`. |
| `output` | Requests a saved output artifact path, or disables/specializes output capture with a boolean/string. | Runtime default when omitted. |

## Dropped fields

Every dropped field is absent from the runtime schema, validator, and LLM-facing description after the hard cut.

- `model` — removed because per-call model choice is a cost and quality footgun; model routing belongs in agent configuration.
- `tasks` — collapsed into `run` so single, parallel, swarm, and chain dispatch all start from one shape.
- `prompt` — renamed to `message` so dispatch framing and resume follow-up use the same plain user-turn term.
- `clarify` — removed because clarification UI is not part of the minimal dispatch contract.
- `share` — removed because publishing or gist behavior is an internal/debug workflow, not a model-facing control.
- `preset` — removed because preset selection duplicates model/runtime policy outside the task contract.
- `sessionDir` — removed because raw session storage paths are internal implementation details.
- `control` — removed as a nested control object; explicit `action` plus `id` is the only model-facing control surface.
- `skill` — removed because skill loading policy is internal to agent definitions and progressive-disclosure docs.
- `chainDir` — removed because chain artifact storage is internal and should not be steered by the model.
- `artifacts` — removed because artifact collection is an execution detail, not a dispatch input.
- `progress` — removed because progress tracking belongs to the runner and status views.
- `agentScope` — removed because agent discovery scope is an operator concern, not a per-dispatch model knob.
- `includeInternal` — removed because internal personas are not advertised through the slim tool surface.
- `metadata` — removed because arbitrary metadata invites hidden coupling and compatibility shims.
- `cwd` — removed because working directory is owned by the parent process or future file-based invocation patterns.
- `reads` — removed in favor of a future `@-mention` syntax for files that the model wants loaded first.

Dropped action verbs:

- `create` — removed from the tool; write an agent definition file instead.
- `update` — removed from the tool; edit the agent definition file instead.
- `delete` — removed from the tool; remove the agent definition file instead.
- `get` — removed from the tool; read the agent definition file or use the slim `list`/`status` controls.

## Renames

| Old surface | New surface | Rationale |
| --- | --- | --- |
| `prompt` | `message` | Uses the same user-turn term for shared dispatch context and resume follow-up. |
| `tasks` | `run` | Makes one array cover single, parallel, swarm-style, and chained dispatch. |
| top-level `task` | `run: [{ task }]` | Keeps the task text but removes a second dispatch entry point. |
| `sequential` | `chain` | Names the behavior users already need to reason about: ordered steps with `{previous}` threading. |
| `chain[].parallel[]` | `chain:true` with an inline `Task[]` step inside `run` | Removes a wrapper key while preserving parallel sub-steps inside chains. |
| top-level `context` | per-`Task` `context` | Makes fork/fresh selection explicit for each task in mixed dispatches. |
| `runId` | `id` | Reuses one identifier field for status, interrupt, and resume controls. |
| `prompt` for resume | `message` with `action:"resume"` | Keeps resume as another user message instead of a special prompt channel. |

## Token budget rationale

The 700-token ceiling is intentionally small enough that the tool description can stay in the active model context without crowding out the user's task, code snippets, or charter instructions. A slim description must teach only the canonical dispatch and control shapes; details that are useful only after the model has chosen a pattern belong in `skills/subagent/references/`. This budget also prevents drift back toward exposing internal flags as convenience documentation.

The limit is enforced by f9 with a deterministic `cl100k_base` tokenizer so token count does not depend on a particular developer's editor, wrapping, or model estimate. When the description grows, the test fails before the larger surface becomes doctrine.

## Compat policy

This charter is a hard cut. Runtime code accepts the new schema only, rejects removed fields and removed CRUD verbs, and does not translate old calls into new calls. The temporary migration guide lives at `skills/subagent/references/migration.md`; it documents old-to-new call rewrites for one release cycle while keeping the durable rationale here.

No shim means failures are explicit. A legacy call should return a structured error that points users to file-based agent definitions or to the migration guide, rather than silently guessing what the caller intended.

## Rejected alternatives

- Discriminated `Node = Task | Group` union — rejected as too complex for an LLM-facing API and too close to a workflow language.
- Flat `Node` with both `agent?` and `children?` — rejected as too clever because validity depends on which optional fields happen to appear together.
- Separate `tasks` and `parallel` flags — rejected for cognitive overhead; `run` length and `chain` already express the dispatch mode.
- Per-Task `model` override — rejected as a cost footgun and a policy leak from agent configuration into individual calls.
- Keeping `prompt` — rejected because it conflicts with the transport meaning of a user message and splits dispatch from resume terminology.
- Adding `inherit` as a context mode — rejected because it is vague about what is inherited; `fresh` and same-role `fork` are explicit.
- Boolean `fork` — rejected because it cannot grow to future context modes such as summarized context without another breaking shape change.
- Runtime backward-compat aliases — rejected because aliases would preserve the bloated surface and hide migration failures until later.
