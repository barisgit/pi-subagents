# pi-subagents

Pi extension for delegating bounded work to configured subagents with single-task, parallel, async, workflow, and TUI support.

## Tools

### `subagent`

Use `subagent` to hand off one bounded task or a fixed set of independent parallel tasks.

```ts
subagent({ run: [{ agent: "fixer", task: "Patch the bug" }] })

subagent({
  run: [
    { agent: "explorer", task: "Find relevant tests." },
    { agent: "qa", task: "Run the relevant checks." }
  ],
  batch: true
})
```

Multiple top-level `run` tasks execute independently. Use `async:true` for background work, `batch:true` for one rollup notification, `concurrency` to cap parallel starts, and `worktree:true` to isolate parallel edits in git worktrees.

Task fields include `agent`, `task`, optional `label`, optional `context:"fresh"|"fork"`, and optional `output`. `context:"fork"` is same-agent self-branching only; use fresh context for role changes.

Run management uses `{ action:"list" }`, `{ action:"status" }`, `{ action:"interrupt" }`, and `{ action:"resume", id, message }`.

### `workflow`

Use `workflow` for sequential or dependent orchestration: branch on a child's structured result, retry or fall back on failure, loop until a condition holds, decide fan-out width at runtime, or transform data between steps.

```ts
workflow({ script: `
phase("inspect");
const recon = await agent("explorer", "Find the failing path and tests.");
phase("fix");
const fix = await agent("fixer", "Patch using this context: " + recon.summary);
const checks = await parallel([
  () => agent("review", "Review the patch: " + fix.summary),
  () => agent("qa", "Run the relevant tests: " + fix.summary)
]);
return { fix, checks };
` })
```

The workflow sandbox provides `agent(role, task)`, `parallel(thunks)`, and `phase(title)`. Top-level `await` is supported; the script return value becomes the workflow result. Use `async:true` to background the whole workflow.

## Slash commands

- `/run <agent> [task]` — run one agent.
- `/parallel agent1 "task1" -> agent2 "task2"` — run independent tasks in parallel.
- `/agents` — open the Agents Manager overlay.
- `/subagents-status` — inspect active/recent runs.

Slash commands support inline config such as `[model=...]`, `[output=...]`, `[preset=...]`, and `--bg` for background execution.

## Agents

Agents are markdown files under user or project agent directories. Frontmatter defines metadata and defaults such as `description`, `model`, `tools`, `skills`, `output`, `defaultReads`, `defaultProgress`, `thinking`, and `maxSubagentDepth`.

```md
---
description: Read-only repository recon
model: anthropic/claude-sonnet-4-5
tools: read, grep, ast_grep
skills: diagnose
---

You are the explorer. Trace code paths, identify tests, and report exact evidence.
```

Project agents override user agents of the same name; user/project agents override bundled examples.

## Agents Manager

Press `Ctrl+Shift+A` or run `/agents` to browse agents, inspect resolved prompts, select several agents for parallel launch, and start runs from a TUI. Agent creation and durable edits can also be done by editing markdown files or through management actions.

## Management actions

The `subagent` tool can list and manage agent definitions:

```ts
{ action: "list" }
{ action: "get", agent: "explorer" }
{ action: "create", config: { name: "auditor", description: "Read-only audit", systemPrompt: "..." } }
{ action: "update", agent: "auditor", config: { skills: "qa-validation" } }
{ action: "delete", agent: "auditor" }
```

## Worktree isolation

For independent parallel implementation branches, set `worktree:true` on `subagent`. Each child receives its own temporary git worktree; summary output includes relevant diff information. Keep parent working tree state clean enough for worktree creation.

## Skills

This package ships a `subagent` skill with concise dispatch guidance. Load it when deciding between inline work, single delegation, parallel delegation, background runs, same-role forks, or workflow orchestration.
