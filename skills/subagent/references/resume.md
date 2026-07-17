# Resume

Use `action:"resume"` to steer a live async run with a new instruction or continue a terminal run from its saved session. Resume is a control action, not a new dispatch, so it targets an existing run id.

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

Resume whenever a live run needs a correction, changed constraint, answer, or next step. The message is sent directly to the live session; do not interrupt the run first merely to redirect it. Interrupt only when the current work must stop even if no follow-up is ready.

Terminal, paused, or interrupted runs can also resume when their saved session is available. Keep the message concrete: state what changed, what to do next, and whether prior constraints still apply.

```ts
subagent({
  action: "status",
  id: "run_abc123"
})
```

Check status first when the run state is unclear.

## Rejection cases

Resume is rejected when the run id or `message` is missing, the run belongs to another root session, or neither a live session nor a resumable saved session is available. If the prior context should not carry forward, start a new `run` instead of resuming.
