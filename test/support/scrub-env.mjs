/**
 * Scrub agent-session environment variables before any test module imports
 * src code, so the suite is hermetic regardless of the caller's environment
 * (e.g. `npm test` run from inside a live pi/fo agent session).
 *
 * Cleared at startup only — individual tests that deliberately set these vars
 * (e.g. the preset tests set PI_PRESET) still work.
 *
 * Loaded via `--import ./test/support/scrub-env.mjs` from the unit test script
 * and via register-loader.mjs for integration tests.
 */

delete process.env.PI_PRESET;
delete process.env.PI_PACKAGE_DIR;

// App-name-derived agent-dir overrides, e.g. PI_CODING_AGENT_DIR or
// FO_CODING_AGENT_DIR. Any of them leaking in repoints getAgentDir().
for (const key of Object.keys(process.env)) {
	if (/^[A-Z0-9]+_CODING_AGENT_DIR$/.test(key)) delete process.env[key];
}
