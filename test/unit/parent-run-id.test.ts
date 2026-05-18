import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { statusToSummary } from "../../async-status.ts";
import { foregroundRunsFromState } from "../../subagents-status.ts";
import { getSubagentIdentityEnv, type AsyncStatus, type SubagentState } from "../../types.ts";

describe("parent run id plumbing", () => {
	it("copies parentRunId from AsyncStatus to AsyncRunSummary", () => {
		const status: AsyncStatus = {
			runId: "child-1",
			parentRunId: "parent-1",
			mode: "single",
			state: "running",
			startedAt: 1,
			steps: [{ agent: "fixer", status: "running" }],
		};
		assert.equal(statusToSummary("/tmp/child-1", status).parentRunId, "parent-1");
	});

	it("copies parentRunId from foreground controls", () => {
		const controls = new Map<string, SubagentState["foregroundControls"] extends Map<string, infer T> ? T : never>();
		controls.set("child-2", { runId: "child-2", parentRunId: "parent-2", mode: "single", startedAt: 1, updatedAt: 2 });
		const runs = foregroundRunsFromState({ foregroundControls: controls });
		assert.equal(runs[0]?.parentRunId, "parent-2");
	});

	it("emits PI_SUBAGENT_PARENT_RUN_ID from identity env", () => {
		assert.equal(getSubagentIdentityEnv("fixer", undefined, { parentRunId: "parent-3" }).PI_SUBAGENT_PARENT_RUN_ID, "parent-3");
	});

	it("persists PI_SUBAGENT_PARENT_RUN_ID-shaped status payloads", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "parent-run-id-"));
		try {
			fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({
				runId: "child-4",
				parentRunId: "parent-abc",
				mode: "single",
				state: "running",
				startedAt: 1,
				steps: [{ agent: "worker", status: "running" }],
			}), "utf-8");
			const parsed = JSON.parse(fs.readFileSync(path.join(dir, "status.json"), "utf-8"));
			assert.equal(parsed.parentRunId, "parent-abc");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
