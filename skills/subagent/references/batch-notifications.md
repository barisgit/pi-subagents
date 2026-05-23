# Batch notifications

`batch:true` changes completion notifications for multi-task dispatches. It does not change execution semantics, ordering, status, or output capture.

## Default per-run notifications

Without `batch:true`, each child run can emit its own completion, failure, or pause notification. This is useful when each branch needs immediate individual attention.

```ts
subagent({
  run: [
    { agent: "qa", task: "Run API tests." },
    { agent: "qa", task: "Run UI tests." }
  ]
})
```

## Rollup notification

With `batch:true`, the parent receives one rollup after the batch completes. Use it for parallel recon, review swarms, or noisy QA splits where the parent only needs a combined signal.

```ts
subagent({
  run: [
    { agent: "explorer", task: "Find schema callers." },
    { agent: "explorer", task: "Find docs that mention the retry policy." }
  ],
  batch: true
})
```

## Payload shape

Batch rollups summarize the batch id, aggregate status, task labels, per-child outcomes, duration, and result previews. Treat the rollup as a status surface; use `action:"status"` with the returned id when you need fuller details or saved output paths.
