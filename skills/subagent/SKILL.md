---
name: subagent
description: Use for delegating bounded repo work to configured subagents, parallel runs, workflow scripts with control flow, same-role forks, async jobs, and run management.
---

# Subagent

Delegate to control context, latency, and perspective. The tool schema is already in the live tool definition; this skill only decides **when** to delegate and which deeper reference to open.

## Inline or delegate

Start with the narrowest effective path. Stay inline for focused, tightly coupled, sequential work when current context is sufficient—including a few related files, local repository lookups, and an inspect/edit/test loop.

A same-role `context:"fork"` is almost the inline agent in another branch: it keeps the same role/model and inherits the parent context. It provides isolation or concurrency, not specialist capability or an independent perspective, and it still adds a handoff. Use it only when that boundary has concrete value; use `fresh` for role changes or deliberately clean context.

Delegate only when a bounded child provides at least one concrete advantage:

- **Substantial context isolation** — noisy read-heavy recon, logs, broad cross-file tracing, or an isolated implementation branch would materially pollute the parent.
- **Specialist capability** — a configured role is materially better suited to the outcome.
- **Independent parallel progress** — branches do not depend on each other and the parent can continue useful work.
- **Background time** — choose `async:true` whenever no remaining work, synthesis, or response in the current turn requires the child result. After dispatching, end the turn or continue only independent work without polling so the caller—or, at the root, the user—can keep working; the host notifies you on completion or when attention is needed. Use synchronous dispatch whenever any later work, synthesis, or response in the same turn must consume the result.
- **Independent review** — risk justifies a separate judgment and existing verification is insufficient.

Do not delegate merely because work is non-trivial or a matching role exists. Prefer one child. Use 2–3 for genuinely independent branches; use 4 only with explicit decomposition, non-overlapping ownership, and acceptance criteria.

## Pick the shape

- Use no child when inline work is sufficient; otherwise use one `run` task for a bounded handoff by default.
- Put 2–3 top-level `run` tasks in parallel only when they are genuinely independent. Use 4 only with explicit decomposition and non-overlapping ownership.
- Use the `workflow` tool for sequential or dependent orchestration: branch on a child's structured result, retry/fallback on failure, loop until a condition holds, runtime-decided fan-out, or data transforms between steps.
- Set `batch:true` when several children should return one rollup notification.
- Use `action:"list"` if agent names are uncertain; use status/interrupt/resume only for live run management.
- A child's findings return **in JS** (shaped by `opts.schema`), not through files: never route fan-out reports through the filesystem for a synthesis child to re-read. For a report you need **verbatim**, use `workflow` + `schema` — a plain `subagent` `finalOutput` is a summary, not a transcript. See `references/dispatch-patterns.md`.

## Workflow: orchestration with control flow

`workflow({ script })` runs JavaScript in a sandbox with `agent(role, task, opts?)`, `parallel(thunks)`, `pipeline(items, ...stages)`, and `phase(title)`. `role` is one of the caller's configured agent roles; replace placeholders like `"<implementation-role>"` with real roles from the active config. `agent()` returns the child's result directly — a string by default, or a validated object when you pass `opts.schema` (a plain JSON Schema object the workflow author owns; the child never decides its own shape). It rejects on child failure. Top-level await works; the script's return value is the workflow result. `async:true` backgrounds the whole workflow. Await every `agent()`/`parallel()`/`pipeline()` call; use `parallel()` for an independent fail-fast barrier, and `pipeline()` to stream items through async stages without waiting for a whole-stage barrier. Use these helpers instead of raw `Promise.all` so failures are attributed. Both are fail-fast overall; when partial results are acceptable, catch inside each thunk/stage so every branch resolves. Concurrency is bounded process-wide by `maxConcurrentAgents` (config), not per call. The sandbox has no I/O — subagents do the real work.

```ts
workflow({ script: `
phase("inspect");
const finding = await agent("<investigation-role>", "Inspect the bounded area and return only decision-relevant evidence.");
phase("implement");
const change = await agent("<implementation-role>", "Implement the smallest safe change using: " + finding);
phase("verify once");
const verdict = await agent("<verification-role>", "Independently verify this medium/high-risk change and return approved/blockers: " + change, {
  schema: { type: "object", required: ["approved", "blockers"], properties: { approved: { type: "boolean" }, blockers: { type: "array", items: { type: "string" } } }, additionalProperties: false },
});
if (verdict.approved) return { change, finding, verdict };
return { status: "needs-attention", change, finding, blockers: verdict.blockers };
` })
```

## Canonical examples

```ts
subagent({
  run: [{ agent: "<configured-agent>", task: "Read-only: locate the payment tests and summarize coverage gaps." }]
})

subagent({
  run: [
    { agent: "<configured-agent>", task: "Find relevant tests." },
    { agent: "<configured-agent>", task: "Run the relevant checks and report evidence." }
  ],
  batch: true
})
```

## Load on demand

Open exactly the reference that matches the decision you are making:

- `references/dispatch-patterns.md` — choosing single, parallel, async, worktree, or background dispatch.
- `references/context-fork.md` — before setting `context:"fork"`; confirms same-agent-only branching.
- `references/resume.md` — resuming or messaging a live async run.
- `references/batch-notifications.md` — setting `batch:true` and interpreting rollup payloads.
- `references/error-modes.md` — validator rejection, drift, timeout, or missing-agent remediation.
