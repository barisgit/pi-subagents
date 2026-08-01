# Dispatch patterns

Start with the narrowest effective path. Keep focused, tightly coupled, sequential work inline when current context is sufficient. A same-role fork is almost the inline agent in another branch—same role/model and inherited context—so use it only when isolation or concurrency provides concrete value. Delegate for substantial context isolation, specialist capability, independent parallel progress, background work the parent can overlap, or justified independent review; not merely because work is non-trivial.

Use the `run` shape for direct subagent dispatch. A run may contain any useful fixed set of branches, subject to runtime limits, and multiple entries execute in parallel. Plain subagents may also form agent-directed delegation trees. Workflow overlaps with these capabilities and provides explicit JavaScript orchestration when that representation helps the task.

## Single

```ts
subagent({
  run: [{ agent: "<configured-agent>", task: "Inspect the auth module and summarize findings." }]
})
```

## Parallel

Use multiple top-level tasks for independent branches with clear ownership and acceptance criteria. Add `batch:true` when you want one completion rollup instead of one notification per child.

```ts
subagent({
  run: [
    { agent: "<configured-agent>", task: "Find auth tests and summarize exact paths." },
    { agent: "<configured-agent>", task: "Run the auth unit tests and report failures." }
  ],
  batch: true
})
```

## Programmable orchestration

Workflow is valid for simple parallel work and becomes especially useful when results shape later work. It can pass summaries/results between steps, branch, retry, loop, decide runtime fan-out, and compose these patterns across levels. In `agent(role, task, opts?)`, `role` is one of the caller's configured agent roles; replace placeholders with real roles from the active config. `parallel()` can fan out over a dynamic list and scales to many concurrent children, bounded by the process-wide leaf-concurrency pool. `pipeline(items, ...stages)` streams each item through async stages without waiting for a whole-stage barrier. Choose either primitive from the data dependencies rather than treating one topology as the default.

`parallel()` is a **fail-fast barrier** (it awaits `Promise.all`): the first child that rejects rejects the whole call and the other results are discarded. That is the right default when every branch is required. When partial results are acceptable (survey/recon/fan-out where one dead branch should not sink the batch), catch inside each thunk so every branch resolves to a value.

`pipeline()` is also fail-fast overall, but it does not create a barrier between stages: item B can enter stage 2 while item A is still in stage 1. Catch inside a stage when a per-item failure should become a value instead of failing the whole pipeline.

### Knowledge channel: the return value, not the filesystem

A fan-out's findings flow back through each child's **return value**, not through files. `agent(role, task, opts?)` returns the child's output directly into your script — that return value IS the knowledge channel, and `opts.schema` forces it into a structured shape your code can map over. The synthesis child then reads those returned values in-process; it never re-reads files the leaves wrote.

```ts
const findings = await parallel(items.map((it) => () =>
  agent("<investigation-role>", taskFor(it), { schema: FINDING_SCHEMA })
    .then((r) => r.findings)
    .catch(() => [])
));
const master = await agent("<synthesis-role>", "Synthesize: " + JSON.stringify(findings.flat()));
```

Two anti-patterns to avoid:

- **Routing reports through the filesystem.** Telling leaves to write a report file and having the synthesis child re-read those files defeats the design — the return value already carried the knowledge. Use `schema` to shape it, not the disk.
- **"Don't compress" instructions.** That is a workaround for the wrong channel, not a fix. It arises when a bounded `subagent` (not `workflow`) self-compacts its final turn, leaving a `[compressed]` stub as `finalOutput`. The fix is the channel, not a gag order.

When you need a child's report **verbatim**, use `workflow` + `schema` so the structured return is guaranteed. A plain `subagent` `finalOutput` is a **summary, not a transcript** — a bounded child may compact its own final turn, so never depend on `subagent` `finalOutput` for output you need word-for-word.

### Multi-layer runtime fan-out

Each layer's width is decided at runtime from the previous layer's structured output. Schemas force arrays the script can safely map over; per-thunk `.catch` keeps the fail-fast barrier from sinking a whole layer; bounds (`maxItems`, `.slice`) keep fan-out honest against the leaf pool.

```ts
workflow({ script: `
phase("scope");
// Layer 0: one agent decides WHAT to fan out over — size not known up front.
const { modules } = await agent("<investigation-role>", "List up to 8 modules worth auditing.", {
  schema: { type: "object", required: ["modules"], properties: { modules: { type: "array", items: { type: "string" }, maxItems: 8 } }, additionalProperties: false },
});
if (modules.length === 0) return { status: "needs-attention", reason: "no modules identified" };

phase("survey");
// Layer 1: fan out over discovered modules; each returns STRUCTURED hotspots.
const surveys = await parallel(modules.map((mod) => () =>
  agent("<investigation-role>", "Audit '" + mod + "'. Return riskiest files with a reason each.", {
    schema: { type: "object", required: ["hotspots"], properties: { hotspots: { type: "array", items: { type: "object", required: ["file", "reason"], properties: { file: { type: "string" }, reason: { type: "string" } }, additionalProperties: false } } }, additionalProperties: false },
  })
    .then((r) => r.hotspots.map((h) => ({ mod, ...h })))
    .catch(() => [])
));

// Layer 2 work list is DERIVED from layer 1 output, capped so a bad survey can't explode fan-out.
const hotspots = surveys.flat().slice(0, 24);
if (hotspots.length === 0) return { status: "needs-attention", reason: "survey found no hotspots" };

phase("deep-dive");
const findings = await parallel(hotspots.map((h) => () =>
  agent("<investigation-role>", "Deep-dive " + h.file + " in " + h.mod + " (flagged: " + h.reason + "). Return finding + fix.")
    .then((finding) => ({ ...h, finding }))
    .catch(() => null)
));
const usable = findings.filter(Boolean);
if (usable.length === 0) return { status: "needs-attention", reason: "all deep-dives failed" };

phase("synthesize");
const report = await agent("<synthesis-role>", "Synthesize into a prioritized action list. Note gaps.\n\n" +
  usable.map((f) => "### " + f.mod + "/" + f.file + "\n" + f.finding).join("\n\n"));

phase("verify");
const verdict = await agent("<verification-role>", "Does this report cover the highest-risk hotspots? Return approved + gaps.\n\n" + report, {
  schema: { type: "object", required: ["approved", "gaps"], properties: { approved: { type: "boolean" }, gaps: { type: "array", items: { type: "string" } } }, additionalProperties: false },
});
return { report, verdict, covered: { modules: modules.length, hotspots: hotspots.length, analyzed: usable.length } };
` })
```

### Map / reduce

```ts
workflow({ script: `
phase("map");
const packages = ["api", "ui", "cli", "docs"];
const reports = await parallel(packages.map((pkg) => () =>
  agent("<investigation-role>", "Inspect " + pkg + " and summarize risks.").catch(() => null)
));
phase("reduce");
return await agent("<synthesis-role>", "Combine these reports into prioritized next steps: " + reports.filter(Boolean).join("\n"));
` })
```

```ts
workflow({ script: `
phase("produce");
const change = await agent("<implementation-role>", "Implement the smallest safe patch for the reported failure.");
phase("verify once");
const verdict = await agent("<verification-role>", "Try to disprove this medium/high-risk patch and return approved/blockers: " + change, {
  schema: { type: "object", required: ["approved", "blockers"], properties: { approved: { type: "boolean" }, blockers: { type: "array", items: { type: "string" } } }, additionalProperties: false },
});
if (verdict.approved) return { change, verdict };
return { status: "needs-attention", change, blockers: verdict.blockers };
` })
```

## Background

```ts
subagent({
  run: [{ agent: "<verification-role>", task: "Run the full test suite and report failures." }],
  async: true
})
```

Choose `async` whenever no remaining work, synthesis, or response in the current turn requires the child result. After dispatching, end the turn or continue only independent work without polling so the caller—or, at the root, the user—can keep working while children run; the host notifies you on completion or needs-attention. Use synchronous dispatch whenever any later work, synthesis, or response in the same turn must consume the result.

Calls made from a child session always execute synchronously, regardless of an explicit `async:true` or the configured default. The child caller owns and awaits nested subagent and Workflow results.
