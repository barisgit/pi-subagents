# Migration

This is the one-release reference for rewriting legacy subagent calls to the slim schema. The runtime intentionally has no compatibility aliases or shims.

## Field mapping

| Old field | New shape | Notes |
| --- | --- | --- |
| `model` | agent file config | Per-call model choice was removed; configure the agent instead. |
| `tasks` | `run` | Each old task becomes a `Task` in `run`. |
| `prompt` | `message` or `task` | Use `message` for shared framing/resume; use `task` for work text. |
| `clarify` | removed | Clarification UI is not in the slim dispatch contract. |
| `share` | removed | Sharing is an internal/debug workflow. |
| `preset` | agent/runtime config | Preset choice is policy, not dispatch input. |
| `sessionDir` | removed | Session storage paths are internal. |
| `control` | `action` + `id` | Use explicit control verbs at top level. |
| `skill` | agent definition | Skill loading policy belongs to agent definitions and docs. |
| `chainDir` | removed | Chain artifact storage is internal. |
| `artifacts` | `output` | Request a task output path/boolean, not artifact collection flags. |
| `progress` | status views | Progress is runner-owned; inspect with `action:"status"`. |
| `agentScope` | `action:"list"` output/config | Discovery scope is operator policy, not per-call input. |
| `includeInternal` | removed | Internal personas are not advertised in the slim surface. |
| `metadata` | task/message text or integration API | Arbitrary metadata was removed to avoid hidden coupling. |
| `cwd` | parent process cwd | Working directory is owned by the caller/session. |
| `reads` | mention files in `task` | Future `@-mention` loading may replace this. |
| `includeProgress` | `action:"status"` | Status responses own progress detail. |

## Renamed and reshaped calls

| Legacy shape | Slim shape |
| --- | --- |
| `{ agent, task }` | `{ run:[{ agent, task }] }` |
| `{ tasks:[...] }` | `{ run:[...] }` |
| `{ prompt:"Review {in}", tasks:[...] }` | `{ message:"Review {task}", run:[...] }` |
| `{ sequential:true, tasks:[...] }` | `{ chain:true, run:[...] }` |
| `{ chain:[...] }` | `{ chain:true, run:[...] }` |
| `{ chain:[{ parallel:[a,b] }] }` | `{ chain:true, run:[[a,b]] }` |
| `{ context:"fork", agent, task }` | `{ run:[{ agent, task, context:"fork" }] }` |
| `{ action:"status", runId }` | `{ action:"status", id }` |
| `{ action:"resume", runId, prompt }` | `{ action:"resume", id, message }` |

## Removed CRUD verbs

| Old verb | Replacement |
| --- | --- |
| `create` | Write an agent definition file under `agents/<name>.md` or the project/user agent directory. |
| `update` | Edit the agent definition file. |
| `delete` | Delete the agent definition file. |
| `get` | Read the agent file directly, or use `action:"list"` / `action:"status"` for runtime views. |
