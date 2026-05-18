import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createMockPi, createTempDir, makeAgentConfigs, removeTempDir, tryImport, type MockPi } from "../support/helpers.ts";

interface ExecutionModule {
	runSync(runtimeCwd: string, agents: ReturnType<typeof makeAgentConfigs>, agentName: string, task: string, options: Record<string, unknown>): Promise<{
		progress?: { recentTools: Array<{ tool: string; args: string; rawArgs?: Record<string, unknown> }> };
	}>;
}

const execution = await tryImport<ExecutionModule>("./execution.ts");
const available = !!execution;

describe("recentTools raw args", { skip: !available ? "execution module unavailable" : undefined }, () => {
	let mockPi: MockPi;
	let tempDir: string;

	before(() => {
		mockPi = createMockPi();
		mockPi.install();
	});

	after(() => {
		mockPi.uninstall();
		if (tempDir) removeTempDir(tempDir);
	});

	it("keeps both preview and raw args from tool execution events", async () => {
		tempDir = createTempDir();
		mockPi.onCall({
			exitCode: 0,
			jsonl: [
				{ type: "tool_execution_start", toolName: "read", args: { path: "/abs/foo.ts" } },
				{ type: "tool_execution_end", toolName: "read" },
				{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 2 } } },
			],
		});

		const result = await execution!.runSync(tempDir, makeAgentConfigs(["fixer"]), "fixer", "read file", {});
		assert.equal(result.progress?.recentTools[0]?.tool, "read");
		assert.equal(result.progress?.recentTools[0]?.args, "/abs/foo.ts");
		assert.deepEqual(result.progress?.recentTools[0]?.rawArgs, { path: "/abs/foo.ts" });
	});
});
