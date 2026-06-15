import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { handleList } from "../../src/surfaces/agent-management.ts";

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

	it("lists internal agents only when includeInternal is true", () => {
		const agentsDir = path.join(tempDir, ".pi", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.writeFileSync(
			path.join(agentsDir, "visible.md"),
			`---
name: visible
description: Visible helper
---

Visible
`,
			"utf-8",
		);
		fs.writeFileSync(
			path.join(agentsDir, "hidden.md"),
			`---
name: hidden
description: Hidden helper
scope: internal
---

Hidden
`,
			"utf-8",
		);

		const defaultList = readText(
			handleList(
				{},
				{
					cwd: tempDir,
					modelRegistry: {
						getAvailable: () => [],
					} as unknown as import("@earendil-works/pi-coding-agent").ExtensionContext["modelRegistry"],
				},
			),
		);
		assert.match(defaultList, /visible/);
		assert.doesNotMatch(defaultList, /hidden/);

		const internalList = readText(
			handleList(
				{ includeInternal: true },
				{
					cwd: tempDir,
					modelRegistry: {
						getAvailable: () => [],
					} as unknown as import("@earendil-works/pi-coding-agent").ExtensionContext["modelRegistry"],
				},
			),
		);
		assert.match(internalList, /visible/);
		assert.match(internalList, /hidden/);
	});
});
