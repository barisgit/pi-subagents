import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Compile } from "typebox/compile";
import { SubagentParams, TaskSchema } from "../../schemas.ts";
import { validateSubagentToolInput } from "../../subagent-executor.ts";

type SchemaError = { params?: Record<string, unknown>; message?: string };

function sortedKeys(value: { properties?: Record<string, unknown> }): string[] {
	return Object.keys(value.properties ?? {}).sort();
}

function additionalProperty(errors: Iterable<SchemaError>): string | undefined {
	for (const error of errors) {
		const extra = error.params?.additionalProperties;
		if (Array.isArray(extra)) return String(extra[0]);
		if (typeof extra === "string") return extra;
	}
	return undefined;
}

describe("schema field set", () => {
	it("top-level keys are exactly the slim set", () => {
		assert.deepEqual(sortedKeys(SubagentParams), [
			"action",
			"async",
			"batch",
			"chain",
			"concurrency",
			"id",
			"message",
			"run",
			"worktree",
		].sort());
	});

	it("rejects unknown top-level keys with structured key detail", () => {
		const validator = Compile(SubagentParams);
		const input = { run: [{ agent: "main", task: "work" }], foo: "bar" };

		assert.equal(validator.Check(input), false);
		assert.equal(additionalProperty(validator.Errors(input)), "foo");
	});

	it("task keys are exactly the slim set", () => {
		assert.deepEqual(sortedKeys(TaskSchema), [
			"agent",
			"context",
			"label",
			"output",
			"task",
		].sort());
	});

	it("rejects unknown task keys with structured key detail", () => {
		const validator = Compile(SubagentParams);
		const input = { run: [{ agent: "main", task: "work", foo: "bar" }] };

		assert.equal(validator.Check(input), false);
		assert.equal(additionalProperty(validator.Errors(input)), "foo");
	});

	it("rejects Task.worktree as an unknown task key", () => {
		const validator = Compile(SubagentParams);
		const input = { run: [{ agent: "x", task: "y", worktree: true }] };

		assert.equal(validator.Check(input), false);
		assert.equal(additionalProperty(validator.Errors(input)), "worktree");

		const error = validateSubagentToolInput(input);
		const first = error?.content[0];
		const text = first?.type === "text" ? first.text : "";
		assert.match(text, /Unknown task key 'worktree' at run\[0\]/);
	});

	it("rejects removed CRUD actions with file-based authoring hint", () => {
		for (const action of ["create", "update", "delete", "get"]) {
			const error = validateSubagentToolInput({ action });
			const first = error?.content[0];
			const text = first?.type === "text" ? first.text : "";

			assert.match(text, /agents\/<name>\.md/);
			assert.match(text, /Allowed actions: list, status, interrupt, resume/);
		}
	});
});
