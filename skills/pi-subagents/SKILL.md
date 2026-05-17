---
name: pi-subagents
description: |
  Delegate work to available subagents with single-agent, chain, parallel,
  swarm, async, fresh-context, and same-role fork workflows. Use when composing
  delegated execution, review, QA, research, or agent/chain management without
  assuming any particular builtin agent is enabled.
---

# Pi Subagents

Use this skill when you need to launch subagents, compose several delegated
steps, inspect async runs, or create/update agent and chain definitions. This
reference is user-config agnostic: agent names vary by installation, and builtin
agents may be disabled or overridden.

## First Principle: Discover Before Naming

If you are not certain an agent or chain exists and is enabled, list available
agents first:

```typescript
subagent({ action: "list" })
```

Then choose an available agent whose description matches the role you need. Do
not assume package-shipped agent names are available in the user's setup.

## Tool vs Slash Commands

Agents use the `subagent(...)` tool directly for execution, management, status,
and control. Humans often use slash commands instead:

- `/run` — launch a single agent
- `/chain` — launch a chain of steps
- `/parallel` — launch top-level parallel tasks
- `/agents` — open the agents manager TUI
- `/subagents-status` — inspect active/recent async runs

Prefer the tool when writing agent logic. Prefer slash commands when guiding a
human through an interactive flow.

## Agent and Chain Discovery

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
3. extension/builtin scope

Builtin agents, when enabled, load at the lowest priority and are implementation
details of the package. Treat them as optional examples, not a workflow contract.

## Choosing a Delegation Shape

- Use **single** for one bounded task.
- Use **chain** when later steps depend on earlier output, e.g. recon → plan → implementation → review.
- Use **parallel** when branches are independent, especially read-only recon or non-overlapping work.
- Use **swarm** (`prompt` + `tasks`) when you want the same prompt applied to multiple focuses or perspectives.
- Use **async** when the parent thread can continue while children run; inspect with `subagent({ action: "status" })` or `/subagents-status`.
- Use `worktree: true` only for concurrent write workflows that need isolated git worktrees.
- Use `clarify: true` only when a human should preview or edit launch parameters.

## Fresh vs Fork

`context` defaults to `"fresh"`. Fresh context is the normal choice for role
changes and specialist delegation: recon agents, implementers, reviewers, QA,
researchers, or any other different agent identity.

`context: "fork"` is only for same-role self-branching. A fork starts a real
branched child session from the current persisted parent session. It inherits
parent history; it is not a filtered review context. Runtime enforcement rejects
forks that try to switch to a different agent identity.

Use this rule:

- Different agent or role → use fresh context or omit `context`.
- Same agent continuing in a separate branch → `context: "fork"` may be valid.
- Unsure → use fresh context.

## Single Agent

```typescript
subagent({
  agent: "<available-agent>",
  task: "Inspect the API client retry behavior and summarize concrete risks.",
  label: "inspect retry risks"
})
```

Omit `task` only for self-contained agents whose prompt already defines the
work.

## Parallel Execution

Use parallel for independent tasks. Keep tasks narrow and include per-branch
labels when the run will be visible in widgets or status views.

```typescript
subagent({
  tasks: [
    {
      agent: "<available-recon-agent>",
      task: "Map the frontend auth flow and list likely change points.",
      label: "map frontend auth"
    },
    {
      agent: "<available-recon-agent>",
      task: "Map the backend auth flow and list likely change points.",
      label: "map backend auth"
    }
  ],
  label: "parallel auth recon"
})
```

If all branches use the same agent, pass top-level `agent` and use strings or
`{ task }` objects:

```typescript
subagent({
  agent: "<available-review-agent>",
  prompt: "Review for regressions in: {in}",
  tasks: ["authentication", "billing", "settings"]
})
```

## Swarm Execution

Swarm is parallel execution with a shared prompt. Use it for review diversity,
approach comparisons, or one common checklist over several focuses.

```typescript
subagent({
  prompt: "Evaluate this plan from the perspective of {in}. Return risks and one recommendation.",
  tasks: ["correctness", "maintainability", "runtime validation"],
  agent: "<available-advisory-agent>"
})
```

## Chain Execution

Use chains for dependent phases. Chain steps can use `{task}`, `{previous}`, and
`{chain_dir}`.

```typescript
subagent({
  chain: [
    {
      agent: "<available-recon-agent>",
      task: "Gather the minimum context needed for: {task}",
      label: "gather context"
    },
    {
      agent: "<available-implementation-agent>",
      task: "Implement the smallest correct change using this context: {previous}",
      label: "implement change"
    },
    {
      agent: "<available-review-or-qa-agent>",
      task: "Validate the change and report any blocking issues: {previous}",
      label: "validate change"
    }
  ],
  label: "context implement validate"
})
```

Prefer one writer step by default. Use parallel writers only when work is truly
independent and you can isolate or merge the results safely.

## Async and Status

```typescript
subagent({
  agent: "<available-qa-agent>",
  task: "Run the full integration suite and report failures with artifacts.",
  async: true,
  label: "run integration suite"
})
```

Inspect async runs with:

```typescript
subagent({ action: "status" })
subagent({ action: "status", id: "<run-id-or-prefix>" })
```

Use async only when the parent can keep coordinating or return control cleanly.

## Subagent Control

Subagent control is separate from lifecycle status. `needs_attention` means no
activity has been observed past the configured threshold; it does not prove the
child failed.

Use soft interrupt only when a child is clearly blocked, drifting, or a human
asks you to regain control:

```typescript
subagent({ action: "interrupt", id: "<run-id-or-prefix>" })
```

A soft interrupt cancels the current child turn and leaves the run paused. After
interrupting, explicitly decide whether to resume with clearer instructions,
replace the task, ask the user, or stop.

For legitimately quiet long-running tasks, override the threshold:

```typescript
subagent({
  agent: "<available-qa-agent>",
  task: "Run the slow migration test suite.",
  control: {
    needsAttentionAfterMs: 300000,
    notifyOn: ["needs_attention"]
  }
})
```

## Clarify TUI

Single, parallel, and chain runs support a clarification TUI:

```typescript
subagent({
  agent: "<available-agent>",
  task: "Implement feature X.",
  clarify: true
})
```

Use `clarify: true` only when a human should preview or edit parameters before
launch. For programmatic background launches, use `async: true` and leave
`clarify` unset or false.

## Worktree Isolation

Use `worktree: true` when multiple agents may write concurrently:

```typescript
subagent({
  tasks: [
    { agent: "<available-implementation-agent>", task: "Implement feature A." },
    { agent: "<available-implementation-agent>", task: "Implement feature B." }
  ],
  worktree: true
})
```

This requires a clean git state and is mainly for intentionally parallel write
workflows. If you want one writer plus advisory/review agents, prefer a
single-writer pattern.

## Writing Good Delegated Tasks

Good delegated tasks include:

- the desired outcome
- relevant files, commands, or constraints already known
- what to ignore or avoid
- whether the child may edit files
- what evidence or summary to return

Prefer:

```text
Review src/auth/session.ts for token-expiry regressions introduced by this diff.
Read only. Return blocking issues with line references; do not edit.
```

Over:

```text
Review everything.
```

## Coordination Patterns

### Single-writer workflow

Use one implementation agent for writes, with separate fresh-context recon,
advisory, review, or QA agents around it.

### Recon → Implement → Validate

Run recon first, pass its result into an implementation step, then validate with
a read-only reviewer or runtime QA agent. Use a chain when each step depends on
the previous result.

### Parallel read-only recon

Run multiple read-only branches in parallel when they inspect independent areas.
Synthesize their outputs before deciding the next implementation step.

### Same-role fork

Use fork only when the current agent should continue as itself in a separate
branch. Do not use fork to launch a different specialist.

```typescript
subagent({
  agent: "<current-agent-name>",
  task: "Explore an alternate plan in a branched copy of this session.",
  context: "fork"
})
```

## Intercom Coordination

When `pi-intercom` is installed and enabled, delegated runs can coordinate with
the orchestrator through the intercom bridge.

Use intercom when:

- a subagent is blocked on a decision
- an advisory agent wants to send a concise handoff mid-flight
- an async child needs to coordinate without waiting for normal tool return flow

Do not let advisory children silently become second decision-makers; escalate
unapproved product, architecture, or scope choices upward.

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

Use management actions when the system should create or edit subagents on demand
without dropping into raw file editing.

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

Common optional fields include:
- `defaultProgress`
- `defaultReads`
- `output`
- `fallbackModels`
- `maxSubagentDepth`

For small changes to extension-shipped agents, settings overrides are often
lower-friction than copying full agent files.

## Prompt Template Integration

If `pi-prompt-template-model` is installed, prompt templates can delegate into
`pi-subagents`. This is useful when a slash command should always run through a
particular available agent. Use forked context only for same-role self-branching.

## Important Constraints

- **Forking requires a persisted parent session.** If the current session does not have a persisted session file, forked runs fail.
- **Forked runs inherit parent history.** They are branched threads, not fresh filtered contexts.
- **Fork is same-role only.** Use fresh context for role changes and specialist delegation.
- **Default subagent nesting depth is 2.** Deeper recursive delegation is blocked unless configured otherwise.
- **Attention signals are not lifecycle state.** `needs_attention` means no activity has been observed past the configured threshold. `paused` means the child turn was intentionally interrupted or is awaiting direction; it is not the same as `failed`.
- **Intercom asks are blocking.** A session can only maintain one pending outbound ask wait state at a time.
- **Keep authority clear.** Root/main coordinates; delegated specialists execute bounded tasks and escalate unapproved decisions.

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
