# Live Progress Rendering Pipeline

1. **Data ingestion** — `execution.ts::runSync()` spawns a `pi` subprocess, parses JSONL events from stdout (`tool_execution_start/end`, `message_end`, `tool_result_end`), updates an `AgentProgress` object in real time, and calls `onUpdate` on every event.

2. **Token sampling** — each `message_end` with usage data appends a `{ts, tokens}` entry to `progress.tokenSamples` (capped at 300 entries, pruned after 250s). This drives the sparkline.

3. **Tool preview extraction** — `extractToolArgsPreview()` (utils.ts) pulls the most informative arg per tool type: grep pattern+path, read offset/limit, MCP server/tool, web search queries, bash command; truncates and shows `+N` for arrays.

4. **Orchestration** — `subagent-executor.ts` runs single/chain/parallel modes, merges live progress from concurrent tasks via indexed `liveResults[]` / `liveProgress[]` arrays, and fans out `onUpdate` callbacks per step.

5. **Animation ticker** — `renderWidget()` uses a `setInterval` at `WIDGET_ANIMATION_MS` (80ms) to refresh the async jobs sidebar widget, calling `multiSpinnerFrame()` for top-level liveness.

6. **Glyph strategy** — `multiSpinnerFrame()` cycles 11 Unicode stars for the top-level parallel/chain/single header only; per-agent rows use the static `resultGlyph()` (◇ running, ■ paused, ✗ error, ✓ success) to avoid visual noise from multiple spinners.

7. **Sparkline** — `buildSparkline(samples, width, theme, now)` buckets samples into `width` cells over a 240s window, computes per-bucket token *rates*, normalizes to peak, and renders with 8 Unicode block chars (▁▂▃▄▅▆▇█). `now` is quantized to cell boundaries to prevent sub-cell "worm" drift.

8. **Sparkline width** — `adaptiveSparkWidth()` scales with terminal: `floor(termWidth/6)`, cap 80. `rightAlignSuffix()` pads the sparkline to terminal width with min 2 spaces; drops sparkline if overflow.

9. **Live current line** — `buildLiveCurrentLine(progress, width)` returns `{text, tone}` with priority: `needs_attention` warning → current tool line → thinking timer → starting.

10. **History lines** — `buildLiveHistoryLines()` renders `recentTools.slice(-count).reverse()` as `← tool: args  Nms` breadcrumb lines. `historyLinesForRunningCount()` adapts density: 1 running → 2 lines, 2-4 → 1, 5+ → 0 to avoid overflow in parallel views.

11. **Render dispatch** — `renderSubagentResult()` routes to `renderSingleCompact()` (single agent: sparkle spinner glyph, sparkline, current, history) or `renderMultiCompact()` (chain/parallel: chainBar, per-step glyphs, per-step spark+current+history). Completion state freezes sparkline at last sample timestamp.

12. **Output assembly** — each card line goes through `truncLine()` which computes visual width via `visibleWidth()` while preserving ANSI styling through the ellipsis using `Intl.Segmenter` for proper Unicode/emoji handling.
