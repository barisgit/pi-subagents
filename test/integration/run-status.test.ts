import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { inspectSubagentStatus } from "../../run-status.ts";
import { ASYNC_DIR } from "../../types.ts";

describe("run status guidance", () => {
	it("tells callers not to poll running async runs", () => {
		const id = `status-guidance-${Date.now().toString(36)}`;
		const dir = path.join(ASYNC_DIR, id);
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

			const result = inspectSubagentStatus({ id });
			assert.match(result.content[0]?.text ?? "", /Progress: 3\/5 tasks complete/);
			assert.doesNotMatch(result.content[0]?.text ?? "", /Step: 1\/5/);
			assert.match(result.content[0]?.text ?? "", /Polling is not required; do not poll unless you need an immediate update\./);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
