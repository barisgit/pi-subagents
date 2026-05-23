# Error modes

The schema is intentionally strict and rejects unknown fields. Fix the call rather than adding fields back.

## Validator and control rejections

| Rejection | Typical cause | Remediation |
| --- | --- | --- |
| `prompt-rejected` | `prompt` field was sent. | Use `message` for shared framing/resume or `task` inside `run`. |
| `tasks-rejected` | `tasks` array was sent. | Rename to `run` and ensure each item is a `Task`. |
| `dropped-field-rejected` | An unsupported field such as `model`, `cwd`, `metadata`, or `control` was sent. | Remove the field; move policy to agent config or text into `task`/`message`. |
| `crud-action-rejected` | `action:"create"`, `"update"`, `"delete"`, or `"get"` was sent. | Create/edit/delete/read agent files directly; use only `list`, `status`, `interrupt`, `resume`. |
| `fork-non-main-rejected` | `context:"fork"` tried to switch to another role/persona. | Use `context:"fresh"` for cross-role delegation. |
| `fork-unpersisted-session-rejected` | Fork requested before the parent session had a persisted session file. | Persist the parent session or use `fresh`. |
| `summarized-context-rejected` | Reserved future `context:"summarized"` was sent. | Use `fresh` or same-role `fork`. |
| `parallel-step-without-chain-rejected` | A nested `Task[]` appeared in `run` without `chain:true`. | Set `chain:true` or flatten the tasks into top-level parallel `run` items. |
| `empty-run-rejected` | Dispatch provided `run:[]` or no work/control action. | Provide at least one `Task`, or use a valid `action`. |
| `missing-id-rejected` | `status`, `interrupt`, or `resume` needed a target id in that path. | Provide the run/batch id or call broad `status` when supported. |
| `resume-message-rejected` | Resume had no non-empty `message`. | Send the next instruction in `message`. |
| `terminated-run-rejected` | Resume or interrupt targeted a completed, failed, or otherwise terminal run. | Start a new `run` if more work is needed. |
| `unknown-run-rejected` | The `id` did not match any active/recent run. | Check `action:"status"` and copy the current id. |
| `additional-property-rejected` | A key outside the documented schema was present. | Delete the extra key or move the information into `task`/`message`. |

## Remediation checklist

When a call fails, compare it to the canonical shape in `../SKILL.md`. Prefer a small explicit `run` call over reaching for management or workflow fields that aren't in the schema.
