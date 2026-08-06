---
name: subagent
description: Use for delegating bounded repo work to configured subagents, parallel runs, workflow scripts with control flow, same-role forks, async jobs, and run management.
---

# Subagent

Subagents and Workflow are complementary ways to create useful execution boundaries. The live tool definitions own their exact schemas and runtime contracts.

## Subagents

A plain subagent delegates a bounded outcome and may itself delegate further, so model-directed trees do not require a Workflow script. There is no preferred child count: a `run` may contain any useful fixed set of branches, subject to runtime limits. Clear boundaries improve handoffs, but the model chooses the topology.

Multiple `run` entries execute in parallel. Adding a shared `message` applies one template through `{task}` or `{in}` across those entries—swarm-style dispatch for perspectives, targets, or variants. `batch:true` combines completion notices.

Optional top-level `cwd` defaults all run entries. When omitted, it defaults to the caller/session cwd; a relative top-level path resolves from that caller/session cwd. Optional per-run `cwd` overrides the default; a relative per-run path resolves from the resolved top-level cwd. Runs may share a cwd.

Delegation invoked from a child session always runs synchronously, even when `async:true` is explicit or async is enabled by default. This applies to plain subagent and Workflow calls because the child caller owns and awaits the result.

`context:"fresh"` gives a clean child context. Same-role `context:"fork"` inherits the parent context and provides isolation or concurrency rather than a different perspective. After an async dispatch, either stop or continue only work that neither overlaps nor duplicates the child's scope; do not poll or redo its work because the host sends a new turn when it finishes. If a delayed check is truly necessary and a background scheduler is available, schedule it for 10–15 minutes or longer.

## Workflow

Workflow is the highest-power orchestration surface in this harness: a programmable JavaScript control plane, not a preset parallel or pipeline mode. Its primitives are:

- `agent(role, task, opts?)` for child work and optional workflow-authored structured results.
- `parallel(thunks)` for a barrier over concurrently started branches.
- `pipeline(items, ...stages)` for independently streaming each item through stages.
- `phase(title)` for visible progress grouping.

Ordinary JavaScript supplies the larger grammar: functions, arrays, objects, conditions, loops, try/catch, and in-memory state. The primitives can be nested and composed to create runtime-discovered and multi-level fan-out, pipelines inside branches, fan-in across levels, queues, voting panels, selective retries, feedback and repair cycles, convergence gates, repeat-until-pass or loop-until-dry behavior, staged escalation, tournaments, and structures invented for the task.

Composition sketches (placeholders stand for configured roles):

```js
// Discovery-driven fan-out: a structured child result sets the topology —
// do not pre-author a work-list a child could discover at runtime.
// One self-contained brief; each branch gets a distinct focus.
const areas = await agent("<investigation-role>", "List the distinct areas this audit must cover. Return only the list.",
  { schema: { type: "array", items: { type: "string" } } });
const brief = "Read-only audit of <repo and key paths>. Cite file:line evidence for every claim. Expected output: a findings list. Area: ";
const reports = await parallel(areas.map((a) => () => agent("<investigation-role>", brief + a)));

// Explore → verify → synthesize: per-item pipeline stages keep each child's
// context bounded instead of pasting all reports into one prompt.
const verified = await pipeline(areas,
  (a) => agent("<investigation-role>", "Audit area: " + a),
  (report) => agent("<review-role>", "Re-check each claim against the actual files it cites; drop claims you cannot reproduce:\n" + report));
return await agent("<review-role>", "Synthesize a decision-ready report:\n" + verified.join("\n---\n"));

// Gate loop: requeue only what has not passed, under an attempt bound.
let gaps = await agent("<review-role>", "List remaining coverage gaps. Return only the list.",
  { schema: { type: "array", items: { type: "string" } } });
for (let round = 0; round < 3 && gaps.length > 0; round++) {
  await parallel(gaps.map((gap) => () => agent("<investigation-role>", "Close this gap: " + gap)));
  gaps = await agent("<review-role>", "List remaining coverage gaps. Return only the list.",
    { schema: { type: "array", items: { type: "string" } } });
}
```

Pure parallel work is valid in either a subagent batch/swarm or Workflow. Workflow's distinctive power appears when outputs shape later work, but that is not an artificial minimum-complexity requirement. The named patterns are a floor, not a ceiling; compose novel harnesses whenever richer coordination improves the result. Do not settle for a flat one-barrier fan-out out of caution: any coordination strategy you can state in JavaScript you can implement. Design the harness the task deserves.

Mechanical boundaries remain small: every orchestration call is awaited; partial-failure handling lives inside the relevant thunk or stage; configured role names replace placeholders; the workflow author owns result schemas; and the sandbox itself has no I/O—the children do the real work.

Each child starts with no conversation context: the script sees the whole picture, but a child sees only its task string. Write every task self-contained—relevant paths, constraints, observed behavior, and the exact expected output—and state whether it is read-only research or includes implementation. Give concurrent branches distinct focuses rather than one shared vague prompt. Verification stages must check actual files and command results, not an earlier child's summary of its own work.

## Load on demand

Open a reference when its detail is relevant:

- `references/dispatch-patterns.md` — choosing single, parallel, async, or background dispatch.
- `references/context-fork.md` — before setting `context:"fork"`; confirms same-agent-only branching.
- `references/resume.md` — resuming or messaging a live async run.
- `references/batch-notifications.md` — setting `batch:true` and interpreting rollup payloads.
- `references/error-modes.md` — validator rejection, drift, timeout, or missing-agent remediation.
