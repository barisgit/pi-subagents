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
		const controls = new Map<
			string,
			SubagentState["foregroundControls"] extends Map<string, infer T> ? T : never
		>();
		controls.set("child-2", {
			runId: "child-2",
			parentRunId: "parent-2",
			mode: "single",
			startedAt: 1,
			updatedAt: 2,
		});
		const runs = foregroundRunsFromState({ foregroundControls: controls });
		assert.equal(runs[0]?.parentRunId, "parent-2");
	});

	it("renders a foreground run queued until it has started, then running", () => {
		type Control = SubagentState["foregroundControls"] extends Map<string, infer T> ? T : never;
		const controls = new Map<string, Control>();
		// Opened but not yet started (e.g. blocked on the leaf-concurrency pool): the
		// live dashboard view must read "queued", never "running", or a permit-blocked
		// run looks active. deriveRunDisplayState maps queued -> quiet (not lost).
		controls.set("blocked", { runId: "blocked", mode: "single", startedAt: 1, updatedAt: 2 });
		const blocked = foregroundRunsFromState({ foregroundControls: controls })[0];
		assert.equal(blocked?.state, "queued");
		assert.equal(blocked?.displayState, "quiet");

		// Once the run produces progress (started=true), it flips to running.
		controls.set("active", { runId: "active", mode: "single", startedAt: 1, updatedAt: 2, started: true });
		const active = foregroundRunsFromState({ foregroundControls: controls }).find((r) => r.id === "active");
		assert.equal(active?.state, "running");
	});

	it("copies executionStartedAt from foreground controls when present", () => {
		type Control = SubagentState["foregroundControls"] extends Map<string, infer T> ? T : never;
		const controls = new Map<string, Control>();
		controls.set("started", {
			runId: "started",
			mode: "single",
			startedAt: 1,
			updatedAt: 2,
			started: true,
			executionStartedAt: 5,
		});
		controls.set("queued", { runId: "queued", mode: "single", startedAt: 1, updatedAt: 2 });
		const runs = foregroundRunsFromState({ foregroundControls: controls });
		assert.equal(runs.find((r) => r.id === "started")?.executionStartedAt, 5);
		// A queued control has no execution-start instant yet.
		assert.equal(runs.find((r) => r.id === "queued")?.executionStartedAt, undefined);
	});

	it("copies executionStartedAt from PersistedRunStatus to RunView (absent stays undefined)", () => {
		const withStamp: PersistedRunStatus = {
			runId: "child-x",
			mode: "single",
			state: "running",
			startedAt: 1,
			executionStartedAt: 9,
			steps: [{ agent: "fixer", status: "running" }],
		};
		assert.equal(statusToRunView("/tmp/child-x", withStamp).executionStartedAt, 9);
		// Old record lacking the field stays undefined (backward compatible).
		const noStamp: PersistedRunStatus = { ...withStamp, executionStartedAt: undefined };
		assert.equal(statusToRunView("/tmp/child-x", noStamp).executionStartedAt, undefined);
	});

	it("emits PI_SUBAGENT_PARENT_RUN_ID from identity env", () => {
		assert.equal(
			getSubagentIdentityEnv("fixer", undefined, { parentRunId: "parent-3" }).PI_SUBAGENT_PARENT_RUN_ID,
			"parent-3",
		);
	});

	it("persists PI_SUBAGENT_PARENT_RUN_ID-shaped status payloads", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "parent-run-id-"));
		try {
			fs.writeFileSync(
				path.join(dir, "status.json"),
				JSON.stringify({
					runId: "child-4",
					parentRunId: "parent-abc",
					mode: "single",
					state: "running",
					startedAt: 1,
					steps: [{ agent: "worker", status: "running" }],
				}),
				"utf-8",
			);
			const parsed = JSON.parse(fs.readFileSync(path.join(dir, "status.json"), "utf-8"));
			assert.equal(parsed.parentRunId, "parent-abc");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
