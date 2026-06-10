import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { inspectSubagentStatus } from "../../src/state/run-status.ts";
import { appendRunEntry, setRegistryPathForTests } from "../../src/state/runs-registry.ts";

describe("run status guidance", () => {
	it("tells callers not to poll running async runs", () => {
		const id = `status-guidance-${Date.now().toString(36)}`;
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "run-status-"));
		setRegistryPathForTests(path.join(dir, "runs-index.jsonl"));
		fs.mkdirSync(dir, { recursive: true });
		try {
			fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({
				runId: id,
				mode: "parallel",
				state: "running",
				startedAt: Date.now(),
				lastUpdate: Date.now(),
				steps: [
					{ agent: "review", status: "complete" },
					{ agent: "review", status: "running" },
					{ agent: "review", status: "failed" },
					{ agent: "review", status: "complete" },
					{ agent: "review", status: "running" },
				],
			}), "utf-8");
			appendRunEntry({ runId: id, runRecordDir: dir, mode: "parallel", source: "async", agentNames: ["review"], cwd: process.cwd(), startedAt: Date.now() });

			const result = inspectSubagentStatus({ id });
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			assert.match(text, /Progress: 3\/5 tasks complete/);
			assert.doesNotMatch(text, /Step: 1\/5/);
			assert.match(text, /Pi will send a completion or needs-attention message and trigger a new turn/);
			assert.match(text, /Use status\/sleep checks only when immediate inspection is genuinely necessary/);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
			setRegistryPathForTests(null);
		}
	});
});
