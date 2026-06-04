# Context and fork

`context` is a per-task choice. Omit it for the default `fresh` behavior unless you are deliberately branching the current same-agent session.

## Fresh context

`context:"fresh"` starts a clean child session with the selected persona's system prompt and the concrete task you provide. Use it whenever the requested child should not inherit the parent's full transcript.

```ts
subagent({
  run: [{ agent: "<configured-agent>", task: "Read only: find the payment tests.", context: "fresh" }]
})
```

## Fork context

`context:"fork"` is same-agent self-branching. It creates a branched child from the current persisted parent session and is useful for alternate implementation attempts, second-pass checks, or same-agent scratch work. It is not a filtered review context and must not be used to switch personas. Forks keep the same configured agent identity (`<current-agent>→<current-agent>`); cross-agent delegation uses `context:"fresh"`.

```ts
// same-agent self-fork
subagent({
  run: [{ agent: "<current-agent>", task: "Explore an alternate minimal patch in a branch.", context: "fork" }]
})
```

The runtime resolves the current agent identity from (1) the `PI_SUBAGENT_CURRENT_AGENT` env set by the executor for child runs, (2) the active root role, or (3) a single requested agent when no other signal exists. Requesting a different agent name under `context:"fork"` is rejected at dispatch with `Fork context only allows the current agent '<name>' to fork itself.`

### Fork point safety: walk back past the dispatching tool_use

When a fork dispatches, the parent's leaf is the assistant turn containing the `subagent` tool_use that issued the fork. If the child inherited that leaf as-is, its branch would end on an assistant tool_use with no matching tool_result (the result is recorded in the parent's session, not in the child's branch). To avoid that orphan tool_use, the fork resolver walks back one step: if the leaf is an assistant message whose content includes a `{type:"toolCall", name:"subagent"}` block, it branches from the leaf's `parentId` instead. The child's inherited history therefore ends on the user prompt that triggered the dispatch, and the framing user-prompt added by the runtime becomes the next turn in the branch.

This is a structural fix and does not affect the conceptual context the child sees: the dispatching tool call wasn't a completed turn anyway, and the child still receives full earlier context. The fallback path (when `getEntry` is unavailable, the leaf is not an assistant turn, the leaf has no `subagent` tool_use, or the parent id cannot be resolved) uses the original leaf id unchanged.

## Reserved future mode

`summarized` is reserved for a future context mode but is not accepted by the current runtime schema. Use `fresh` when unsure.
