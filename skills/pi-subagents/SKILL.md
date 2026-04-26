---
name: pi-subagents
description: |
  Delegate work to builtin or custom subagents with single-agent, chain,
  parallel, async, forked-context, and intercom-coordinated workflows. Use
  for advisory review, implementation handoffs, and multi-step tasks where a
  single agent should stay in control while other agents contribute context,
  planning, or execution.
---

# Pi Subagents

Use this skill when you need to launch a specialized subagent, compose multiple
agents into a workflow, or create/edit agents and chains on demand.

## When to Use

- **Advisory review**: fork to `oracle` or `reviewer` for a branched review thread
- **Implementation handoff**: have `oracle` advise, then `oracle-executor` or `worker` implement
- **Recon and planning**: use `scout` or `context-builder`, then `planner`
- **Parallel exploration**: run multiple non-conflicting tasks concurrently
- **Long-running work**: launch async/background runs and inspect them later
- **Subagent control**: watch needs-attention signals and soft-interrupt only when a delegated run is genuinely blocked
- **Agent authoring**: create, update, or override agents and chains for a project

## Tool vs Slash Commands

Agents can use the `subagent(...)` tool directly for execution, management, status, and control.
Humans often use the slash-command layer instead:

- `/run` — launch a single agent
- `/chain` — launch a chain of steps
- `/parallel` — launch top-level parallel tasks
- `/agents` — open the agents manager TUI
- `/subagents-status` — inspect active/recent async runs

Prefer the tool when you are writing agent logic. Prefer the slash commands when
you are guiding a human through an interactive flow.

## Builtin Agents

Builtin agents load at the lowest priority. Project agents override user agents,
and user/project agents override builtins with the same name.

| Agent | Purpose | Model | Typical output / role |
|-------|---------|-------|------------------------|
| `scout` | Fast codebase recon | `openai-codex/gpt-5.4-mini` | Writes `context.md` handoff material |
| `planner` | Creates implementation plans | `openai-codex/gpt-5.5` | Writes `plan.md` |
| `worker` | General implementation | `openai-codex/gpt-5.5` | Edits code directly |
| `reviewer` | Review-and-fix specialist | `openai-codex/gpt-5.5` | Can edit/fix reviewed code |
| `context-builder` | Requirements/codebase handoff builder | `openai-codex/gpt-5.5` | Writes structured context files |
| `researcher` | Web research brief generator | `openai-codex/gpt-5.5` | Writes `research.md` |
| `delegate` | Lightweight generic delegate | inherits parent model | No fixed output; generic delegated work |
| `oracle` | Decision-consistency advisory review | `openai-codex/gpt-5.5` | Advisory review, intercom coordination |
| `oracle-executor` | Implementation after approval | `openai-codex/gpt-5.5` | Single-writer implementation after approval |

Override builtin defaults via settings before copying full agent files when a
small tweak is enough.

Settings locations:
- User scope: `~/.pi/agent/settings.json`
- Project scope: `.pi/settings.json`

Useful override fields: `model`, `fallbackModels`, `thinking`,
`systemPromptMode`, `inheritProjectContext`, `inheritSkills`, `disabled`,
`skills`, `tools`, and `systemPrompt`.

## Discovery and Scope Rules

Agent files can live in:
- `~/.pi/agent/agents/*.md` — user scope
- `.pi/agents/*.md` — canonical project scope
- legacy `.agents/*.md` — still read for compatibility, but `.pi/agents/` wins on conflicts

Chains live in:
- `~/.pi/agent/agents/*.chain.md`
- `.pi/agents/*.chain.md`
- legacy `.agents/*.chain.md`

Precedence is:
1. project scope
2. user scope
3. builtin agents

## Running Subagents

### Mode selection heuristics

- Use **single** for one small, bounded task.
- Use **chain** instead of manual serial calls when stages depend on each other, e.g. explore → plan → build → review.
- Use **parallel** when branches are independent, especially read-only recon or non-overlapping implementation work.
- Use **swarm** (`prompt` + `tasks`) when you want multiple perspectives, approach comparisons, review diversity, or one common prompt applied to several focus areas.
- Use **async** when the parent agent/main thread can keep working while child agents run; inspect with `subagent({ action: "status" })` or `/subagents-status`.
- Use `worktree: true` for concurrent edits that might otherwise collide.
- Do not use `clarify` unless a human explicitly requested an interactive launch preview.

### Single agent

```typescript
subagent({
  agent: "oracle",
  task: "Review my current direction and challenge assumptions."
})
```

### Forked context

```typescript
subagent({
  agent: "oracle",
  task: "Review my current direction and challenge assumptions.",
  context: "fork"
})
```

`context: "fork"` creates a branched child session from the current persisted
parent session. It does **not** create a fresh minimal review context or filter
history down to only the relevant parts. Use it when you want a separate review
or execution thread that can still reference the parent session history.

### Parallel execution

```typescript
subagent({
  tasks: [
    { agent: "scout", task: "Explore the auth module" },
    { agent: "reviewer", task: "Review the API client" }
  ]
})
```

### Swarm execution

```typescript
subagent({
  prompt: "Review the codebase for risks in this area. Focus on: {in}",
  tasks: [
    { agent: "scout", task: "authentication flow" },
    { agent: "reviewer", task: "API boundaries" },
    { agent: "oracle", task: "architecture trade-offs" }
  ]
})
```

### Chain execution

```typescript
subagent({
  chain: [
    { agent: "scout", task: "Map the auth flow and summarize key files" },
    { agent: "planner", task: "Create an implementation plan from {previous}" },
    { agent: "worker", task: "Implement the approved plan based on {previous}" }
  ]
})
```

Chain steps can use templated variables such as `{task}`, `{previous}`, and
`{chain_dir}`. This is the main way to pass structured summaries between steps
without forcing each step to rediscover everything.

### Async/background

```typescript
subagent({
  agent: "worker",
  task: "Run the full test suite",
  async: true
})
```

Inspect async runs with `subagent({ action: "status", id: "..." })`, `subagent({ action: "status" })` for active runs, or the `/subagents-status` slash command.

### Subagent control

Subagent control is the runtime visibility and intervention layer for delegated runs. It is separate from lifecycle status. Lifecycle status says whether a child is `queued`, `running`, `paused`, `complete`, or `failed`. Activity reporting is factual: it tracks the last observed activity time and the current tool when known. It does not pretend to know that a child is truly stuck.

Default behavior is intentionally conservative. When no activity has been observed past the configured threshold, the run emits a `needs_attention` control event. Foreground runs can push this as a `subagent:control-event` event, and async runs persist it to `events.jsonl` so the parent tracker can surface it without constant manual polling. Notification-worthy control events are also inserted into the visible transcript so both the user and the parent agent can see them, with a proactive hint plus concrete `nudge`, `status`, and `interrupt` options. Visible notifications fire once per child run and attention state.

Use soft interrupt when a child is clearly blocked or drifting and the parent needs to regain control:

```typescript
subagent({ action: "interrupt" })
```

Pass `id` when targeting a specific controllable run:

```typescript
subagent({ action: "interrupt", id: "abc123" })
```

A soft interrupt cancels the current child turn and leaves the run paused. It does not mean the delegated task succeeded or failed. After an interrupt, decide the next explicit action: resume with clearer instructions, replace the task, ask the user, or stop the workflow.

Per-run control thresholds can be overridden when a task legitimately runs without observable output for longer than usual:

```typescript
subagent({
  agent: "worker",
  task: "Run the slow migration test suite",
  control: {
    needsAttentionAfterMs: 300000,
    notifyOn: ["needs_attention"]
  }
})
```

If the run already has an active intercom bridge target, needs-attention notifications can also prepare a compact intercom ping for the orchestrator. When a child route is available, the ping tells the orchestrator which agent needs attention and includes the exact `intercom({ action: "send", to: "..." })` target for a nudge. Do not invent a target or ask the child to self-report when no bridge exists.

## Clarify TUI

Single, parallel, and chain runs support a clarification TUI when you want a human to preview or
edit parameters before launch:

```typescript
subagent({
  agent: "worker",
  task: "Implement feature X",
  clarify: true
})
```

Clarify is opt-in for all modes, including chains. Use `clarify: true` only when a human should preview/edit before launch.
For programmatic background launches, use `async: true` and leave `clarify` unset or set `clarify: false`.

For swarm-style parallel dispatch, pass a top-level `prompt`; use `{in}` once to insert each task, or omit `{in}` to append each task after the common prompt.

## Worktree Isolation

When multiple agents might write concurrently, use worktrees instead of letting
them share one filesystem view.

```typescript
subagent({
  tasks: [
    { agent: "worker", task: "Implement feature A" },
    { agent: "worker", task: "Implement feature B" }
  ],
  worktree: true
})
```

`worktree: true` gives each parallel task its own git worktree branched from
HEAD. This requires a clean git state and is mainly for intentionally parallel
write workflows. If you want one writer thread and several advisory agents,
prefer a single-writer pattern instead.

## The Oracle Workflow

The intended oracle loop is:
1. the main agent forks to `oracle`
2. `oracle` reviews direction, drift, assumptions, and risks
3. `oracle` can coordinate back to the orchestrator via `intercom`
4. the main agent decides what direction to approve
5. only then should `oracle-executor` implement

```typescript
// Advisory review in a branched thread
subagent({
  agent: "oracle",
  task: "Review my current direction, challenge assumptions, and propose the best next move.",
  context: "fork"
})

// Implementation only after explicit approval
subagent({
  agent: "oracle-executor",
  task: "Implement the approved approach: ...",
  context: "fork"
})
```

`oracle` is not a fresh-context reviewer in the Cognition article sense. It is
a forked advisory thread that inherits the parent session history and uses that
history as a baseline contract.

## Subagent + Intercom Coordination

When `pi-intercom` is installed and enabled, delegated runs can coordinate with
the orchestrator through the intercom bridge.

### Subagent asks the orchestrator

```typescript
intercom({
  action: "ask",
  to: "orchestrator",
  message: "Should I optimize for readability or performance here?"
})
```

### Orchestrator replies

```typescript
intercom({ action: "reply", message: "Optimize for readability." })
```

Or inspect unresolved asks first:

```typescript
intercom({ action: "pending" })
```

Use `intercom` when:
- a subagent is blocked on a decision
- an advisory agent wants to send a concise handoff mid-flight
- a detached or async child needs to coordinate without waiting for normal tool return flow

## Management Mode

The `subagent(...)` tool also supports management actions.

### List available agents and chains

```typescript
subagent({ action: "list" })
```

### Create an agent

```typescript
subagent({
  action: "create",
  config: {
    name: "my-agent",
    description: "Project-specific implementation helper",
    systemPrompt: "Your system prompt here.",
    systemPromptMode: "replace",
    model: "openai-codex/gpt-5.4",
    tools: "read,grep,find,ls,bash"
  }
})
```

### Update an agent

```typescript
subagent({
  action: "update",
  agent: "my-agent",
  config: {
    thinking: "high"
  }
})
```

### Delete an agent

```typescript
subagent({ action: "delete", agent: "my-agent" })
```

Use management actions when the system needs to create or edit subagents on
demand without dropping into raw file editing.

## Creating and Editing Agents by File

A minimal agent file looks like this:

```markdown
---
name: my-agent
description: What this agent does
model: openai-codex/gpt-5.4
thinking: high
tools: read, grep, find, ls, bash
systemPromptMode: replace
inheritProjectContext: true
inheritSkills: false
---

Your system prompt here.
```

That is only a starting point. Common optional fields include:
- `defaultProgress`
- `defaultReads`
- `output`
- `fallbackModels`
- `maxSubagentDepth`

For many customizations, builtin overrides in settings are lower-friction than
copying a full builtin file.

## Prompt Template Integration

If `pi-prompt-template-model` is installed, prompt templates can delegate into
`pi-subagents`. This is useful when a slash command should always run through a
particular agent or with forked context.

## Important Constraints

- **Forking requires a persisted parent session.** If the current session does not
  have a persisted session file, forked runs fail.
- **Forked runs inherit parent history.** They are branched threads, not fresh
  filtered contexts.
- **Default subagent nesting depth is 2.** Deeper recursive delegation is blocked
  unless configured otherwise.
- **Attention signals are not lifecycle state.** `needs_attention` means no activity has been observed past the configured threshold. `paused` means the child turn was intentionally interrupted or is awaiting direction; it is not the same as `failed`.
- **Intercom asks are blocking.** A session can only maintain one pending outbound
  ask wait state at a time.
- **Keep conversational authority clear.** Advisory subagents should not silently
  become second decision-makers.

## Best Practices

### Keep writes single-threaded by default

A strong pattern is one main decision-maker plus advisory/research/review
subagents around it. Use `oracle` for advice and `oracle-executor` or `worker`
for the actual write path.

### Use fork for branched advisory or execution threads

Forked runs are useful when the child should reason in a separate thread while
still inheriting the parent’s accumulated context.

### Prefer narrow tasks

Give subagents specific tasks rather than vague mandates.
`Review auth.ts for null-check gaps` works better than `Review everything`.

### Escalate decisions upward

If a subagent encounters an unapproved product, architecture, or scope choice,
it should coordinate back via `intercom` instead of deciding alone.

### Intervene only on clear control signals

Use subagent control proactively when a delegated run emits `needs_attention`, or when a human asks you to regain control. Do not interrupt just because a child has briefly produced no output. Silence can be normal during long tool calls, test runs, or model reasoning.

### Name sessions meaningfully

Use `/name` so intercom targeting stays stable.

## Common Workflows

### Recon → Plan → Implement

```typescript
subagent({
  chain: [
    { agent: "scout", task: "Map the auth flow and summarize relevant files" },
    { agent: "planner", task: "Plan the migration from {previous}" },
    { agent: "worker", task: "Implement the approved plan from {previous}" }
  ]
})
```

### Review loop

```typescript
subagent({ agent: "worker", task: "Add retry logic to the API client." })
subagent({
  agent: "reviewer",
  task: "Review the retry logic implementation. Look for edge cases and race conditions.",
  context: "fork"
})
```

### Parallel non-conflicting analysis

```typescript
subagent({
  tasks: [
    { agent: "scout", task: "Audit frontend auth flow" },
    { agent: "researcher", task: "Research current retry/backoff best practices" }
  ]
})
```

## Error Handling

**"Unknown agent"**
```typescript
subagent({ action: "list" })
// Check available agents and chains, then confirm scope/precedence.
```

**"Max subagent depth exceeded"**
```typescript
// Flatten the workflow or raise maxSubagentDepth in config.
```

**"Session manager did not return a session file"**
```typescript
// Persist the current session before using context: "fork".
```

**Intercom "Already waiting for a reply"**
```typescript
// Resolve the current outbound ask before starting another one.
```
