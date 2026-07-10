/**
 * Redirects the subagent runs registry to a per-pid temp file so unit and
 * integration tests that exercise the real executor never write to the
 * user-visible ~/.pi/agent/pi-subagents/runs-index.jsonl. Individual tests can
 * still call setRegistryPathForTests() to swap in their own path.
 *
 * Loaded via `--import ./test/support/isolate-registry.mjs` from the npm test
 * scripts. Safe to import multiple times; only sets the env var when missing.
 */

import * as os from "node:os";
import * as path from "node:path";

if (!process.env.PI_SUBAGENTS_REGISTRY_PATH) {
	process.env.PI_SUBAGENTS_REGISTRY_PATH = path.join(os.tmpdir(), `pi-subagents-test-registry-${process.pid}.jsonl`);
}
