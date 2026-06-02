import assert from "node:assert/strict";
import * as path from "node:path";
import { describe, it } from "node:test";
import { loadWorkflowRecipe, type WorkflowSearchRoot } from "../../workflow.ts";

const fixtureRoot = path.join(process.cwd(), "test", "fixtures", "workflows");
const searchRoots: WorkflowSearchRoot[] = [
	{ dir: path.join(fixtureRoot, "project", "workflows"), source: "project" },
	{ dir: path.join(fixtureRoot, "user", "workflows"), source: "user" },
	{ dir: path.join(fixtureRoot, "builtin", "workflows"), source: "builtin" },
];

describe("workflow recipe loader (VAL-RECIPE-LOADER)", () => {
	it("loads a named fixture recipe with metadata and script", () => {
		const recipe = loadWorkflowRecipe("neutral", { searchRoots });

		assert.ok(recipe);
		assert.equal(recipe.name, "neutral");
		assert.equal(recipe.source, "user");
		assert.equal(recipe.meta.description, "Neutral fixture recipe");
		assert.match(recipe.script, /neutral recipe/);
	});

	it("lets a project-layer recipe shadow same-named user and builtin recipes", () => {
		const recipe = loadWorkflowRecipe("shared", { searchRoots });

		assert.ok(recipe);
		assert.equal(recipe.source, "project");
		assert.equal(recipe.meta.description, "Project recipe");
		assert.match(recipe.script, /project recipe/);
		assert.doesNotMatch(recipe.script, /user recipe|builtin recipe/);
	});
});
