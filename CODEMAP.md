# Code map

- `index.ts` registers subagent/workflow tools, slash commands, overlay dispatch, and async job APIs.
- `subagent-executor.ts` orchestrates single and parallel subagent dispatch, live progress, worktree isolation, intercom, foreground control, async persistence, and resume management.
- `workflow.ts` provides JavaScript control-flow orchestration over subagents.
- `agents.ts` discovers agent markdown files and resolves frontmatter/defaults.
- `settings.ts` resolves per-agent step behavior defaults.
- `render.ts` renders single, parallel, and workflow progress snapshots.
- `run-shape.ts` centralizes single/parallel labels and badges.
- `agent-manager.ts` and `agent-manager-*` implement the Agents Manager TUI.
- `agent-management.ts` handles management actions for agent definitions.
