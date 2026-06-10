import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { handleCreate, handleList, handleUpdate } from "../../src/surfaces/agent-management.ts";
import { createEditState, handleEditInput } from "../../src/surfaces/agent-manager-edit.ts";

let tempDir = "";
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;

function readText(result: { content: Array<{ type: string; text?: string }> }): string {
	const first = result.content[0];
	assert.ok(first);
	assert.equal(first.type, "text");
	assert.equal(typeof first.text, "string");
	return first.text as string;
}

describe("agent management config parsing", () => {
	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-management-"));
		process.env.HOME = tempDir;
		process.env.USERPROFILE = tempDir;
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		if (originalUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = originalUserProfile;
	});

	it("surfaces JSON parse errors for create config strings", () => {
		const result = handleCreate(
			{ config: '{"name":' },
			{ cwd: tempDir, modelRegistry: { getAvailable: () => [] } as unknown as import("@earendil-works/pi-coding-agent").ExtensionContext["modelRegistry"] },
		);

		assert.equal(result.isError, true);
		assert.match(readText(result), /config must be valid JSON:/);
	});

	it("surfaces JSON parse errors for update config strings", () => {
		const result = handleUpdate(
			{ agent: "reviewer", config: '{"description":' },
			{ cwd: tempDir, modelRegistry: { getAvailable: () => [] } as unknown as import("@earendil-works/pi-coding-agent").ExtensionContext["modelRegistry"] },
		);

		assert.equal(result.isError, true);
		assert.match(readText(result), /config must be valid JSON:/);
	});

	it("lists internal agents only when includeInternal is true", () => {
		const agentsDir = path.join(tempDir, ".pi", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.writeFileSync(path.join(agentsDir, "visible.md"), `---
name: visible
description: Visible helper
---

Visible
`, "utf-8");
		fs.writeFileSync(path.join(agentsDir, "hidden.md"), `---
name: hidden
description: Hidden helper
scope: internal
---

Hidden
`, "utf-8");

		const defaultList = readText(handleList({}, { cwd: tempDir, modelRegistry: { getAvailable: () => [] } as unknown as import("@earendil-works/pi-coding-agent").ExtensionContext["modelRegistry"] }));
		assert.match(defaultList, /visible/);
		assert.doesNotMatch(defaultList, /hidden/);

		const internalList = readText(handleList({ includeInternal: true }, { cwd: tempDir, modelRegistry: { getAvailable: () => [] } as unknown as import("@earendil-works/pi-coding-agent").ExtensionContext["modelRegistry"] }));
		assert.match(internalList, /visible/);
		assert.match(internalList, /hidden/);
	});

	it("creates delegate with its builtin prompt defaults", () => {
		const result = handleCreate(
			{ config: { name: "delegate", description: "Delegate helper", scope: "project" } },
			{ cwd: tempDir, modelRegistry: { getAvailable: () => [] } as unknown as import("@earendil-works/pi-coding-agent").ExtensionContext["modelRegistry"] },
		);

		assert.equal(result.isError, false);
		const filePath = path.join(tempDir, ".pi", "agents", "delegate.md");
		const content = fs.readFileSync(filePath, "utf-8");
		assert.match(content, /systemPromptMode: append/);
		assert.match(content, /inheritProjectContext: true/);
		assert.match(content, /inheritSkills: false/);
	});
});

describe("agent manager edit prompt mode", () => {
	it("preserves explicit append mode when reopening and confirming the field", () => {
		const state = createEditState(
			{
				name: "worker",
				description: "Worker",
				source: "user",
				filePath: "/tmp/worker.md",
				systemPrompt: "Do work",
				systemPromptMode: "append",
				inheritProjectContext: false,
				inheritSkills: false,
			},
			false,
			[],
			[],
		);

		state.fieldIndex = state.fields.indexOf("systemPromptMode");
		const first = handleEditInput("edit", state, "\r", 80, [], []);
		assert.equal(first?.nextScreen, "edit-field");
		assert.equal(state.fieldEditor.buffer, "append");

		const second = handleEditInput("edit-field", state, "\r", 80, [], []);
		assert.equal(second?.nextScreen, "edit");
		assert.equal(state.draft.systemPromptMode, "append");
	});
});
