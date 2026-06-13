import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { selectRootRole } from "../../src/shared/root-role-selection.ts";
import type { AgentConfig } from "../../src/shared/agents.ts";

function role(name: string): AgentConfig {
	return {
		name,
		description: `${name} role`,
		model: "mock/model",
		systemPromptMode: "append",
		inheritProjectContext: true,
		inheritSkills: false,
		systemPrompt: "",
		source: "user",
		filePath: `<${name}>`,
		surface: "main",
	};
}

describe("root role selection", () => {
	const roles = [role("captain"), role("builder"), role("auditor")];

	it("uses explicit and configured roles when they exist", () => {
		assert.equal(selectRootRole(roles, { roleFlag: "auditor", defaultRole: "captain" })?.name, "auditor");
		assert.equal(selectRootRole(roles, { envRole: "builder", defaultRole: "captain" })?.name, "builder");
		assert.equal(selectRootRole(roles, { restoredRole: "auditor", defaultRole: "captain" })?.name, "auditor");
		assert.equal(selectRootRole(roles, { defaultRole: "builder" })?.name, "builder");
	});

	it("falls back to the first discovered role without inventing persona names", () => {
		assert.equal(selectRootRole(roles, { defaultRole: "missing" })?.name, "captain");
		assert.equal(selectRootRole(roles, { roleFlag: "orchestrator", envRole: "main", restoredRole: "missing" })?.name, "captain");
	});

	it("returns undefined when no roles are available", () => {
		assert.equal(selectRootRole([], { defaultRole: "captain" }), undefined);
	});
});
