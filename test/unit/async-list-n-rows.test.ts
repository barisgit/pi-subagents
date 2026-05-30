import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { createAsyncJobTracker } from "../../async-job-tracker.ts";
import { buildWidgetLines, stopWidgetAnimation } from "../../render.ts";

const tmpRoots: string[] = [];

const theme = {
	fg: (_name: string, text: string) => text,
	bold: (text: string) => text,
};

function createState() {
	return {
		baseCwd: "/repo",
		currentSessionId: null,
		asyncJobs: new Map(),
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null as ReturnType<typeof setInterval> | null,
	};
}

function createPi() {
	return {
		events: {
			emit: (_channel: string, _data: unknown) => {},
		},
	};
}

function createTempRunDirs(count: number): string[] {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "async-list-n-rows-test-"));
	tmpRoots.push(root);
	return Array.from({ length: count }, (_, index) => {
		const runDir = path.join(root, `run-${index + 1}`);
		fs.mkdirSync(runDir, { recursive: true });
		return runDir;
	});
}

afterEach(() => {
	stopWidgetAnimation();
	for (const root of tmpRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("async list parallel rows", () => {
	it("parallel dispatch yields N async rows", () => {
		const state = createState();
		const tracker = createAsyncJobTracker(createPi() as never, state as never, { pollIntervalMs: 60_000 });
		const groupRunId = "group-run";
		const runDirs = createTempRunDirs(3);

		try {
			for (const [index, asyncDir] of runDirs.entries()) {
				tracker.handleStarted({
					id: `child-run-${index + 1}`,
					asyncDir,
					agent: `agent-${index + 1}`,
					parentRunId: groupRunId,
				});
			}

			assert.equal(state.asyncJobs.size, runDirs.length);
			for (const [index] of runDirs.entries()) {
				const job = state.asyncJobs.get(`child-run-${index + 1}`);
				assert.ok(job);
				assert.equal(job.parentRunId, groupRunId);
				assert.equal(job.mode, "parallel");
			}

			const rows = Array.from(state.asyncJobs.values());
			const lines = buildWidgetLines(rows, theme, 200);
			assert.equal(rows.length, runDirs.length);
			assert.equal(lines.length, runDirs.length + 2);
			assert.equal(lines.slice(1, -1).filter((line) => line.includes("parallel(1)")).length, runDirs.length);
		} finally {
			if (state.poller) clearInterval(state.poller);
			state.poller = null;
		}
	});
});
