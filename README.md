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

Multiple top-level `run` tasks execute independently. Use `async:true` for background work, `batch:true` for one rollup notification, and `worktree:true` to isolate parallel edits in git worktrees. How many agents run at once is bounded process-wide by `maxConcurrentAgents` (config, default 4), not per call.

Task fields include `agent`, `task`, optional `label`, optional `context:"fresh"|"fork"`, and optional `output`. `context:"fork"` is same-agent self-branching only; use fresh context for role changes.

Run management uses `{ action:"list" }`, `{ action:"status" }`, `{ action:"interrupt" }`, and `{ action:"resume", id, message }`.

### `workflow`

Use `workflow` for sequential or dependent orchestration: branch on a child's structured result, retry or fall back on failure, loop until a condition holds, decide fan-out width at runtime, or transform data between steps.

```ts
workflow({ script: `
phase("inspect");
const recon = await agent("explorer", "Find the failing path and tests.");
phase("fix");
const fix = await agent("fixer", "Patch using this context: " + recon);
const checks = await parallel([
  () => agent("review", "Review the patch: " + fix),
  () => agent("qa", "Run the relevant tests: " + fix)
]);
return { fix, checks };
` })
```

The workflow sandbox provides `agent(role, task, opts?)`, `parallel(thunks)`, and `phase(title)`. `agent()` returns the child's result directly: a string by default, or a validated object when you pass `opts.schema` (a plain JSON Schema object). Top-level `await` is supported; the script return value becomes the workflow result. Use `async:true` to background the whole workflow.

## Slash commands

- `/run <agent> [task]` — run one agent.
- `/parallel agent1 "task1" -> agent2 "task2"` — run independent tasks in parallel.
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

## Management actions

The `subagent` tool can list agents and manage runs:

```ts
{ action: "list" }
{ action: "status", id: "<run-id>" }
{ action: "interrupt", id: "<run-id>" }
{ action: "resume", id: "<run-id>", message: "..." }
```

Agent definitions are created and edited as markdown files under `agents/`.

## Worktree isolation

For independent parallel implementation branches, set `worktree:true` on `subagent`. Each child receives its own temporary git worktree; summary output includes relevant diff information. Keep parent working tree state clean enough for worktree creation.

## Skills

This package ships a `subagent` skill with concise dispatch guidance. Load it when deciding between inline work, single delegation, parallel delegation, background runs, same-role forks, or workflow orchestration.
