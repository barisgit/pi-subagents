# Subagent schema decisions

## Goal & non-goals

The public `subagent` input stays small enough for reliable tool calling. It supports one bounded dispatch or a fixed independent parallel batch. Sequential or dependent orchestration is a `workflow` concern because workflow scripts can branch, retry, loop, and pass child results explicitly.

Non-goals: preserving legacy hidden aliases, accepting ambiguous orchestration shapes, or teaching removed dispatch modes in tool descriptions.

## Baseline

Baseline version: pi-subagents@0.8.0.

See `skills/subagent/references/migration.md` for caller migration notes.

## Kept fields

Kept top-level fields: `run`, `async`, `batch`, `concurrency`, `worktree`, `message`, `action`, and `id`.

Kept task fields: `agent`, `task`, `label`, `context`, and `output`.

## Dropped fields

Dropped top-level and legacy fields remain rejected by schema validation: `model`, `tasks`, `prompt`, `clarify`, `share`, `preset`, `sessionDir`, `control`, `skill`, `artifacts`, `progress`, `agentScope`, `includeInternal`, `metadata`, `cwd`, and `reads`.

## Renames

| Old | New |
| --- | --- |
| `prompt` | `message` |
| `tasks` | `run` |
| `parallel` | top-level multi-item `run` |

## Token budget rationale

Removing ambiguous aliases keeps the schema and description short. The tool definition should spend tokens on current dispatch shapes, async management, and when to use workflow.

## Compat policy

Removed fields are hard validation failures. Callers should update prompts and code instead of relying on compatibility shims.

## Rejected alternatives

- Keeping legacy aliases with silent normalization was rejected because it hides stale caller behavior.
- Adding another sequential dispatch shape was rejected because the `workflow` tool already handles dependent orchestration with explicit control flow.
