# pi-subagents Code Map

## Extension Identity
- Package: `pi-subagents` v0.18.1 (pi-coding-agent extension)
- Entry: `index.ts` registers slash commands (/run, /chain, /parallel), overlay handler, and async job APIs
- Modes: single, chain (sequential agents), parallel (concurrent agents), management

## Core Pipeline

### Execution (`execution.ts`, `subagent-executor.ts`)
- `execution.ts::runSync()` — spawns `pi` as a subprocess, parses JSONL stdout for events (tool_execution_start/end, message_end, tool_result_end), updates `AgentProgress` in real time, fires `onUpdate` on every event
- `subagent-executor.ts` — orchestrates single/chain/parallel modes, resolves agent configs, merges live progress from concurrent tasks, handles worktree isolation, intercom, foregroundControl, and async persistence

### Progress Tracking (`types.ts`)
- `AgentProgress` holds: status, currentTool/currentToolArgs, recentTools (chronological, uncapped), recentOutput (capped 50), tokenSamples (capped 120, 50s window), toolCount, tokens, durationMs, activityState
- `Details` holds: mode, results[], progress[], progressSummary, chainAgents[], totalSteps, currentStepIndex, artifacts, truncation

### Live Rendering (`render.ts`, `formatters.ts`)
- `render.ts` is the 1100-line main renderer
  - `buildSparkline()` — token-rate sparkline, 8-block chars, wall-clock quantized cells, 240s window, normalized per-bucket peak
  - `buildThinkingBar()` (inert — no longer called by buildLiveCurrentLine) — soft-log fill bar, tone flips warning past thinkingBarMaxMs (effort level → 5s/8s/15s/30s/60s)
  - `buildChainBar()` — step progress using filled/empty triangle chars
  - `buildLiveCurrentLine()` — priority: needs_attention warning → current tool → thinking timer → starting
  - `buildLiveHistoryLines()` — renders `recentTools.slice(-count).reverse()` with `← tool: args  Nms` format
  - `adaptiveSparkWidth()` — floor(termWidth/6), cap 80
  - `adaptiveBarWidth()` — floor(termWidth/8), cap 40
  - `adaptiveSingleHistoryCount()` — floor((rows-10)/4), cap 10, floor 2
  - `historyLinesForRunningCount()` — 1 running → 2 lines, 2-4 → 1, 5+ → 0
  - `rightAlignSuffix()` — pads sparkline to terminal width, drops if overflow
  - `renderSingleCompact()` — single-agent compact card (sparkline, current, history, status)
  - `renderMultiCompact()` — chain/parallel card with chainBar, step rows, per-step spark+current+history
  - `renderSubagentResult()` — top-level dispatcher, routes to compact or expanded view
  - `renderWidget()` — async jobs sidebar widget with spinner animation
- `formatters.ts` — formatTokens (k-suffix), formatDuration (ms/s/m), formatUsage, formatToolCall, shortenPath, buildChainSummary

## Helpers (`utils.ts`)
- `extractToolArgsPreview()` — extracts the most informative arg per tool type (grep pattern+path, read offset/limit, MCP server/tool, web search queries, bash command); truncates and shows +N for arrays
- `getDisplayItems()`, `getLastActivity()`, `getSingleResultOutput()`, `detectSubagentError()`, `stripXmlMetadataTags()`, `compactForegroundResult()`

## Supporting Modules
- `render-helpers.ts` — fuzzyFilter, row/renderHeader/renderFooter box builders, formatPath, formatScrollInfo
- `run-shape.ts` — pure helpers `formatRunHandle`, `describeAgentLabel`, `formatShapeBadge`, and `RunMode` type centralizing chain/parallel/single run-shape labeling across spawn confirmations, completion notifications, widget, and dashboard
- `chain-execution.ts` — sequential step runner with worktree setup, foregroundControl per step, fail-fast
- `subagent-control.ts` — needs_attention event derivation, notification claiming, shouldEmit/shouldNotify guards
- `subagent-runner.ts` — async job persistence (status.json, result.json), JSONL aggregation, worktree lifecycle; `runMode` is `parallel`|`chain`|`single`, and `subagent.step.started` events carry `task`
- `slash-live-state.ts` — builds initial placeholder results for slash-command live cards
- `async-status.ts` — async status reporting; `AsyncRunStepSummary.color` carries the per-step agent color
- `async-job-tracker.ts` — in-memory tracker for async jobs; `AsyncJobState.agentColors[]` mirrors per-step colors into the job tracker
- `subagents-status.ts` — `/subagents-status` overlay; `sortLiveRuns` pins `needs_attention` rows to top, remaining strictly `startedAt` desc; `buildRightLines` groups events by `stepIndex` and renders each step's task prompt
- `events-log.ts` — `EventLogLine` types; `step-start` events carry the `task` field
- `prompt-template-bridge.ts` — bridges progress updates to prompt-template consumers, sanitizes recentTools for delegation
- `skills.ts` — skill resolution and injection
- `artifacts.ts` — writeArtifact, writeMetadata, artifact path management
- `model-fallback.ts` — model candidate building, retry logic, attempt notes

## File Inventory (root .ts files)
- index.ts (entry)
- types.ts (interfaces)
- execution.ts (runSync)
- subagent-executor.ts (orchestrator)
- subagent-runner.ts (async jobs)
- subagent-control.ts (control events)
- chain-execution.ts (sequential steps)
- render.ts (live rendering)
- formatters.ts (display formatting)
- render-helpers.ts (UI helpers)
- utils.ts (utilities)
- settings.ts (agent configs)
- agents.ts (agent registry)
- pi-args.ts (pi CLI args)
- pi-spawn.ts (subprocess spawn)
- jsonl-writer.ts (stdout → JSONL file)
- slash-live-state.ts (slash command state)
- prompt-template-bridge.ts (delegation bridge)
- artifacts.ts (file artifacts)
- model-fallback.ts (model retry)
- post-exit-stdio-guard.ts (stderr guard)
- single-output.ts (output capture)
- session-tokens.ts (token usage)
- worktree.ts (worktree setup/diff)
- parallel-utils.ts (concurrency helpers)
- run-shape.ts (run-shape labeling helpers)
- fork-context.ts (subagent execution context resolver — `fresh` vs `fork` session branching)
- subagent-prompt-runtime.ts (runtime helpers for stripping inherited project-context/skills sections from subagent prompts)
- chain-execution.ts (sequential chain step runner)
