import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { createSubagentExecutor } from "../../src/dispatch/subagent-executor.ts";
import { ChildAgentRegistry, __setChildAgentExecutorDepsForTest } from "../../src/dispatch/in-process-executor.ts";
import { setRegistryPathForTests } from "../../src/state/runs-registry.ts";
import { runWorkflowScript, type WorkflowDispatchTags, WorkflowAgentError } from "../../src/workflow/workflow.ts";
import { makeAgent } from "../support/helpers.ts";

describe("workflow agent global (VAL-AGENT-GLOBAL)", () => {
	it("resolves to the child's result returned by an injected dispatch", async () => {
		const envelope = { result: { answer: 7 } };
		const value = await runWorkflowScript({
			dispatch: async (role, task) => {
				assert.equal(role, "explorer");
				assert.equal(task, "inventory");
				return envelope;
			},
			script: "return await agent('explorer', 'inventory');",
		});

		assert.deepEqual(value, { answer: 7 });
	});

	it("rejects an empty or non-string per-child cwd", async () => {
		for (const cwd of ["''", "42", "null"]) {
			await assert.rejects(
				runWorkflowScript({
					dispatch: async () => ({ result: "unused" }),
					script: `return await agent('review', 'check', { cwd: ${cwd} });`,
				}),
				/agent\(role, task, \{ cwd \}\) expects a non-empty string/,
			);
		}
	});

	it("surfaces dispatch failure and does not return a masking fallback status:ok envelope", async () => {
		const maskingEnvelope = {
			result: "fallback text",
		};
		await assert.rejects(
			runWorkflowScript({
				dispatch: async () => ({ envelope: maskingEnvelope, exitCode: 1, error: "child failed" }),
				script: "return await agent('explorer', 'task');",
			}),
			(error: unknown) => {
				assert.ok(error instanceof WorkflowAgentError);
				assert.equal(error.envelope, maskingEnvelope);
				assert.match(error.message, /child failed/);
				return true;
			},
		);
	});

	it("surfaces interrupted dispatches even when the child fallback envelope says ok", async () => {
		await assert.rejects(
			runWorkflowScript({
				dispatch: async () => ({
					envelope: { result: "fallback" },
					interrupted: true,
				}),
				script: "return await agent('explorer', 'task');",
			}),
			/was interrupted/,
		);
	});

	it("threads a workflow-authored JSON Schema to dispatch as a TypeBox resultSchema tag", async () => {
		let seenTags: { resultSchema?: unknown } | undefined;
		const envelope = { result: { approved: true } };
		const value = await runWorkflowScript({
			dispatch: async (_role, _task, tags) => {
				seenTags = tags;
				return envelope;
			},
			script: "return await agent('review', 'check', { schema: { type: 'object', required: ['approved'], properties: { approved: { type: 'boolean' } }, additionalProperties: false } });",
		});
		assert.deepEqual(value, { approved: true });
		// The plain JSON Schema is wrapped at the boundary; the child's trailing <output>
		// block enforces it. We assert the tag carries a usable schema object with the
		// author's keywords intact (Type.Unsafe preserves type/required/properties).
		// The schema object is authored inside the VM realm, so its array prototype
		// differs from the host's; compare values, not prototype-strict structure.
		const schema = seenTags?.resultSchema as Record<string, unknown> | undefined;
		assert.ok(schema, "resultSchema tag should be present");
		assert.equal(schema?.type, "object");
		const required = schema?.required as string[] | undefined;
		assert.equal(required?.length, 1);
		assert.equal(required?.[0], "approved");
		assert.equal(schema?.additionalProperties, false);
	});

	it("omits the resultSchema tag when no schema is supplied", async () => {
		let seenTags: { resultSchema?: unknown } | undefined;
		await runWorkflowScript({
			dispatch: async (_role, _task, tags) => {
				seenTags = tags;
				return { result: "text" };
			},
			script: "return await agent('explorer', 'inventory');",
		});
		assert.equal(seenTags?.resultSchema, undefined);
	});

	it("fails closed when agent() is given a non-object schema", async () => {
		await assert.rejects(
			runWorkflowScript({
				dispatch: async () => ({ result: "x" }),
				script: "return await agent('review', 'check', { schema: 'not-a-schema' });",
			}),
			/plain JSON Schema object/,
		);
	});

	it("threads per-child phase and label tags without changing the default phase", async () => {
		const phases: string[] = [];
		const calls: Array<{ task: string; tags?: WorkflowDispatchTags }> = [];
		await runWorkflowScript({
			dispatch: async (_role, task, tags) => {
				calls.push({ task, tags });
				return { result: task };
			},
			onPhase: (title) => phases.push(title),
			script: [
				"meta({ name: 'Audit', description: 'Compare', phases: ['Scope', 'Verify'] });",
				"phase('Scope');",
				"await agent('review', 'override', { phase: 'Phase 2: Verify', label: 'Verify physics branch', cwd: 'packages/physics' });",
				"await agent('review', 'default');",
			].join("\n"),
		});

		assert.deepEqual(phases, ["Scope"]);
		assert.equal(calls[0]?.tags?.phaseIndex, 2);
		assert.equal(calls[0]?.tags?.phaseTitle, "Verify");
		assert.equal(calls[0]?.tags?.label, "Verify physics branch");
		assert.equal(calls[0]?.tags?.cwd, "packages/physics");
		assert.equal(calls[1]?.tags?.phaseIndex, undefined);
		assert.equal(calls[1]?.tags?.phaseTitle, undefined);
		assert.equal(calls[1]?.tags?.label, undefined);
		assert.equal(calls[1]?.tags?.cwd, undefined);
	});

	it("rejects a per-child phase not declared by workflow metadata", async () => {
		await assert.rejects(
			runWorkflowScript({
				dispatch: async () => ({ result: "unused" }),
				script: [
					"meta({ name: 'Audit', description: 'Compare', phases: ['Scope'] });",
					"return await agent('review', 'check', { phase: 'Missing' });",
				].join("\n"),
			}),
			/not declared in meta\.phases/,
		);
	});

	it("uses branch as a semantic pipeline item label", async () => {
		let seenTags: WorkflowDispatchTags | undefined;
		await runWorkflowScript({
			dispatch: async (_role, _task, tags) => {
				seenTags = tags;
				return { result: "done" };
			},
			script: "return await pipeline([{ branch: 'physics' }], (item) => agent('review', item.branch));",
		});

		assert.equal(seenTags?.pipeline?.itemLabel, "physics");
	});

	it("threads named pipeline and stage metadata to every child", async () => {
		const seen: WorkflowDispatchTags[] = [];
		await runWorkflowScript({
			dispatch: async (_role, task, tags) => {
				if (tags) seen.push(tags);
				return { result: task };
			},
			script: [
				"return await pipeline({ name: 'Osnutki', items: [{ branch: 'physics' }] },",
				"  { title: 'osnutek', run: (item) => agent('review', item.branch) },",
				"  { title: 'verifikacija', run: (value) => agent('review', value) },",
				");",
			].join("\n"),
		});

		assert.equal(seen.length, 2);
		assert.deepEqual(seen[0]?.pipeline, {
			id: seen[0]?.pipeline?.id,
			name: "Osnutki",
			itemIndex: 0,
			itemLabel: "physics",
			stageIndex: 0,
			stageTitle: "osnutek",
			stageCount: 2,
			itemCount: 1,
		});
		assert.deepEqual(seen[1]?.pipeline, {
			id: seen[0]?.pipeline?.id,
			name: "Osnutki",
			itemIndex: 0,
			itemLabel: "physics",
			stageIndex: 1,
			stageTitle: "verifikacija",
			stageCount: 2,
			itemCount: 1,
		});
	});
});

describe("workflow agent Layer-0 child prep (VAL-CHILD-PREP)", () => {
	it("dispatches through openWorkflowGroup with resolved model/tools and rejects failed children", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-agent-prep-"));
		const previousHome = process.env.HOME;
		process.env.HOME = root;
		setRegistryPathForTests(path.join(root, ".pi", "agent", "pi-subagents", "runs-index.jsonl"));
		const created: Array<{
			model?: { provider: string; id: string };
			tools?: string[];
		}> = [];
		class FakeResourceLoader {
			async reload(): Promise<void> {}
		}
		class FakeSession {
			async bindExtensions(): Promise<void> {}
			messages: unknown[] = [];
			lastAssistantText = "";
			subscribe(): () => void {
				return () => {};
			}
			async prompt(task: string): Promise<void> {
				if (task === "fail") throw new Error("child boom");
				this.lastAssistantText = `<output>${task}</output>`;
			}
			getLastAssistantText(): string {
				return this.lastAssistantText;
			}
			async abort(): Promise<void> {}
			dispose(): void {}
			setActiveToolsByName(): void {}
		}
		const restore = __setChildAgentExecutorDepsForTest({
			DefaultResourceLoader: FakeResourceLoader as never,
			getAgentDir: () => "/tmp/pi-agent",
			SessionManager: { open: (file: string) => ({ getSessionId: () => `session-${file}` }) as never },
			createAgentSession: (async (options: { model?: { provider: string; id: string }; tools?: string[] }) => {
				created.push(options);
				return {
					session: new FakeSession() as never,
					extensionsResult: { extensions: [], diagnostics: [] },
				} as never;
			}) as never,
		});
		try {
			const executor = createSubagentExecutor({
				pi: {
					events: { emit: () => {} },
					getSessionName: () => undefined,
					setSessionName: () => {},
					getAllTools: () => [],
				},
				state: {
					baseCwd: root,
					currentSessionId: null,
					asyncJobs: new Map(),
					foregroundControls: new Map(),
					lastForegroundControlId: null,
					cleanupTimers: new Map(),
					lastUiContext: null,
					poller: null,
				},
				config: { control: { enabled: true, needsAttentionAfterMs: 1234 } },
				asyncByDefault: false,
				tempArtifactsDir: root,
				childRegistry: new ChildAgentRegistry(),
				expandTilde: (value: string) => value,
				discoverAgents: () => ({
					agents: [makeAgent("fixer", { model: "mock/test-model", tools: ["read"], skills: ["tdd"] })],
				}),
			} as never);
			const ctx = {
				cwd: root,
				hasUI: false,
				ui: {},
				sessionManager: { getSessionId: () => "parent", getSessionFile: () => null },
				modelRegistry: { getAvailable: () => [{ provider: "mock", id: "test-model" }] },
				model: { provider: "mock" },
			};
			const group = executor.openWorkflowGroup({
				toolCallId: "wf",
				signal: new AbortController().signal,
				ctx: ctx as never,
			});
			const ok = await group.dispatchChild({ role: "fixer", task: "ok", index: 0 });
			assert.deepEqual(ok.structuredResult, { result: "ok" });
			assert.equal(created[0]?.model?.id, "test-model");
			assert.deepEqual(created[0]?.tools, ["read"]);
			const failed = await group.dispatchChild({ role: "fixer", task: "fail", index: 1 });
			assert.notEqual(failed.exitCode, 0);
			await assert.rejects(
				runWorkflowScript({
					dispatch: async () => ({
						envelope: failed.structuredResult,
						exitCode: failed.exitCode,
						error: failed.error,
					}),
					script: "return await agent('fixer', 'fail');",
				}),
				(error: unknown) => error instanceof WorkflowAgentError && /child boom/.test(error.message),
			);
		} finally {
			restore();
			setRegistryPathForTests(null);
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
