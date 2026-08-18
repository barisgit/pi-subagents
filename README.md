# pi-subagents

Pi extension for delegating bounded work to configured subagents with single-task, parallel, async, workflow, and TUI support.

## Tools

### `subagent`

Use `subagent` to hand off one bounded task or a fixed set of independent parallel tasks.

```ts
subagent({ run: [{ agent: "<configured-role>", task: "Patch the bug" }] })

subagent({
  run: [
    { agent: "<investigation-role>", task: "Find relevant tests." },
    { agent: "<verification-role>", task: "Run the relevant checks." }
  ],
  batch: true
})
```

Multiple top-level `run` tasks execute independently. Use `async:true` for background work and `batch:true` for one rollup notification. How many agents actively run at once is bounded process-wide by `maxConcurrentAgents` (config, default 4). Workflows also use that value to bound direct children before creating their run records.

Optional top-level `cwd` defaults all run entries. When omitted, it defaults to the caller/session cwd; a relative top-level path resolves from that caller/session cwd. Optional per-run `cwd` overrides the default; a relative per-run path resolves from the resolved top-level cwd. Runs may share a cwd.

Task fields include `agent`, `task`, optional `label`, optional `context:"fresh"|"fork"`, optional `cwd`, and optional `output`. `context:"fork"` is same-agent self-branching only; use fresh context for role changes.

Run management uses `{ action:"list" }`, `{ action:"status" }`, `{ action:"interrupt" }`, and `{ action:"resume", id, message }`.

### `workflow`

Use `workflow` for sequential or dependent orchestration: branch on a child's structured result, retry or fall back on failure, loop until a condition holds, decide fan-out width at runtime, or transform data between steps.

```ts
workflow({ script: `
phase("inspect");
const areas = ["api", "ui", "cli", "docs"];
const findings = await parallel(areas.map((area) => () =>
  agent("<investigation-role>", "Inspect " + area + " and return concise findings.")
));
phase("implement");
let change = await agent("<implementation-role>", "Patch using this context: " + findings.join("\n"));
phase("verify");
for (let round = 0; round < 3; round++) {
  const verdict = await agent("<verification-role>", "Verify this patch and return approved/blockers: " + change, {
    schema: { type: "object", required: ["approved", "blockers"], properties: { approved: { type: "boolean" }, blockers: { type: "array", items: { type: "string" } } }, additionalProperties: false },
  });
  if (verdict.approved) return { change, findings, verdict };
  change = await agent("<implementation-role>", "Address these blockers: " + verdict.blockers.join("\n"));
}
return { status: "needs-attention", change, findings };
` })
```

The workflow sandbox provides `agent(role, task, opts?)`, `parallel(thunks)`, `pipeline(items, ...stages)`, and `phase(title)`. `role` is one of the caller's configured agent roles; replace placeholders with real active roles. `agent()` returns the child's result directly: a string by default, or a validated object when you pass `opts.schema` (a plain JSON Schema object). `parallel()` scales dynamic fan-out while `maxConcurrentAgents` bounds admitted direct children and process-global active leaf sessions. `pipeline()` streams each item through async stages without waiting for a whole-stage barrier, preserves input-order results, and runs at most `workflow.maxPipelineItemsInFlight` item chains per workflow (default 8). Top-level `await` is supported; the script return value becomes the workflow result. Use `async:true` to background the whole workflow.

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

Trace code paths, identify tests, and report exact evidence.
```

Project agents override user agents of the same name; user/project agents override bundled examples.

An agent can define ordered fallback models in markdown frontmatter or in a
`subagent.json` preset overlay:

```json
{
  "model": "provider/primary-model",
  "fallbackModels": ["provider/fallback-model", "another-provider/final-model"]
}
```

Pi first applies its configured same-model retry policy. If the request still
ends in a rate-limit, quota, authentication, or provider failure, the child
continues from the same persisted session history on the next fallback model.
Transport failures instead keep the current model and wait with capped
exponential backoff until connectivity returns or the run is interrupted.

## Management actions

The `subagent` tool can list agents and manage runs:

```ts
{ action: "list" }
{ action: "status", id: "<run-id>" }
{ action: "interrupt", id: "<run-id>" }
{ action: "resume", id: "<run-id>", message: "..." }
```

Agent definitions are created and edited as markdown files under `agents/`.

## Skills

This package ships a `subagent` skill with concise dispatch guidance. Load it when deciding between inline work, single delegation, parallel delegation, background runs, same-role forks, or workflow orchestration.
