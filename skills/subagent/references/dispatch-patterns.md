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
  batch: true,
  concurrency: 2
})
```

## Dependent orchestration

Use `workflow` for sequential or dependent phases. It can pass summaries/results between steps, branch, retry, loop, and decide runtime fan-out.

```ts
workflow({ script: `
const recon = await agent("explorer", "Trace login state ownership.");
const fix = await agent("fixer", "Implement the smallest fix using: " + recon.summary);
return await agent("qa", "Verify the fix: " + fix.summary);
` })
```

## Background

```ts
subagent({
  run: [{ agent: "qa", task: "Run the full test suite and report failures." }],
  async: true
})
```

Do not poll by default after starting async work; continue independent work or wait for the host notification.
