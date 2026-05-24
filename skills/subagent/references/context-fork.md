# Context and fork

`context` is a per-task choice. Omit it for the default `fresh` behavior unless you are deliberately branching the current same-role session.

## Fresh context

`context:"fresh"` starts a clean child session with the selected persona's system prompt and the concrete task you provide. Use it for role changes: explorer, qa, review, oracle, or any specialist that should not inherit the parent's full transcript.

```ts
subagent({
  run: [{ agent: "explorer", task: "Read only: find the payment tests.", context: "fresh" }]
})
```

## Fork context

`context:"fork"` is same-role/main self-branching only. It creates a branched child from the current persisted parent session and is useful for alternate implementation attempts, second-pass checks, or same-agent scratch work. It is not a filtered review context and must not be used to switch personas. Fork is main-role-only; cross-agent delegation uses `context:"fresh"`.

```ts
subagent({
  run: [{ agent: "main", task: "Explore an alternate minimal patch in a branch.", context: "fork" }]
})
```

## Reserved future mode

`summarized` is reserved for a future context mode but is not accepted by the current runtime schema. Use `fresh` when unsure; use `fork` only with target agent `main`.
