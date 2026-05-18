import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { asyncIntegrationSkipReason } from "../support/integration-gate.ts";

describe("asyncIntegrationSkipReason", () => {
	it("skips by default when detached-child integration env is unset", () => {
		const reason = asyncIntegrationSkipReason({}, true);
		assert.match(reason ?? "", /PI_RUN_ASYNC_INTEGRATION/);
	});

	it("skips when detached-child integration env is not 1", () => {
		const reason = asyncIntegrationSkipReason({ PI_RUN_ASYNC_INTEGRATION: "0" }, true);
		assert.match(reason ?? "", /PI_RUN_ASYNC_INTEGRATION/);
	});

	it("allows tests when detached-child integration env is 1 and jiti is available", () => {
		const reason = asyncIntegrationSkipReason({ PI_RUN_ASYNC_INTEGRATION: "1" }, true);
		assert.equal(reason, undefined);
	});

	it("skips for missing jiti after detached-child integration env opt-in", () => {
		const reason = asyncIntegrationSkipReason({ PI_RUN_ASYNC_INTEGRATION: "1" }, false);
		assert.equal(reason, "jiti not available");
	});
});
