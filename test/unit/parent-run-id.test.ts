import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { statusToRunView } from "../../src/state/async-status.ts";
import { foregroundRunsFromState } from "../../src/surfaces/subagents-status.ts";
import { getSubagentIdentityEnv, type SubagentState } from "../../src/protocol/types.ts";
import type { PersistedRunStatus } from "../../src/protocol/status-types.ts";

describe("parent run id plumbing", () => {
	it("copies parentRunId from PersistedRunStatus to AsyncRunSummary", () => {
		const status: PersistedRunStatus = {
			runId: "child-1",
			parentRunId: "parent-1",
			mode: "single",
			state: "running",
			startedAt: 1,
			steps: [{ agent: "fixer", status: "running" }],
		};
		assert.equal(statusToRunView("/tmp/child-1", status).parentRunId, "parent-1");
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
