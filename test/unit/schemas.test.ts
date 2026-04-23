import assert from "node:assert/strict";
import { describe, it } from "node:test";

interface SubagentParamsSchema {
	properties?: {
		context?: {
			type?: string;
			enum?: string[];
			description?: string;
		};
		tasks?: {
			items?: {
				properties?: {
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
		runId?: {
			type?: string;
			description?: string;
		};
		control?: {
			properties?: {
				quietAfterMs?: { minimum?: number };
				stalledAfterMs?: { minimum?: number };
				parentMode?: { enum?: string[] };
			};
		};
	};
}

interface StatusParamsSchema {
	properties?: {
		action?: {
			type?: string;
			description?: string;
		};
	};
}

let SubagentParams: SubagentParamsSchema | undefined;
let StatusParams: StatusParamsSchema | undefined;
let available = true;
try {
	({ SubagentParams, StatusParams } = await import("../../schemas.ts") as { SubagentParams: SubagentParamsSchema; StatusParams: StatusParamsSchema });
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

	it("includes count and concurrency on top-level parallel mode", () => {
		const taskCountSchema = SubagentParams?.properties?.tasks?.items?.properties?.count;
		assert.ok(taskCountSchema, "tasks[].count schema should exist");
		assert.equal(taskCountSchema.minimum, 1);
		assert.match(String(taskCountSchema.description ?? ""), /repeat/i);

		const concurrencySchema = SubagentParams?.properties?.concurrency;
		assert.ok(concurrencySchema, "concurrency schema should exist");
		assert.equal(concurrencySchema.minimum, 1);
		assert.match(String(concurrencySchema.description ?? ""), /parallel/i);
	});

	it("includes subagent control fields", () => {
		const runIdSchema = SubagentParams?.properties?.runId;
		assert.ok(runIdSchema, "runId schema should exist");
		assert.equal(runIdSchema.type, "string");
		assert.match(String(runIdSchema.description ?? ""), /interrupt/i);

		const controlSchema = SubagentParams?.properties?.control;
		assert.ok(controlSchema, "control schema should exist");
		assert.equal(controlSchema.properties?.quietAfterMs?.minimum, 1);
		assert.equal(controlSchema.properties?.stalledAfterMs?.minimum, 1);
		assert.deepEqual(controlSchema.properties?.parentMode?.enum, ["transitions", "verbose"]);
	});

	it("includes action on status params for list mode", () => {
		const actionSchema = StatusParams?.properties?.action;
		assert.ok(actionSchema, "status action schema should exist");
		assert.equal(actionSchema.type, "string");
		assert.match(String(actionSchema.description ?? ""), /list/i);
	});
});
