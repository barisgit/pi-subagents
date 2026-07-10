import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("production installation", () => {
	it("installs without development dependencies", () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-production-install-"));
		tempDirs.push(tempDir);

		const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf-8")) as {
			scripts: { prepare: string };
		};
		fs.writeFileSync(
			path.join(tempDir, "package.json"),
			JSON.stringify({
				name: "production-install-test",
				private: true,
				scripts: { prepare: packageJson.scripts.prepare },
			}),
		);
		fs.cpSync(path.join(projectRoot, ".husky"), path.join(tempDir, ".husky"), { recursive: true });

		const npm = process.platform === "win32" ? "npm.cmd" : "npm";
		const result = spawnSync(npm, ["install", "--omit=dev", "--no-package-lock"], {
			cwd: tempDir,
			encoding: "utf-8",
		});

		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
	});
});
