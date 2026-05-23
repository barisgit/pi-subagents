import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

interface Version {
	major: number;
	minor: number;
	patch: number;
}

function readText(path: string): string {
	return readFileSync(path, "utf8");
}

function parseVersion(version: string): Version {
	const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
	assert.ok(match, `expected semver, got ${version}`);

	return {
		major: Number(match[1]),
		minor: Number(match[2]),
		patch: Number(match[3]),
	};
}

function packageVersion(): Version {
	const packageJson = JSON.parse(readText("package.json")) as { version?: string };
	const { version } = packageJson;
	if (typeof version !== "string") throw new Error("package.json version must be a string");

	return parseVersion(version);
}

function h2Section(doc: string, name: string): string {
	const lines = doc.split(/\r?\n/);
	const start = lines.findIndex((line) => line.startsWith("## ") && line.toLowerCase().includes(name.toLowerCase()));
	assert.notEqual(start, -1, `missing ${name} section`);
	const end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
	return lines.slice(start, end === -1 ? undefined : end).join("\n");
}

function doctrineBaselineVersion(): Version {
	const baseline = h2Section(readText("docs/schema-decisions.md"), "Baseline");
	const match = /pi-subagents@(\d+\.\d+\.\d+)/.exec(baseline);
	const version = match?.[1];
	if (!version) throw new Error("missing pi-subagents baseline semver");

	return parseVersion(version);
}

describe("version bump", () => {
	it("version-bump", () => {
		const baseline = doctrineBaselineVersion();
		const version = packageVersion();

		assert.equal(version.major, baseline.major + 1);
	});

	it("changelog-mentions-charter", () => {
		assert.match(readText("CHANGELOG.md"), /subagent-schema-slim/);
	});

	it("baseline-read-from-doctrine", () => {
		const baseline = doctrineBaselineVersion();
		const version = packageVersion();

		assert.equal(version.major, baseline.major + 1);
	});

	it("minor-patch-reset", () => {
		const version = packageVersion();

		assert.equal(version.minor, 0);
		assert.equal(version.patch, 0);
	});
});
