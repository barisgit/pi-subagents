import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { AsyncJobState } from "../../src/protocol/types.ts";
import { buildWidgetLines, stopWidgetAnimation } from "../../src/surfaces/render-widget.ts";

const theme = {
	fg: (_name: string, text: string) => text,
	bold: (text: string) => text,
};

function job(partial: Partial<AsyncJobState>): AsyncJobState {
	return {
		asyncId: "a",
		asyncDir: "/tmp/a",
		status: "running",
		displayState: "quiet",
		mode: "single",
		startedAt: 1_000,
		updatedAt: 2_000,
		...partial,
	} as AsyncJobState;
}

afterEach(() => stopWidgetAnimation());

describe("widget queued rendering", () => {
	it("renders a queued job as 'queued' with no ticking elapsed", () => {
		const lines = buildWidgetLines([job({ asyncId: "q", status: "queued", agents: ["explorer"] })], theme, 200);
		const body = lines.join("\n");
		assert.match(body, /queued/);
		// Must NOT show the 'quiet' activity label for a queued job.
		assert.doesNotMatch(body, /quiet/);
	});

	it("collapses overflow of all-queued jobs into '+N queued'", () => {
		// 6 queued jobs, MAX_WIDGET_JOBS=4 visible -> 2 hidden, all queued.
		const jobs = Array.from({ length: 6 }, (_, i) =>
			job({ asyncId: `q${i}`, status: "queued", agents: ["explorer"] }),
		);
		const lines = buildWidgetLines(jobs, theme, 200);
		assert.match(lines.join("\n"), /\+\d+ queued/);
	});
});
