import assert from "node:assert/strict";
import { describe, it } from "node:test";

type JsonSchemaNode = Record<string, unknown>;

interface SubagentParamsSchema {
	properties?: {
		context?: {
			type?: string;
			enum?: string[];
			description?: string;
		};
		preset?: {
			type?: string;
			description?: string;
		};
			tasks?: {
				items?: {
					type?: string | string[];
					required?: string[];
					properties?: {
						agent?: { type?: string };
						count?: {
							minimum?: number;
							description?: string;
						};
					};
				};
			};
		concurrency?: {
			minimum?: number;
			description?: string;
		};
		id?: {
			type?: string;
			description?: string;
		};
		runId?: {
			type?: string;
			description?: string;
		};
		dir?: {
			type?: string;
			description?: string;
		};
		control?: {
			properties?: {
				needsAttentionAfterMs?: { minimum?: number };
				notifyOn?: { items?: { enum?: string[] } };
				notifyChannels?: { items?: { enum?: string[] } };
			};
		};
		skill?: JsonSchemaNode;
		output?: JsonSchemaNode;
		config?: JsonSchemaNode;
		chain?: {
			items?: JsonSchemaNode & {
				properties?: Record<string, JsonSchemaNode>;
			};
		};
	};
}

let schemas: Record<string, JsonSchemaNode> = {};
let SubagentParams: SubagentParamsSchema | undefined;
let CompileSchema: ((schema: unknown) => { Check(value: unknown): boolean; Errors(value: unknown): Iterable<{ message: string }> }) | undefined;
let available = true;
try {
	schemas = await import("../../schemas.ts") as unknown as Record<string, JsonSchemaNode>;
	SubagentParams = schemas.SubagentParams as SubagentParamsSchema;
	const compileModule = await import("typebox/compile") as { Compile: typeof CompileSchema };
	CompileSchema = compileModule.Compile;
} catch {
	// Skip in environments that do not install typebox.
	available = false;
}

describe("SubagentParams schema", { skip: !available ? "typebox not available" : undefined }, () => {
	it("includes context field for fresh/fork execution mode", () => {
		const contextSchema = SubagentParams?.properties?.context;
		assert.ok(contextSchema, "context schema should exist");
		assert.equal(contextSchema.type, "string");
		assert.deepEqual(contextSchema.enum, ["fresh", "fork"]);
		assert.match(String(contextSchema.description ?? ""), /fresh/);
		assert.match(String(contextSchema.description ?? ""), /fork/);
	});

	it("includes count, shorthand, and concurrency on top-level parallel mode", () => {
		const taskItemSchema = SubagentParams?.properties?.tasks?.items as JsonSchemaNode & { anyOf?: Array<JsonSchemaNode & { properties?: Record<string, JsonSchemaNode>; required?: string[] }> } | undefined;
		assert.ok(taskItemSchema, "tasks[] schema should exist");
		const objectTaskSchema = taskItemSchema.anyOf?.find((schema) => schema.type === "object");
		const stringTaskSchema = taskItemSchema.anyOf?.find((schema) => schema.type === "string");
		assert.ok(objectTaskSchema, "tasks[] should accept object task items");
		assert.ok(stringTaskSchema, "tasks[] should accept string task shorthand");
		assert.deepEqual(objectTaskSchema.required, ["task"]);
		assert.equal(objectTaskSchema.properties?.agent?.type, "string");

		const taskCountSchema = objectTaskSchema.properties?.count;
		assert.ok(taskCountSchema, "tasks[].count schema should exist");
		assert.equal(taskCountSchema.minimum, 1);
		assert.match(String(taskCountSchema.description ?? ""), /repeat/i);

		const concurrencySchema = SubagentParams?.properties?.concurrency;
		assert.ok(concurrencySchema, "concurrency schema should exist");
		assert.equal(concurrencySchema.minimum, 1);
		assert.match(String(concurrencySchema.description ?? ""), /parallel/i);
	});

it("includes subagent control fields", () => {
		const idSchema = SubagentParams?.properties?.id;
		assert.ok(idSchema, "id schema should exist");
		assert.equal(idSchema.type, "string");
		assert.match(String(idSchema.description ?? ""), /status/i);
		assert.match(String(idSchema.description ?? ""), /interrupt/i);

		const runIdSchema = SubagentParams?.properties?.runId;
		assert.ok(runIdSchema, "runId schema should exist");
		assert.equal(runIdSchema.type, "string");
		assert.match(String(runIdSchema.description ?? ""), /interrupt/i);

		const dirSchema = SubagentParams?.properties?.dir;
		assert.ok(dirSchema, "dir schema should exist");
		assert.equal(dirSchema.type, "string");
		assert.match(String(dirSchema.description ?? ""), /status/i);

		const controlSchema = SubagentParams?.properties?.control;
		assert.ok(controlSchema, "control schema should exist");
		assert.equal(controlSchema.properties?.needsAttentionAfterMs?.minimum, 1);
		assert.deepEqual(controlSchema.properties?.notifyOn?.items?.enum, ["needs_attention"]);
		assert.deepEqual(controlSchema.properties?.notifyChannels?.items?.enum, ["event", "async", "intercom"]);
	});

	it("does not emit description-only schema nodes", () => {
		const descriptionOnlyPaths: string[] = [];

		for (const [name, schema] of Object.entries(schemas)) {
			const stack: Array<{ path: string; value: unknown }> = [{ path: name, value: schema }];
			while (stack.length > 0) {
				const current = stack.pop()!;
				if (!current.value || typeof current.value !== "object") continue;

				const node = current.value as JsonSchemaNode;
				if (
					Object.hasOwn(node, "description")
					&& !Object.hasOwn(node, "type")
					&& !Object.hasOwn(node, "anyOf")
					&& !Object.hasOwn(node, "oneOf")
					&& !Object.hasOwn(node, "allOf")
				) {
					descriptionOnlyPaths.push(current.path);
				}

				if (Array.isArray(current.value)) {
					current.value.forEach((value, index) => stack.push({ path: `${current.path}[${index}]`, value }));
					continue;
				}

				for (const [key, value] of Object.entries(node)) {
					stack.push({ path: `${current.path}.${key}`, value });
				}
			}
		}

		assert.deepEqual(descriptionOnlyPaths, []);
	});

	it("does not emit array-typed schema nodes without items", () => {
		const missingItemsPaths: string[] = [];

		for (const [name, schema] of Object.entries(schemas)) {
			const stack: Array<{ path: string; value: unknown }> = [{ path: name, value: schema }];
			while (stack.length > 0) {
				const current = stack.pop()!;
				if (!current.value || typeof current.value !== "object") continue;

				const node = current.value as JsonSchemaNode;
				const types = Array.isArray(node.type) ? node.type : [node.type];
				if (types.includes("array") && !Object.hasOwn(node, "items")) {
					missingItemsPaths.push(current.path);
				}

				if (Array.isArray(current.value)) {
					current.value.forEach((value, index) => stack.push({ path: `${current.path}[${index}]`, value }));
					continue;
				}

				for (const [key, value] of Object.entries(node)) {
					stack.push({ path: `${current.path}.${key}`, value });
				}
			}
		}

		assert.deepEqual(missingItemsPaths, []);
	});

	it("uses explicit types for flexible fields and chain items", () => {
		const skillSchema = SubagentParams?.properties?.skill as JsonSchemaNode & { anyOf?: JsonSchemaNode[] } | undefined;
		assert.ok(skillSchema, "skill schema should exist");
		assert.deepEqual(skillSchema.anyOf?.map((schema) => schema.type), ["boolean", "array", "string"]);
		assert.deepEqual(skillSchema.anyOf?.find((schema) => schema.type === "array")?.items, { type: "string" });

		const outputSchema = SubagentParams?.properties?.output as JsonSchemaNode & { anyOf?: JsonSchemaNode[] } | undefined;
		assert.ok(outputSchema, "output schema should exist");
		assert.deepEqual(outputSchema.anyOf?.map((schema) => schema.type), ["boolean", "string"]);

		const configSchema = SubagentParams?.properties?.config as JsonSchemaNode & { anyOf?: JsonSchemaNode[] } | undefined;
		assert.ok(configSchema, "config schema should exist");
		assert.deepEqual(configSchema.anyOf?.map((schema) => schema.type), ["object", "string"]);
		assert.equal(configSchema.anyOf?.find((schema) => schema.type === "object")?.additionalProperties, true);

		const chainItem = SubagentParams?.properties?.chain?.items;
		assert.ok(chainItem, "chain item schema should exist");
		assert.equal(chainItem.type, "object");
		assert.equal(chainItem.anyOf, undefined);
		assert.equal(chainItem.oneOf, undefined);
		assert.equal(chainItem.properties?.agent?.type, "string");
		assert.equal(chainItem.properties?.parallel?.type, "array");
		assert.equal((chainItem.properties?.parallel?.items as { properties?: Record<string, JsonSchemaNode> } | undefined)?.properties?.agent?.type, "string");
		const chainOutput = chainItem.properties?.output as JsonSchemaNode & { anyOf?: JsonSchemaNode[] } | undefined;
		const chainReads = chainItem.properties?.reads as JsonSchemaNode & { anyOf?: JsonSchemaNode[] } | undefined;
		assert.deepEqual(chainOutput?.anyOf?.map((schema) => schema.type), ["boolean", "string"]);
		assert.deepEqual(chainReads?.anyOf?.map((schema) => schema.type), ["array", "boolean"]);
		assert.deepEqual(chainReads?.anyOf?.find((schema) => schema.type === "array")?.items, { type: "string" });
	});

	it("validates representative flexible field values with TypeBox compiler", () => {
		assert.ok(SubagentParams, "SubagentParams schema should exist");
		assert.ok(CompileSchema, "TypeBox compiler should exist");
		const validator = CompileSchema(SubagentParams);
		const validValues = [
			{ skill: "review" },
			{ skill: false },
			{ tasks: [{ agent: "reviewer", task: "check this", skill: "review" }] },
			{ tasks: [{ agent: "reviewer", task: "check this", skill: false }] },
			{ agent: "reviewer", tasks: ["check auth", "check API"] },
			{ agent: "reviewer", tasks: [{ task: "check auth" }, { task: "check API", model: "provider/model" }] },
			{ chain: [{ agent: "reviewer", reads: false }] },
			{ chain: [{ parallel: [{ agent: "reviewer", reads: false, skill: false }] }] },
			{ config: { name: "reviewer", description: "Review things" } },
			{ config: JSON.stringify({ name: "reviewer", description: "Review things" }) },
		];

		for (const value of validValues) {
			assert.doesNotThrow(() => validator.Check(value), `validator should not throw for ${JSON.stringify(value)}`);
			assert.equal(
				validator.Check(value),
				true,
				`${JSON.stringify(value)} should validate: ${[...validator.Errors(value)].map((error) => error.message).join(", ")}`,
			);
		}
	});

	it("includes preset-aware routing metadata on execution params", () => {
		const presetSchema = SubagentParams?.properties?.preset;
		assert.ok(presetSchema, "preset schema should exist");
		assert.equal(presetSchema.type, "string");
		assert.match(String(presetSchema.description ?? ""), /PI_PRESET/);
		assert.match(String(presetSchema.description ?? ""), /OH_MY_OPENCODE_SLIM_PRESET/);
	});

	it("includes action on status params for list mode", () => {
		const actionSchema = (SubagentParams?.properties as Record<string, JsonSchemaNode> | undefined)?.action;
		assert.ok(actionSchema, "status action schema should exist");
		assert.equal(actionSchema.type, "string");
		assert.match(String(actionSchema.description ?? ""), /list/i);
	});
});
