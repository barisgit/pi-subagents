import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { it } from "node:test";
import { createRootRoleManager } from "../../src/runtime/root-role-manager.ts";

it("applies max thinking when activating a root role and ignores invalid values", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "root-role-thinking-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = path.join(cwd, "agent");
	const levels: string[] = [];
	const manager = createRootRoleManager({
		pi: {
			getFlag: (name: string) => (name === "role" ? "test-role" : undefined),
			appendEntry: () => {},
			setThinkingLevel: (level: string) => levels.push(level),
		} as never,
		config: {},
		state: { baseCwd: cwd } as never,
		setHostCurrentAgent: () => {},
		notify: () => {},
		normalizeName: (value) => (typeof value === "string" ? value : undefined),
		getLatestCustomStateName: () => undefined,
	});
	const agentPath = path.join(cwd, ".pi", "agents", "test-role.md");
	fs.mkdirSync(path.dirname(agentPath), { recursive: true });
	try {
		for (const thinking of ["max", "invalid"]) {
			fs.writeFileSync(
				agentPath,
				`---\nname: test-role\ndescription: Test role\nsurface: main\nthinking: ${thinking}\n---\nTest role.\n`,
			);
			await manager.initializeRootRole({
				cwd,
				hasUI: false,
				modelRegistry: { getAvailable: () => [], find: () => undefined },
			} as never);
		}
		assert.deepEqual(levels, ["max"]);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
