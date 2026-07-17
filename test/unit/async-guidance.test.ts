import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatAsyncStatusHint } from "../../src/surfaces/async-guidance.ts";

describe("async guidance", () => {
	it("offers resume as direct steering without a prior interrupt", () => {
		const hint = formatAsyncStatusHint("run-123");

		assert.match(hint, /action: "resume"/);
		assert.match(hint, /No interrupt needed/i);
		assert.match(hint, /action: "status"/);
	});
});
