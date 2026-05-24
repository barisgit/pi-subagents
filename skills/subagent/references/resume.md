# Resume

Use `action:"resume"` to send the next instruction to a live async run that is awaiting follow-up input. Resume is a control action, not a new dispatch, so it targets an existing run id.

## Required shape

Provide `action:"resume"`, the target `id`, and a `message` containing the next user turn. Do not include `run` with resume.

```ts
subagent({
  action: "resume",
  id: "run_abc123",
  message: "Continue with the smaller patch. Do not edit package.json."
})
```

## When to resume

Resume only while the async run is still live and waiting for direction. Paused or interrupted runs are terminal in the current runtime and cannot be resumed. Keep the message concrete: state what changed, what to do next, and whether prior constraints still apply.

```ts
subagent({
  action: "status",
  id: "run_abc123"
})
```

Check status first when the run state is unclear.

## Rejection cases

Resume is rejected when the run id is missing or unknown, the run has terminated, the run is not live/waiting for input, or the `message` is empty. If the old work should not continue, start a new `run` instead of resuming.
