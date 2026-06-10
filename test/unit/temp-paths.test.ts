import assert from "node:assert/strict";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
	RUNS_DIR,
	TEMP_ARTIFACTS_DIR,
	BASE_TEMP_DIR,
	resolveTempScopeId,
} from "../../types.ts";

describe("resolveTempScopeId", () => {
	it("prefers uid when available", () => {
		const scope = resolveTempScopeId({
			getuid: () => 501,
			env: { USER: "alice" },
			userInfo: () => ({ username: "alice" }),
		});
		assert.equal(scope, "uid-501");
	});

	it("falls back to environment usernames when uid is unavailable", () => {
		const scope = resolveTempScopeId({
			getuid: undefined,
			env: { USERNAME: "Alice Example" },
			userInfo: () => ({ username: "ignored" }),
		});
		assert.equal(scope, "user-Alice-Example");
	});

	it("falls back to os.userInfo when environment is missing", () => {
		const scope = resolveTempScopeId({
			getuid: undefined,
			env: {},
			userInfo: () => ({ username: "svc_account" }),
		});
		assert.equal(scope, "user-svc_account");
	});

	it("falls back to home path when os.userInfo throws", () => {
		const scope = resolveTempScopeId({
			getuid: undefined,
			env: {},
			userInfo: () => {
				throw new Error("uv_os_get_passwd returned ENOENT");
			},
			homedir: () => "/home/12345/app user",
		});
		assert.equal(scope, "home-home-12345-app-user");
	});
});

describe("shared temp paths", () => {
	it("anchors shared temp directories under one scoped root", () => {
		assert.equal(path.dirname(RUNS_DIR), BASE_TEMP_DIR);
		assert.equal(path.dirname(TEMP_ARTIFACTS_DIR), BASE_TEMP_DIR);
		assert.match(path.basename(BASE_TEMP_DIR), /^pi-subagents-/);
		assert.equal(path.basename(RUNS_DIR), "async-subagent-runs");
		assert.equal(path.basename(TEMP_ARTIFACTS_DIR), "artifacts");
	});
});
