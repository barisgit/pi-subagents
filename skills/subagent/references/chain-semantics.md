# Chain semantics

`chain:true` makes `run` sequential. Each step must finish before the next starts, and the runner threads the preceding output into later prompts through substitutions.

## `{previous}` threading

Use `{previous}` in a chained task when that step needs the prior result. The first step has no previous output. In `message`, `{task}` and `{in}` expand to each task's `task` text; `{in}` may appear at most once per message. In chained task text, `{previous}` expands to the prior or merged step output.

```ts
subagent({
  chain: true,
  run: [
    { agent: "<configured-agent>", task: "Map the relevant files." },
    { agent: "<configured-agent>", task: "Patch only the files justified here: {previous}" },
    { agent: "<configured-agent>", task: "Review the patch and context: {previous}" }
  ]
})
```

## Nested parallel sub-steps

Inside `chain:true`, a `Task[]` element in `run` is a parallel sub-step. All tasks in that nested array run concurrently; the chain advances only after all complete.

```ts
subagent({
  chain: true,
  run: [
    { agent: "<configured-agent>", task: "Implement the change." },
    [
      { agent: "<configured-agent>", task: "Review this change: {previous}" },
      { agent: "<configured-agent>", task: "Verify this change: {previous}" }
    ],
    { agent: "<configured-agent>", task: "Address any blocking findings: {previous}" }
  ]
})
```

## Merge separator

When a parallel sub-step feeds the next chained step, child outputs are merged in task order with labeled separators so the next agent can tell which branch produced which text. Do not rely on exact formatting for parsing; ask children to return concise, structured summaries when the next step must consume them.
