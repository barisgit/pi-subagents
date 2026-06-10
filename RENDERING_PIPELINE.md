# Rendering pipeline

1. `subagent-executor.ts` emits `Details` snapshots for single and parallel runs.
2. `workflow.ts` emits workflow snapshots for JavaScript-orchestrated subagent work.
3. `render.ts` converts snapshots into compact TUI rows with per-agent progress.
4. `status-writer.ts` persists async status for dashboard and resume flows.
