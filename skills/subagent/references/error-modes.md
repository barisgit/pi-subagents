# Error modes

| Symptom | Likely cause | Fix |
|---|---|---|
| `Unknown agent` | The named persona is not configured or is hidden on this surface. | Run `{ action: "list" }`, then retry with an executable agent name. |
| Nested array rejected | `run` only accepts task objects. | Flatten independent tasks into top-level `run`, or use `workflow` for dependent orchestration. |
| `context:"fork"` rejected | Forking is only for same-agent self-branches. | Use `context:"fresh"` for role changes. |
| Async status missing | The run finished and aged out, or the wrong id was provided. | Use `{ action:"status" }` without id to list current runs. |
| Child asked for attention | A delegated agent needs input or hit a blocker. | Resume with `{ action:"resume", id, message:"..." }` or interrupt if obsolete. |
