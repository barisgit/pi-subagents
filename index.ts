/**
 * Subagent Tool
 *
 * Full-featured subagent with sync and async modes.
 * - Sync (default): Streams output, renders markdown, tracks usage
 * - Async: Background execution, emits events when done
 *
 * Modes: run[] or management via action/id.
 * Toggle: async parameter (default: false, configurable via config.json)
 *
 * Config file: ~/.pi/agent/subagent.json
 *   { "asyncByDefault": true, "forceTopLevelAsync": true, "maxSubagentDepth": 1, "intercomBridge": { "mode": "always", "instructionFile": "./intercom-bridge.md" }, "worktreeSetupHook": "./scripts/setup-worktree.mjs" }
 *
 * This file is intentionally a thin entry-point shell: the pi extension manifest
 * (package.json) registers `./index.ts`, so the real composition root lives in
 * `src/runtime/extension-runtime.ts`. Keep activation logic there, not here.
 */

export { default } from "./src/runtime/extension-runtime.ts";
