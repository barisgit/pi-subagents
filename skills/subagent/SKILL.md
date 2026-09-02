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

Delegation invoked from a child session runs synchronously, even when `async:true` is explicit or async is enabled by default, unless `allowNestedAsync:true` is set in extension config. With that strict opt-in, plain subagent and Workflow calls return immediately and completion starts a new turn in the immediate parent session.

`context:"fresh"` gives a clean child context. Same-role `context:"fork"` inherits the parent context and provides isolation or concurrency rather than a different perspective. After an async dispatch, either stop or continue only work that neither overlaps nor duplicates the child's scope; do not poll or redo its work because the host sends a new turn when it finishes. If a delayed check is truly necessary and a background scheduler is available, schedule it for 10–15 minutes or longer.

## Workflow

Choose the shape from the dependency pattern:

- Use `pipeline(items, ...stages)` by default for per-item multi-stage work. A stage receives `(previousResult, originalItem, index)`; the first receives `(item, item, index)`.
- Use a `parallel()` barrier only when the next section needs the whole result set, such as deduplicating across results or exiting early when the set is empty.
- Use `parallel()` when any failure should abort. Use `parallelSettled()` when partial results are acceptable instead of adding `try/catch` to every thunk.
- Call `phase(title)` only between top-level sections to set the default for subsequent dispatches. Inside pipeline or parallel callbacks, use `opts.phase` to attribute each child without introducing a barrier; it must match metadata when phases are declared.
- Set `opts.label` for readable status rows and `opts.cwd` for per-item working directories; relative paths resolve from the caller/session cwd.
- Define `opts.schema` when later code must filter, compare, or vote on child output. The workflow owns that result contract.

Keep dependent stages in one N-stage pipeline. Never split them into separate `pipeline()` calls with a `phase()` barrier between them.

Canonical two-stage form (placeholders stand for configured roles):

```js
meta({
  name: "Branch updates",
  description: "Investigate each branch, then implement and verify actionable findings",
  phases: ["Investigate", "Implement and verify"],
});

const items = [
  { branch: "physics", cwd: "packages/physics" },
  { branch: "biology", cwd: "packages/biology" },
];

phase("Investigate");
const outcomes = await pipeline(
  items,
  (item, originalItem, index) =>
    agent("<investigation-role>", "Investigate " + originalItem.branch + " at index " + index, {
      phase: "Investigate",
      label: "Investigate " + item.branch,
      cwd: item.cwd,
      schema: {
        type: "object",
        properties: {
          finding: { type: "string" },
          actionable: { type: "boolean" },
        },
        required: ["finding", "actionable"],
        additionalProperties: false,
      },
    }),
  (finding, item) => {
    if (!finding.actionable) return { skipped: true, branch: item.branch };
    return agent(
      "<implementation-role>",
      "Implement and verify " + item.branch + ": " + finding.finding,
      {
        phase: "Implement and verify",
        label: "Implement " + item.branch,
        cwd: item.cwd,
      },
    );
  },
);
return outcomes;
```

Every orchestration call must be awaited. The sandbox has no I/O; children do the real work. Each child starts with no conversation context, so make every task self-contained with relevant paths, constraints, observed behavior, and expected output. Verification work must check actual files and command results, not an earlier child's summary.

## Load on demand

Open a reference when its detail is relevant:

- `references/dispatch-patterns.md` — choosing single, parallel, async, or background dispatch.
- `references/context-fork.md` — before setting `context:"fork"`; confirms same-agent-only branching.
- `references/resume.md` — resuming or messaging a live async run.
- `references/batch-notifications.md` — setting `batch:true` and interpreting rollup payloads.
- `references/error-modes.md` — validator rejection, drift, timeout, or missing-agent remediation.
