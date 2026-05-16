# Rendering Pipeline Summary

## Data Flow
1. `execution.ts::runSync()` spawns `pi` subprocess, parses JSONL events (tool_execution_start/end, message_end, tool_result_end), updates `AgentProgress` in real time, fires `onUpdate`
2. Each `message_end` with usage data appends a `{ts, tokens}` entry to `progress.tokenSamples` (capped 300 entries, 250s prune window, ~7KB/agent)
3. `subagent-executor.ts` orchestrates single/chain/parallel modes, merges live progress from concurrent tasks

## Rendering (render.ts ~1100 lines)
4. `renderWidget()` — top-level async jobs sidebar with sparkle spinner animation via `setInterval` at WIDGET_ANIMATION_MS
5. `multiSpinnerFrame()` — cycles 11 Unicode stars (✳✴✵✶✷✸✹✺✻✼✽) for top-level liveness; per-agent rows use static `resultGlyph()` (◇ running, ■ paused, ✗ error, ✓ success)
6. `buildSparkline(samples, width, theme, now)` — token-rate sparkline using 8 block chars, wall-clock quantized cells (240s window), normalized to per-bucket peak; freezes at last sample timestamp on completion
7. `buildLiveCurrentLine(progress, width)` — priority: needs_attention warning → current tool → thinking timer → starting; returns `{text, tone}`
8. `buildLiveHistoryLines()` — renders `recentTools.slice(-count).reverse()` as `← tool: args  Nms` breadcrumb lines
9. `buildWidgetLines()` — assembles the async-jobs widget rows from live runs (sort via `sortLiveRuns`)
10. `buildWidgetComponent()` — factory `(_tui, theme) => Component` returning a no-margin-collapse Component wrapping `buildWidgetLines`
11. Imports `describeAgentLabel` / `formatShapeBadge` from `run-shape.ts` for centralized label/badge formatting
