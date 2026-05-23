# Dispatch patterns

Use the slim `run` shape for every dispatch. Top-level `run` items start in parallel by default; set `chain:true` when later work depends on earlier output.

## Single

Use a single task for one bounded handoff. Keep the task outcome concrete and include known constraints.

```ts
subagent({
  run: [{ agent: "fixer", task: "Patch the failing parser test without touching src/network." }]
})
```

## Parallel

Use top-level parallel tasks for independent branches. Add `batch:true` when you want one completion rollup instead of one notification per child.

```ts
subagent({
  run: [
    { agent: "explorer", task: "Find auth tests and summarize exact paths." },
    { agent: "qa", task: "Run the auth unit tests and report failures." }
  ],
  batch: true,
  concurrency: 2
})
```

## Chain

Use `chain:true` for dependent phases. Later task text can include `{previous}` to receive the prior step output.

```ts
subagent({
  chain: true,
  run: [
    { agent: "explorer", task: "Trace login state ownership." },
    { agent: "fixer", task: "Implement the smallest fix using: {previous}" }
  ]
})
```

## Swarm-style parallel

Swarm is no longer a separate field. Model it as several `run` tasks that share the same framing through `message` and specialize each task.

```ts
subagent({
  message: "Evaluate the plan from this angle: {task}",
  run: [
    { agent: "oracle", task: "correctness risks" },
    { agent: "oracle", task: "maintainability risks" },
    { agent: "oracle", task: "verification gaps" }
  ],
  batch: true
})
```
