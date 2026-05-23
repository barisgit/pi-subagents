---
name: subagent
description: Delegate bounded work to subagents, or manage an existing run with the slim run/chain/action schema.
---

# Subagent

## When to use

Use when composing delegated execution, read-only recon, implementation, review, QA, or async/background checks.
List agents first when names or enabled status are uncertain.
Use `context:"fresh"` for cross-role delegation; `context:"fork"` is only same-role/main self-branching.
For slow or independent work, set `async:true` and inspect or resume by id.

## Dispatch shape

```ts
subagent({
  run?: Array<Task | Task[]>, // Task[] only as a parallel sub-step in chain:true
  chain?: boolean,
  async?: boolean,
  batch?: boolean,
  concurrency?: number,
  worktree?: boolean,
  message?: string,
  action?: "list" | "status" | "interrupt" | "resume",
  id?: string,
})

type Task = {
  agent: string,
  task: string,
  label?: string,
  context?: "fresh" | "fork",
  worktree?: boolean,
  output?: string | boolean,
}
```

## One canonical example

```ts
// single
subagent({ run:[{ agent:"fixer", task:"Patch the bug" }] })

// parallel
subagent({ run:[{ agent:"explorer", task:"Find tests" },{ agent:"qa", task:"Run checks" }], batch:true })

// chain with a parallel review+QA sub-step
subagent({ chain:true, run:[{ agent:"explorer", task:"Trace flow" },{ agent:"fixer", task:"Patch using {previous}" },[{ agent:"review", task:"Review {previous}" },{ agent:"qa", task:"Verify {previous}" }]] })
```

## Action verbs

- `list` — show available agents/chains before naming uncertain personas.
- `status` — inspect active or recent runs; add `id` to narrow.
- `interrupt` — softly pause a drifting or unwanted run by `id`.
- `resume` — continue a paused run with `id` and `message`.

## For details

- `references/dispatch-patterns.md` — single, parallel, chain, and swarm-style dispatch.
- `references/chain-semantics.md` — `{previous}` threading and nested parallel sub-steps.
- `references/context-fork.md` — fresh vs same-role fork context rules.
- `references/resume.md` — resume shape, required fields, and rejection cases.
- `references/batch-notifications.md` — `batch:true` rollups and notification payloads.
- `references/migration.md` — old-to-new field and CRUD verb rewrites.
- `references/error-modes.md` — validator rejections and remediation hints.
