import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { readStatus } from "../../src/shared/utils.ts";

function createRunDir(status: Record<string, unknown>): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-read-status-reconcile-"));
	fs.writeFileSync(
		path.join(dir, "status.json"),
		JSON.stringify({
			mode: "single",
			startedAt: Date.now(),
			...status,
		}),
		"utf-8",
	);
	return dir;
}

describe("readStatus liveness reconciliation", () => {
	it("marks stale running statuses as lost without mutating disk", () => {
		const dir = createRunDir({ runId: "read-status-stale", state: "running" });
		try {
			const stale = new Date(Date.now() - 15 * 60 * 1000);
			fs.utimesSync(path.join(dir, "status.json"), stale, stale);

			const status = readStatus(dir);
			assert.equal(status?.state, "lost");
			const raw = JSON.parse(fs.readFileSync(path.join(dir, "status.json"), "utf-8"));
			assert.equal(raw.state, "running");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("preserves fresh running statuses", () => {
		const dir = createRunDir({ runId: "read-status-fresh", state: "running" });
		try {
			const fresh = new Date(Date.now() - 30 * 1000);
			fs.utimesSync(path.join(dir, "status.json"), fresh, fresh);

			const status = readStatus(dir);
			assert.equal(status?.state, "running");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("preserves terminal statuses", () => {
		const dir = createRunDir({ runId: "read-status-terminal", state: "failed" });
		try {
			const status = readStatus(dir);
			assert.equal(status?.state, "failed");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
