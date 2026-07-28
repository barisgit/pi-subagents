---
name: subagent
description: Use for delegating bounded repo work to configured subagents, parallel runs, workflow scripts with control flow, same-role forks, async jobs, and run management.
---

# Subagent

Subagents and Workflow are complementary ways to create useful execution boundaries. The live tool definitions own their exact schemas and runtime contracts.

## Subagents

A plain subagent delegates a bounded outcome and may itself delegate further, so model-directed trees do not require a Workflow script. There is no preferred child count: a `run` may contain any useful fixed set of branches, subject to runtime limits. Clear boundaries improve handoffs, but the model chooses the topology.

Multiple `run` entries execute in parallel. Adding a shared `message` applies one template through `{task}` or `{in}` across those entries—swarm-style dispatch for perspectives, targets, or variants. `batch:true` combines completion notices; `worktree:true` isolates parallel edits.

`context:"fresh"` gives a clean child context. Same-role `context:"fork"` inherits the parent context and provides isolation or concurrency rather than a different perspective. After an async dispatch, either stop or continue only work that neither overlaps nor duplicates the child's scope; do not poll or redo its work because the host sends a new turn when it finishes. If a delayed check is truly necessary and a background scheduler is available, schedule it for 10–15 minutes or longer.

## Workflow

Workflow is the highest-power orchestration surface in this harness: a programmable JavaScript control plane, not a preset parallel or pipeline mode. Its primitives are:

- `agent(role, task, opts?)` for child work and optional workflow-authored structured results.
- `parallel(thunks)` for a barrier over concurrently started branches.
- `pipeline(items, ...stages)` for independently streaming each item through stages.
- `phase(title)` for visible progress grouping.

Ordinary JavaScript supplies the larger grammar: functions, arrays, objects, conditions, loops, try/catch, and in-memory state. The primitives can be nested and composed to create runtime-discovered and multi-level fan-out, pipelines inside branches, fan-in across levels, queues, voting panels, selective retries, feedback and repair cycles, convergence gates, repeat-until-pass or loop-until-dry behavior, staged escalation, tournaments, and structures invented for the task.

Pure parallel work is valid in either a subagent batch/swarm or Workflow. Workflow's distinctive power appears when outputs shape later work, but that is not an artificial minimum-complexity requirement. The named patterns are a floor, not a ceiling; compose novel harnesses whenever richer coordination improves the result.

Mechanical boundaries remain small: every orchestration call is awaited; partial-failure handling lives inside the relevant thunk or stage; configured role names replace placeholders; the workflow author owns result schemas; and the sandbox itself has no I/O—the children do the real work.

## Load on demand

Open a reference when its detail is relevant:

- `references/dispatch-patterns.md` — choosing single, parallel, async, worktree, or background dispatch.
- `references/context-fork.md` — before setting `context:"fork"`; confirms same-agent-only branching.
- `references/resume.md` — resuming or messaging a live async run.
- `references/batch-notifications.md` — setting `batch:true` and interpreting rollup payloads.
- `references/error-modes.md` — validator rejection, drift, timeout, or missing-agent remediation.
