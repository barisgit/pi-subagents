---
name: subagent
description: Delegate a bounded task to a named specialist agent, run several in parallel or chained pipelines, fork same-role branches, and inspect/resume async runs. Use whenever you would otherwise do read-only recon, implementation, review, or QA inline and a specialist or background run is a better fit.
---

# Subagent

## Why delegate

Inline execution burns the main context with recon, blocks on slow work, and runs everything from a single perspective. Delegating gives you four levers:

- **Specialist context** — a fresh-context child reads only what its task needs, returning a dense answer instead of polluting the parent thread.
- **Parallelism** — independent recon, implementation, review, and QA branches run concurrently.
- **Async backgrounding** — long tasks (suites, builds, multi-file refactors) run while the parent keeps coordinating.
- **Same-role forking** — branch the current session to explore an alternate path without losing history.

## When to use

- Read-only recon across many files or repos.
- A bounded implementation patch a specialist agent (e.g. `fixer`) can own end-to-end.
- An opinionated review or runtime QA pass after a change.
- Any task long enough that you want the parent free to keep working.

Stay inline only for single-file reads, a single obvious edit, a direct factual answer, or final synthesis of returned child output.

## Dispatch shape

```ts
subagent({
  run?: Array<Task | Task[]>, // Task[] only as a parallel sub-step in chain:true
  chain?: boolean,            // sequential, threads {previous} between steps
  async?: boolean,            // return immediately with an id
  batch?: boolean,            // collapse multi-task completions into one rollup
  concurrency?: number,       // cap parallel starts
  worktree?: boolean,         // top-level isolated git worktree mode for parallel runs
  message?: string,           // shared dispatch framing, or next turn for resume
  action?: "list" | "status" | "interrupt" | "resume",
  id?: string,                // target run for status; required for interrupt/resume
})

type Task = {
  agent: string,
  task: string,
  label?: string,
  context?: "fresh" | "fork", // default "fresh"; "fork" is same-role/main only
  output?: string | boolean,
}
```

## Examples

```ts
// single
subagent({ run:[{ agent:"fixer", task:"Patch the bug" }] })

// parallel with rollup notification
subagent({ run:[{ agent:"explorer", task:"Find tests" },{ agent:"qa", task:"Run checks" }], batch:true })

// chain with a parallel review+QA sub-step
subagent({ chain:true, run:[{ agent:"explorer", task:"Trace flow" },{ agent:"fixer", task:"Patch using {previous}" },[{ agent:"review", task:"Review {previous}" },{ agent:"qa", task:"Verify {previous}" }]] })
```

## Run management

- `subagent({ action:"list" })` — list available agents/chains. Run this when persona names or enabled status are uncertain.
- `subagent({ action:"status", id? })` — inspect active/recent runs.
- `subagent({ action:"interrupt", id })` — ask a drifting live run to stop.
- `subagent({ action:"resume", id, message })` — send the next turn to a live async run awaiting input; paused/interrupted runs are terminal.

## Load on demand

Open a reference only when its trigger fires — keep this file in working memory and pull specifics as needed:

- `references/dispatch-patterns.md` — when **choosing a shape** (single vs parallel vs chain vs swarm-style).
- `references/chain-semantics.md` — before using **`{previous}` substitution** or a **nested `Task[]` parallel sub-step**.
- `references/context-fork.md` — before setting **`context:"fork"`**; confirms the same-role/main rule and rejection cases.
- `references/resume.md` — before using **`action:"resume"`**; required fields and terminal-run rejections.
- `references/batch-notifications.md` — before setting **`batch:true`**; rollup payload shape and notification semantics.
- `references/error-modes.md` — when the validator **rejects a call**; rejection table with remediations.
