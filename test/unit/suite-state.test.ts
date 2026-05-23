import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

const charterId = "f5fec59c-e92e-4263-927c-17a1ec03c93a";
const featureId = "f13-suite-green";
const charterPath = `.pi/charters/${charterId}/charter.md`;
const featurePath = `.pi/charters/${charterId}/plan/${featureId}.md`;
const scopeStatePath = `.pi/charters/${charterId}/scope-state.json`;

interface ScopeState {
	charterId?: string;
	featureId?: string;
	testCommand?: string;
	skipCount?: number;
}

function readText(path: string): string {
	return readFileSync(path, "utf8");
}

function readScopeState(): ScopeState {
	return JSON.parse(readText(scopeStatePath)) as ScopeState;
}

describe("suite state", () => {
	it("suite-state", () => {
		const scopeState = readScopeState();

		assert.equal(scopeState.charterId, charterId);
		assert.equal(scopeState.featureId, featureId);
		assert.equal(scopeState.testCommand, "npm run test:all");
	});

	it("skip-count-equals-30", () => {
		const scopeState = readScopeState();
		const charter = readText(charterPath);

		assert.equal(scopeState.skipCount, 30);
		assert.match(charter, /Skip count baseline = \*\*30\*\*/);
	});

	it("charter-completion-marker", () => {
		assert.equal(existsSync(charterPath), true);
		assert.equal(existsSync(featurePath), true);
		assert.equal(existsSync(scopeStatePath), true);
	});
});
