import { describe, test, before, after } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Hermetic: point the Pi agent dir at a temp dir BEFORE importing the config
// module, so module-level SUBAGENT_CONFIG_* constants resolve under the temp
// tree. All file IO happens inside the temp dir; real user config is untouched.
//
// CRITICAL: SUBAGENT_CONFIG_PRIMARY is a load-time const derived from
// getAgentDir(). The unit runner evaluates every *.test.ts in one process with a
// shared module registry, so by the time this file's before() runs, config.ts
// has almost certainly already been imported (transitively) under the real HOME
// and cached. A plain `await import("../../src/shared/config.ts")` would hand back
// that cached module, leaving the constant pointed at the user's real
// ~/.pi/agent/subagent.json -- and the invalid-JSON test below would clobber it.
// We therefore force a FRESH module evaluation with a cache-busting query AFTER
// the env override, then assert the path actually resolved under the temp tree
// before any test writes a byte.
const tmpHome = path.join(os.tmpdir(), "pi-subagent-config-test");
const tmpAgentDir = path.join(tmpHome, ".pi", "agent");
const origHome = process.env.HOME;
const origPiAgentDir = process.env.PI_CODING_AGENT_DIR;
const origFiAgentDir = process.env.FI_CODING_AGENT_DIR;

type ConfigModule = typeof import("../../src/shared/config.ts");
let mod: ConfigModule;

before(async () => {
	process.env.HOME = tmpHome;
	process.env.PI_CODING_AGENT_DIR = tmpAgentDir;
	process.env.FI_CODING_AGENT_DIR = tmpAgentDir;
	fs.mkdirSync(tmpAgentDir, { recursive: true });
	// Cache-bust so the module re-evaluates under the temp env set above, rather
	// than returning a copy cached from an earlier import under the real HOME.
	mod = (await import(`../../src/shared/config.ts?hermetic=${Date.now()}`)) as ConfigModule;
	// Defense in depth: never let this suite touch a path outside the temp tree,
	// even if env resolution silently regresses in the future.
	if (!mod.SUBAGENT_CONFIG_PRIMARY.startsWith(tmpHome)) {
		throw new Error(
			`config.test.ts refused to run: config path escaped the temp dir (would risk the real user config). ` +
				`primary=${mod.SUBAGENT_CONFIG_PRIMARY} tmpHome=${tmpHome}`,
		);
	}
});

after(() => {
	if (origHome === undefined) delete process.env.HOME;
	else process.env.HOME = origHome;
	if (origPiAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = origPiAgentDir;
	if (origFiAgentDir === undefined) delete process.env.FI_CODING_AGENT_DIR;
	else process.env.FI_CODING_AGENT_DIR = origFiAgentDir;
	fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("expandTilde", () => {
	test("expands a leading ~/ to the home directory", () => {
		assert.strictEqual(mod.expandTilde("~/foo"), path.join(os.homedir(), "foo"));
	});

	test("passes absolute paths through unchanged", () => {
		assert.strictEqual(mod.expandTilde("/abs/x"), "/abs/x");
	});

	test("passes relative paths through unchanged", () => {
		assert.strictEqual(mod.expandTilde("rel/x"), "rel/x");
	});

	test("passes a bare ~ (not ~/) through unchanged", () => {
		assert.strictEqual(mod.expandTilde("~"), "~");
	});
});

describe("resolveConfigPath", () => {
	test("returns the primary path when it exists", () => {
		fs.writeFileSync(mod.SUBAGENT_CONFIG_PRIMARY, "{}");
		assert.strictEqual(mod.resolveConfigPath(), mod.SUBAGENT_CONFIG_PRIMARY);
	});

	test("returns the primary path when it does not exist", () => {
		fs.rmSync(mod.SUBAGENT_CONFIG_PRIMARY, { force: true });
		assert.strictEqual(mod.resolveConfigPath(), mod.SUBAGENT_CONFIG_PRIMARY);
	});
});

describe("loadConfig", () => {
	test("returns {} when no config file is present", () => {
		fs.rmSync(mod.SUBAGENT_CONFIG_PRIMARY, { force: true });
		assert.deepStrictEqual(mod.loadConfig(), {});
	});

	test("parses and returns the config from the primary file", () => {
		fs.writeFileSync(mod.SUBAGENT_CONFIG_PRIMARY, JSON.stringify({ asyncByDefault: true }));
		assert.deepStrictEqual(mod.loadConfig(), { asyncByDefault: true });
	});

	test("returns {} and does not throw on invalid JSON", () => {
		fs.writeFileSync(mod.SUBAGENT_CONFIG_PRIMARY, "{ not valid json");
		assert.deepStrictEqual(mod.loadConfig(), {});
	});
});
