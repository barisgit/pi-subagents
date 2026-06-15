import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Compile } from "typebox/compile";
import { StepSchema, SubagentParams, TaskSchema } from "../../src/protocol/schemas.ts";

type JsonSchemaNode = Record<string, unknown>;

function walkSchema(root: unknown, visit: (path: string, node: JsonSchemaNode) => void): void {
	const stack: Array<{ path: string; value: unknown }> = [{ path: "schema", value: root }];
	while (stack.length > 0) {
		const current = stack.pop()!;
		if (!current.value || typeof current.value !== "object") continue;
		if (Array.isArray(current.value)) {
			current.value.forEach((value, index) => {
				stack.push({ path: `${current.path}[${index}]`, value });
			});
			continue;
		}
		const node = current.value as JsonSchemaNode;
		visit(current.path, node);
		for (const [key, value] of Object.entries(node)) {
			stack.push({ path: `${current.path}.${key}`, value });
		}
	}
}

describe("SubagentParams schema", () => {
	it("defines Task context as fresh/fork enum on the task schema", () => {
		const contextSchema = (TaskSchema.properties as unknown as Record<string, JsonSchemaNode>).context as
			| JsonSchemaNode
			| undefined;
		assert.ok(contextSchema, "context schema should exist on Task");
		const literals = (contextSchema.anyOf as JsonSchemaNode[] | undefined)?.map((schema) => schema.const);
		assert.deepEqual(literals, ["fresh", "fork"]);
		assert.match(String(contextSchema.description ?? ""), /fresh/);
		assert.match(String(contextSchema.description ?? ""), /fork/);
	});

	it("keeps flexible output typed explicitly", () => {
		const outputSchema = (TaskSchema.properties as unknown as Record<string, JsonSchemaNode>).output as
			| JsonSchemaNode
			| undefined;
		assert.ok(outputSchema, "output schema should exist on Task");
		assert.deepEqual(
			(outputSchema.anyOf as JsonSchemaNode[] | undefined)?.map((schema) => schema.type),
			["string", "boolean"],
		);
	});

	it("models run steps as Task", () => {
		const runSchema = (SubagentParams.properties as unknown as Record<string, JsonSchemaNode>).run as
			| JsonSchemaNode
			| undefined;
		assert.ok(runSchema, "run schema should exist");
		assert.equal(runSchema.type, "array");
		assert.deepEqual(runSchema.items, StepSchema);
	});

	it("does not emit description-only schema nodes", () => {
		const descriptionOnlyPaths: string[] = [];
		for (const [name, schema] of Object.entries({ SubagentParams, TaskSchema, StepSchema })) {
			walkSchema(schema, (path, node) => {
				if (
					Object.hasOwn(node, "description") &&
					!Object.hasOwn(node, "type") &&
					!Object.hasOwn(node, "anyOf") &&
					!Object.hasOwn(node, "oneOf") &&
					!Object.hasOwn(node, "allOf")
				) {
					descriptionOnlyPaths.push(`${name}.${path}`);
				}
			});
		}
		assert.deepEqual(descriptionOnlyPaths, []);
	});

	it("does not emit array-typed schema nodes without items", () => {
		const missingItemsPaths: string[] = [];
		for (const [name, schema] of Object.entries({ SubagentParams, TaskSchema, StepSchema })) {
			walkSchema(schema, (path, node) => {
				const types = Array.isArray(node.type) ? node.type : [node.type];
				if (types.includes("array") && !Object.hasOwn(node, "items")) {
					missingItemsPaths.push(`${name}.${path}`);
				}
			});
		}
		assert.deepEqual(missingItemsPaths, []);
	});

	it("validates representative slim values with TypeBox compiler", () => {
		const validator = Compile(SubagentParams);
		const validValues = [
			{ run: [{ agent: "main", task: "check this" }] },
			{
				run: [
					{ agent: "main", task: "a" },
					{ agent: "explorer", task: "b", context: "fresh", output: false },
				],
				concurrency: 2,
			},
			{ action: "list" },
			{ action: "status", id: "run-123" },
			{ action: "interrupt", id: "run-123" },
			{ action: "resume", id: "run-123", message: "continue" },
		];

		for (const value of validValues) {
			assert.equal(
				validator.Check(value),
				true,
				`${JSON.stringify(value)} should validate: ${[...validator.Errors(value)].map((error) => error.message).join(", ")}`,
			);
		}
	});

	it("rejects representative removed fields", () => {
		const validator = Compile(SubagentParams);
		for (const field of ["tasks", "prompt", "model", "skill", "agentScope", "cwd", "chain"]) {
			assert.equal(validator.Check({ [field]: "removed" }), false, `${field} should be rejected`);
		}
	});
});
