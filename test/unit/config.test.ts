import { describe, test, before, after } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Hermetic: point HOME at a temp dir BEFORE importing the config module, so its
// module-level SUBAGENT_CONFIG_* constants resolve under the temp home. All file
// IO happens inside the temp dir; the real ~/.pi is never touched.
const tmpHome = path.join(os.tmpdir(), "pi-subagent-config-test");
const origHome = process.env.HOME;

type ConfigModule = typeof import("../../src/shared/config.ts");
let mod: ConfigModule;

before(async () => {
	process.env.HOME = tmpHome;
	fs.mkdirSync(path.join(tmpHome, ".pi", "agent", "extensions", "subagent"), { recursive: true });
	mod = await import("../../src/shared/config.ts");
});

after(() => {
	if (origHome === undefined) delete process.env.HOME;
	else process.env.HOME = origHome;
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

describe("resolveConfigPath precedence", () => {
	test("prefers the primary path when it exists", () => {
		fs.writeFileSync(mod.SUBAGENT_CONFIG_PRIMARY, "{}");
		fs.writeFileSync(mod.SUBAGENT_CONFIG_LEGACY, "{}");
		assert.strictEqual(mod.resolveConfigPath(), mod.SUBAGENT_CONFIG_PRIMARY);
	});

	test("falls back to the legacy path when only it exists", () => {
		fs.rmSync(mod.SUBAGENT_CONFIG_PRIMARY, { force: true });
		fs.writeFileSync(mod.SUBAGENT_CONFIG_LEGACY, "{}");
		assert.strictEqual(mod.resolveConfigPath(), mod.SUBAGENT_CONFIG_LEGACY);
	});

	test("returns the primary path when neither exists", () => {
		fs.rmSync(mod.SUBAGENT_CONFIG_PRIMARY, { force: true });
		fs.rmSync(mod.SUBAGENT_CONFIG_LEGACY, { force: true });
		assert.strictEqual(mod.resolveConfigPath(), mod.SUBAGENT_CONFIG_PRIMARY);
	});
});

describe("loadConfig", () => {
	test("returns {} when no config file is present", () => {
		fs.rmSync(mod.SUBAGENT_CONFIG_PRIMARY, { force: true });
		fs.rmSync(mod.SUBAGENT_CONFIG_LEGACY, { force: true });
		assert.deepStrictEqual(mod.loadConfig(), {});
	});

	test("parses and returns the config from the primary file", () => {
		fs.rmSync(mod.SUBAGENT_CONFIG_LEGACY, { force: true });
		fs.writeFileSync(mod.SUBAGENT_CONFIG_PRIMARY, JSON.stringify({ asyncByDefault: true }));
		assert.deepStrictEqual(mod.loadConfig(), { asyncByDefault: true });
	});

	test("returns {} and does not throw on invalid JSON", () => {
		fs.writeFileSync(mod.SUBAGENT_CONFIG_PRIMARY, "{ not valid json");
		assert.deepStrictEqual(mod.loadConfig(), {});
	});
});
