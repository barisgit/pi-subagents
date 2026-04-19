import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { discoverAgents, discoverAgentsAll } from "../../agents.ts";

let tempHome = "";
let tempProject = "";
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalPreset = process.env.PI_PRESET;
const originalLegacyPreset = process.env.OH_MY_OPENCODE_SLIM_PRESET;

function writeJson(filePath: string, value: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

function writeProjectAgent(name: string, model = "anthropic/claude-sonnet-4"): void {
	const filePath = path.join(tempProject, ".pi", "agents", `${name}.md`);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, `---
name: ${name}
description: ${name} agent
model: ${model}
---
You are ${name}.
`, "utf-8");
}

describe("agent presets", () => {
	beforeEach(() => {
		tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-presets-home-"));
		tempProject = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-presets-project-"));
		process.env.HOME = tempHome;
		process.env.USERPROFILE = tempHome;
		delete process.env.PI_PRESET;
		delete process.env.OH_MY_OPENCODE_SLIM_PRESET;
		writeProjectAgent("fixer");
	});

	afterEach(() => {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		if (originalUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = originalUserProfile;
		if (originalPreset === undefined) delete process.env.PI_PRESET;
		else process.env.PI_PRESET = originalPreset;
		if (originalLegacyPreset === undefined) delete process.env.OH_MY_OPENCODE_SLIM_PRESET;
		else process.env.OH_MY_OPENCODE_SLIM_PRESET = originalLegacyPreset;
		fs.rmSync(tempHome, { recursive: true, force: true });
		fs.rmSync(tempProject, { recursive: true, force: true });
	});

	it("applies explicit preset overlays during discovery", () => {
		writeJson(path.join(tempHome, ".pi", "agent", "extensions", "subagent", "config.json"), {
			defaultPreset: "default-preset",
			presets: {
				fast: { agents: { fixer: { model: "openai/gpt-5-mini", thinking: "high" } } },
				"default-preset": { agents: { fixer: { model: "google/gemini-2.5-pro" } } },
			},
		});

		const result = discoverAgents(tempProject, "project", { preset: "fast" });
		const fixer = result.agents.find((agent) => agent.name === "fixer");
		assert.ok(fixer);
		assert.equal(fixer.model, "openai/gpt-5-mini");
		assert.equal(fixer.thinking, "high");
		assert.equal(result.preset.requested, "fast");
		assert.equal(result.preset.applied, "fast");
		assert.equal(result.preset.source, "param");
		assert.deepEqual(result.preset.warnings, []);
	});

	it("resolves preset precedence as explicit > PI_PRESET > legacy env > config default", () => {
		writeJson(path.join(tempHome, ".pi", "agent", "extensions", "subagent", "config.json"), {
			defaultPreset: "config-default",
			presets: {
				"config-default": { agents: { fixer: { model: "anthropic/claude-sonnet-4" } } },
				legacy: { agents: { fixer: { model: "google/gemini-2.5-pro" } } },
				env: { agents: { fixer: { model: "openai/gpt-4.1" } } },
				explicit: { agents: { fixer: { model: "openai/gpt-5" } } },
			},
		});
		process.env.OH_MY_OPENCODE_SLIM_PRESET = "legacy";
		process.env.PI_PRESET = "env";

		const envResult = discoverAgents(tempProject, "project");
		assert.equal(envResult.agents.find((agent) => agent.name === "fixer")?.model, "openai/gpt-4.1");
		assert.equal(envResult.preset.applied, "env");
		assert.equal(envResult.preset.source, "PI_PRESET");

		const explicitResult = discoverAgents(tempProject, "project", { preset: "explicit" });
		assert.equal(explicitResult.agents.find((agent) => agent.name === "fixer")?.model, "openai/gpt-5");
		assert.equal(explicitResult.preset.applied, "explicit");
		assert.equal(explicitResult.preset.source, "param");
	});

	it("returns warnings when the requested preset is missing and leaves agents unchanged", () => {
		writeJson(path.join(tempHome, ".pi", "agent", "extensions", "subagent", "config.json"), {
			presets: {
				fast: { agents: { fixer: { model: "openai/gpt-5-mini" } } },
			},
		});

		const result = discoverAgentsAll(tempProject, { preset: "missing" });
		const fixer = result.project.find((agent) => agent.name === "fixer");
		assert.ok(fixer);
		assert.equal(fixer.model, "anthropic/claude-sonnet-4");
		assert.equal(result.preset.requested, "missing");
		assert.equal(result.preset.applied, undefined);
		assert.equal(result.preset.source, "param");
		assert.match(result.preset.warnings[0] ?? "", /Requested preset 'missing' was not found/);
	});
});
