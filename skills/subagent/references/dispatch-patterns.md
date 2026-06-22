# Dispatch patterns

Use the `run` shape for direct subagent dispatch. Top-level `run` items are independent and may run in parallel. Use the `workflow` tool when later work depends on earlier output.

## Single

```ts
subagent({
  run: [{ agent: "<configured-agent>", task: "Inspect the auth module and summarize findings." }]
})
```

## Parallel

Use multiple top-level tasks for independent branches. Add `batch:true` when you want one completion rollup instead of one notification per child.

```ts
subagent({
  run: [
    { agent: "<configured-agent>", task: "Find auth tests and summarize exact paths." },
    { agent: "<configured-agent>", task: "Run the auth unit tests and report failures." }
  ],
  batch: true
})
```

## Dependent orchestration

Use `workflow` for sequential or dependent phases. It can pass summaries/results between steps, branch, retry, loop, and decide runtime fan-out. In `agent(role, task, opts?)`, `role` is one of the caller's configured agent roles; replace placeholders with real roles from the active config. `parallel()` can fan out over a dynamic list and scales to many concurrent children, bounded by the process-wide leaf-concurrency pool.

```ts
workflow({ script: `
phase("map");
const packages = ["api", "ui", "cli", "docs"];
const reports = await parallel(packages.map((pkg) => () =>
  agent("<investigation-role>", "Inspect " + pkg + " and summarize risks.")
));
phase("reduce");
return await agent("<synthesis-role>", "Combine these reports into prioritized next steps: " + reports.join("\n"));
` })
```

```ts
workflow({ script: `
phase("produce");
let change = await agent("<implementation-role>", "Implement the smallest safe patch for the reported failure.");
phase("verify");
for (let round = 0; round < 3; round++) {
  const verdict = await agent("<verification-role>", "Try to disprove this patch and return approved/blockers: " + change, {
    schema: { type: "object", required: ["approved", "blockers"], properties: { approved: { type: "boolean" }, blockers: { type: "array", items: { type: "string" } } }, additionalProperties: false },
  });
  if (verdict.approved) return { change, verdict };
  change = await agent("<implementation-role>", "Address these blockers: " + verdict.blockers.join("\n"));
}
return { status: "needs-attention", change };
` })
```

## Background

```ts
subagent({
  run: [{ agent: "<verification-role>", task: "Run the full test suite and report failures." }],
  async: true
})
```

Do not poll by default after starting async work; continue independent work or wait for the host notification.
