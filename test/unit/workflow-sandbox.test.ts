import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runWorkflowScript } from "../../src/workflow/workflow.ts";

const dispatch = async (_role: string, task: string) => ({ result: task });

// node:vm is not a hard security boundary; these tests pin the closure of the
// TRIVIAL prototype-chain escapes only (see the sandbox comment in workflow.ts).
describe("workflow vm sandbox hardening (VAL-WORKFLOW-SANDBOX)", () => {
	it("does not yield the host process object via this.constructor.constructor", async () => {
		let outcome: unknown = "threw";
		try {
			outcome = await runWorkflowScript({
				dispatch,
				script: "return this.constructor.constructor('return process')();",
			});
		} catch {
			// A throw (EvalError: code generation disallowed) is the expected shape.
		}
		assert.notEqual(outcome, process, "escape attempt reached the host process object");
	});

	it("does not leak host globals (process.version) through the constructor chain", async () => {
		let outcome: unknown = "threw";
		try {
			outcome = await runWorkflowScript({
				dispatch,
				script: "return this.constructor.constructor('return process.version')();",
			});
		} catch {
			// expected
		}
		assert.notEqual(outcome, process.version, "escape attempt read host process.version");
	});

	it("does not walk from an injected global's .constructor to a working host Function", async () => {
		let outcome: unknown = "threw";
		try {
			outcome = await runWorkflowScript({
				dispatch,
				script: "return agent.constructor('return process')();",
			});
		} catch {
			// expected: agent has a null prototype, so .constructor is undefined and calling it throws
		}
		assert.notEqual(outcome, process, "injected global's constructor chain reached host process");
	});

	it("blocks new Function(...) string evaluation inside the script", async () => {
		await assert.rejects(
			runWorkflowScript({ dispatch, script: "return new Function('return 1')();" }),
			/[Cc]ode generation from strings disallowed/,
		);
	});

	it("blocks Function('...') string evaluation inside the script", async () => {
		await assert.rejects(
			runWorkflowScript({ dispatch, script: "return Function('return process')();" }),
			/[Cc]ode generation from strings disallowed/,
		);
	});

	it("blocks eval('...') inside the script", async () => {
		await assert.rejects(
			runWorkflowScript({ dispatch, script: "return eval('1+1');" }),
			/[Cc]ode generation from strings disallowed/,
		);
	});

	it("keeps a normal workflow working: agent + parallel + pipeline + phase + await + return + opts.schema", async () => {
		const phases: string[] = [];
		const value = await runWorkflowScript({
			dispatch,
			onPhase: (title) => phases.push(title),
			script: [
				"phase('scope');",
				"const first = await agent('A', 'first', { schema: { type: 'string' } });",
				"phase('fan-out');",
				"const pair = await parallel([() => agent('A', 'left'), () => agent('A', 'right')]);",
				"const piped = await pipeline(['x'], (item) => agent('A', 'stage-' + item));",
				"return { first, pair, piped };",
			].join("\n"),
		});
		// JSON round-trip: the script's return value carries vm-realm prototypes.
		assert.deepEqual(JSON.parse(JSON.stringify(value)), {
			first: "first",
			pair: ["left", "right"],
			piped: ["stage-x"],
		});
		assert.deepEqual(phases, ["scope", "fan-out"]);
	});

	it("accepts declarative workflow metadata before orchestration starts", async () => {
		const metadata: unknown[] = [];
		await runWorkflowScript({
			dispatch,
			onMeta: (value) => metadata.push(value),
			script: [
				"meta({",
				"  name: 'Parity audit',",
				"  description: 'Compare legacy and current behavior',",
				"  phases: [{ title: 'Scope', detail: 'Discover areas' }, { title: 'Verify' }],",
				"});",
				"phase('Scope');",
				"return 'done';",
			].join("\n"),
		});

		assert.deepEqual(metadata, [
			{
				name: "Parity audit",
				description: "Compare legacy and current behavior",
				phases: [{ title: "Scope", detail: "Discover areas" }, { title: "Verify" }],
			},
		]);
	});

	it("rejects duplicate and late metadata declarations", async () => {
		const declaration = "meta({ name: 'Audit', description: 'Compare behavior', phases: [] });";
		await assert.rejects(
			runWorkflowScript({ dispatch, script: `${declaration}\n${declaration}` }),
			/meta\(\) may only be called once/,
		);
		for (const operation of ["phase('Scope');", "agent('role', 'task');", "parallel([]);", "pipeline([]);"]) {
			await assert.rejects(
				runWorkflowScript({ dispatch, script: `${operation}\n${declaration}` }),
				/meta\(\) must be called before/,
			);
		}
	});

	it("rejects malformed workflow metadata at the VM boundary", async () => {
		const invalid = [
			["null", /expects an object/],
			["{ name: '', description: 'x', phases: [] }", /meta\.name/],
			["{ name: 'x', description: '', phases: [] }", /meta\.description/],
			["{ name: 'x', description: 'y', phases: {} }", /meta\.phases must be an array/],
			["{ name: 'x', description: 'y', phases: [{}] }", /title must be a non-empty string/],
			[
				"{ name: 'x', description: 'y', phases: [{ title: 'a', detail: '' }] }",
				/detail must be a non-empty string/,
			],
			["{ name: 'x', description: 'y', phases: [{ title: 'a' }, { title: 'a' }] }", /must be unique/],
		] as const;
		for (const [value, pattern] of invalid) {
			await assert.rejects(runWorkflowScript({ dispatch, script: `meta(${value});` }), pattern);
		}
	});
});
