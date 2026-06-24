---
name: subagent
description: Use for delegating bounded repo work to configured subagents, parallel runs, workflow scripts with control flow, same-role forks, async jobs, and run management.
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
- Use the `workflow` tool for sequential or dependent orchestration: branch on a child's structured result, retry/fallback on failure, loop until a condition holds, runtime-decided fan-out, or data transforms between steps.
- Set `batch:true` when several children should return one rollup notification.
- Use `action:"list"` if agent names are uncertain; use status/interrupt/resume only for live run management.

## Workflow: orchestration with control flow

`workflow({ script })` runs JavaScript in a sandbox with `agent(role, task, opts?)`, `parallel(thunks)`, and `phase(title)`. `role` is one of the caller's configured agent roles; replace placeholders like `"<implementation-role>"` with real roles from the active config. `agent()` returns the child's result directly — a string by default, or a validated object when you pass `opts.schema` (a plain JSON Schema object the workflow author owns; the child never decides its own shape). It rejects on child failure. Top-level await works; the script's return value is the workflow result. `async:true` backgrounds the whole workflow. Await every `agent()`/`parallel()` call; use `parallel()` to run independent children together (not raw `Promise.all`) so failures are attributed. `parallel()` is a fail-fast barrier — the first child that rejects rejects the whole call and the other results are lost; when partial results are acceptable, catch inside each thunk so every branch resolves. It scales to many concurrent children, bounded process-wide by `maxConcurrentAgents` (config), not per call. The sandbox has no I/O — subagents do the real work.

```ts
workflow({ script: `
phase("inspect");
const areas = ["api", "state", "tests", "docs"];
const findings = await parallel(areas.map((area) => () =>
  agent("<investigation-role>", "Inspect " + area + " and return concise findings.")
));
phase("implement");
let change = await agent("<implementation-role>", "Implement the smallest safe change using: " + findings.join("\n"));
phase("verify loop");
for (let round = 0; round < 3; round++) {
  const verdict = await agent("<verification-role>", "Independently verify this change and return approved/blockers: " + change, {
    schema: { type: "object", required: ["approved", "blockers"], properties: { approved: { type: "boolean" }, blockers: { type: "array", items: { type: "string" } } }, additionalProperties: false },
  });
  if (verdict.approved) return { change, findings, verdict };
  change = await agent("<implementation-role>", "Address these verification blockers: " + verdict.blockers.join("\n"));
}
return { status: "needs-attention", change, findings };
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

- `references/dispatch-patterns.md` — choosing single, parallel, async, worktree, or swarm-style dispatch.
- `references/context-fork.md` — before setting `context:"fork"`; confirms same-agent-only branching.
- `references/resume.md` — resuming or messaging a live async run.
- `references/batch-notifications.md` — setting `batch:true` and interpreting rollup payloads.
- `references/error-modes.md` — validator rejection, drift, timeout, or missing-agent remediation.
