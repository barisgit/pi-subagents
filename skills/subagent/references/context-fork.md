# Context and fork

`context` is a per-task choice. Omit it for the default `fresh` behavior unless you are deliberately branching the current same-agent session.

## Fresh context

`context:"fresh"` starts a clean child session with the selected persona's system prompt and the concrete task you provide. Use it for role changes: explorer, qa, review, oracle, or any specialist that should not inherit the parent's full transcript.

```ts
subagent({
  run: [{ agent: "explorer", task: "Read only: find the payment tests.", context: "fresh" }]
})
```

## Fork context

`context:"fork"` is same-agent self-branching. It creates a branched child from the current persisted parent session and is useful for alternate implementation attempts, second-pass checks, or same-agent scratch work. It is not a filtered review context and must not be used to switch personas. Any agent can fork itself (`main→main`, `fixer→fixer`, `explorer→explorer`, etc.); cross-agent delegation uses `context:"fresh"`.

```ts
// main self-fork
subagent({
  run: [{ agent: "main", task: "Explore an alternate minimal patch in a branch.", context: "fork" }]
})

// fixer self-fork from inside a fixer run
subagent({
  run: [{ agent: "fixer", task: "Second-pass: re-check the edge case in the patch.", context: "fork" }]
})
```

The runtime resolves the current agent identity from (1) the `PI_SUBAGENT_CURRENT_AGENT` env set by the executor for child runs, (2) the active root role, or (3) a single requested agent when no other signal exists. Requesting a different agent name under `context:"fork"` is rejected at dispatch with `Fork context only allows the current agent '<name>' to fork itself.`

## Reserved future mode

`summarized` is reserved for a future context mode but is not accepted by the current runtime schema. Use `fresh` when unsure.
