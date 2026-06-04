---
name: subagent
description: Use for delegating bounded repo work to configured subagents, parallel/chain runs, same-role forks, async jobs, and run management.
---

# Subagent

Delegate to control context, latency, and perspective. The tool schema is already in the live tool definition; this skill only decides **when** to delegate and which deeper reference to open.

## Inline or delegate

Stay inline for a single-file read, one obvious edit, a direct factual answer, or final synthesis.

Delegate when work needs any of these:

- **Context isolation** — read-only recon, cross-file tracing, or implementation that would pollute the parent thread.
- **A delegated lane** — a configured child can own a bounded outcome better than the parent thread.
- **Parallel perspective** — independent branches can run at once.
- **Background time** — tests, builds, research, or reviews can continue with `async:true`.
- **Same-role branching** — use `context:"fork"` only for self-forks, not role changes.

## Pick the shape

- Use one `run` task for a bounded handoff.
- Put multiple top-level `run` tasks in parallel when they do not depend on each other.
- Set `chain:true` only when later steps need earlier output; use `{previous}` in later task text.
- Set `batch:true` when several children should return one rollup notification.
- Use `action:"list"` if agent names/chains are uncertain; use status/interrupt/resume only for live run management.

## Canonical examples

```ts
subagent({
  run: [{ agent: "<configured-agent>", task: "Read-only: locate the payment tests and summarize coverage gaps." }]
})

subagent({
  chain: true,
  run: [
    { agent: "<configured-agent>", task: "Trace the failing flow and name exact files." },
    { agent: "<configured-agent>", task: "Patch only the files justified here: {previous}" },
    [
      { agent: "<configured-agent>", task: "Review the patch for regressions: {previous}" },
      { agent: "<configured-agent>", task: "Run the relevant checks and report evidence: {previous}" }
    ]
  ],
  batch: true
})
```

## Load on demand

Open exactly the reference that matches the decision you are making:

- `references/dispatch-patterns.md` — choosing single, parallel, chain, async, worktree, or swarm-style dispatch.
- `references/chain-semantics.md` — using `{previous}` or nested parallel sub-steps inside `chain:true`.
- `references/context-fork.md` — before setting `context:"fork"`; confirms same-agent-only branching.
- `references/resume.md` — resuming or messaging a live async run.
- `references/batch-notifications.md` — setting `batch:true` and interpreting rollup payloads.
- `references/error-modes.md` — validator rejection, drift, timeout, or missing-agent remediation.
