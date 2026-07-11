/**
 * Register the .js → .ts loader hook for integration tests.
 *
 * Usage: node --experimental-transform-types --import ./test/support/register-loader.mjs --test test/integration/*.test.ts
 *
 * Handles two issues:
 * 1. Source files use .js import extensions (TypeScript ESM convention) but
 *    files on disk are .ts — the loader rewrites .js → .ts at resolve time.
 * 2. Some source files use TypeScript parameter properties (constructor(private x: T))
 *    which require --experimental-transform-types (not just strip-types).
 *
 * Side-effect import isolate-registry.mjs so integration tests cannot pollute
 * the real ~/.pi/agent/pi-subagents/runs-index.jsonl.
 */

import { register } from "node:module";
import "./scrub-env.mjs";
import "./isolate-registry.mjs";

register(new URL("./ts-loader.mjs", import.meta.url));
