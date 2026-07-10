import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { processGlobal, __resetProcessGlobalForTest } from "../../src/shared/process-global.ts";

describe("processGlobal", () => {
	it("returns the same slot for the same key across duplicate module instances", async () => {
		// Simulate the host's in-process reload: two cache-busted imports of the SAME
		// module are distinct instances, but processGlobal must hand both the same
		// underlying state so live coordination survives a reload.
		const url = new URL("../../src/shared/process-global.ts", import.meta.url).href;
		const m1 = (await import(`${url}?instance-a`)) as typeof import("../../src/shared/process-global.ts");
		const m2 = (await import(`${url}?instance-b`)) as typeof import("../../src/shared/process-global.ts");
		try {
			const a = m1.processGlobal("pi.subagents.test.pgIdentity", () => new Map<string, number>());
			const b = m2.processGlobal("pi.subagents.test.pgIdentity", () => new Map<string, number>());
			assert.equal(a, b, "two module instances must share one slot");
			a.set("x", 1);
			assert.equal(b.get("x"), 1);
		} finally {
			m1.__resetProcessGlobalForTest("pi.subagents.test.pgIdentity");
		}
	});

	it("creates once and caches; reset clears the slot", () => {
		try {
			let creates = 0;
			const first = processGlobal("pi.subagents.test.pgCache", () => {
				creates++;
				return { n: creates };
			});
			const second = processGlobal("pi.subagents.test.pgCache", () => {
				creates++;
				return { n: creates };
			});
			assert.equal(first, second);
			assert.equal(creates, 1);
			__resetProcessGlobalForTest("pi.subagents.test.pgCache");
			const third = processGlobal("pi.subagents.test.pgCache", () => ({ n: 99 }));
			assert.equal(third.n, 99);
		} finally {
			__resetProcessGlobalForTest("pi.subagents.test.pgCache");
		}
	});
});
