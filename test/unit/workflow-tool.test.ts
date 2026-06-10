import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { createWorkflowTool } from "../../src/workflow/workflow.ts";

const ctx = {} as never;
type WorkflowToolResult = AgentToolResult<unknown> & { isError?: boolean };

async function executeWorkflow(script: string): Promise<WorkflowToolResult> {
	const tool = createWorkflowTool({ dispatch: async () => ({ status: "ok", summary: "unused", result: "unused" }) });
	return await tool.execute?.("wf", { script }, new AbortController().signal, () => {}, ctx) as WorkflowToolResult;
}

describe("workflow tool (VAL-WORKFLOW-TOOL)", () => {
	it("exposes the workflow tool with strict { script: string, async?: boolean } parameters", () => {
		const tool = createWorkflowTool({ dispatch: async () => ({ status: "ok", summary: "unused", result: "unused" }) });

		assert.equal(tool.name, "workflow");
		assert.deepEqual(validateToolArguments(tool, { type: "toolCall", id: "good", name: "workflow", arguments: { script: "return 1;" } }), { script: "return 1;" });
		assert.deepEqual(validateToolArguments(tool, { type: "toolCall", id: "async", name: "workflow", arguments: { script: "return 1;", async: true } }), { script: "return 1;", async: true });
		assert.throws(() => validateToolArguments(tool, { type: "toolCall", id: "extra", name: "workflow", arguments: { script: "return 1;", extra: true } }), /extra|Unexpected property/);
	});

	it("runs the script inside the required async IIFE and returns the resolved value", async () => {
		const result = await executeWorkflow("const value = await Promise.resolve(42);\nreturn { value };");

		assert.equal(result?.isError, undefined);
		// The script's arbitrary return value is surfaced via content text, NOT details:
		// `details` is always a real Details so the renderer can never crash on it.
		assert.equal((result.content[0] as { text?: string } | undefined)?.text, "{\n  \"value\": 42\n}");
		assert.deepEqual(JSON.parse(JSON.stringify(result?.details)), { mode: "parallel", workflow: true, results: [], progress: [], agentGroups: [], totalSteps: 0 });
	});

	it("surfaces a throwing script as an error result without crashing the host", async () => {
		const result = await executeWorkflow("throw new Error('boom');");

		assert.equal(result?.isError, true);
		assert.match((result.content[0] as { text?: string } | undefined)?.text ?? "", /boom/);
	});

	// Run the tool in a child process and report { isError, text } it produced,
	// plus the child exit code. node:test installs its own unhandledRejection
	// listener, so an in-process assertion can't prove host-survival; a subprocess
	// shows the real behavior — without containment the child exits non-zero (host
	// crash), with it the child exits 0 and the tool reports isError.
	function runWorkflowInSubprocess(script: string, dispatchBody: string): { status: number | null; stderr: string; out: { isError: boolean; text: string } } {
		const workflowUrl = new URL("../../src/workflow/workflow.ts", import.meta.url).href;
		const program = [
			"import(process.env.WF_URL).then(async (m) => {",
			`  const tool = m.createWorkflowTool({ dispatch: ${dispatchBody} });`,
			"  const result = await tool.execute('wf', { script: process.env.WF_SCRIPT }, new AbortController().signal, () => {}, {});",
			// Wait well past any agent latency: an uncontained late rejection crashes
			// the host here, before/after we report; a contained one stays quiet.
			"  await new Promise((r) => setTimeout(r, 120));",
			"  process.stdout.write(JSON.stringify({ isError: result.isError === true, text: (result.content[0] && result.content[0].text) || '' }));",
			"}).catch((e) => { process.stderr.write('OUTER:' + String(e)); process.exit(2); });",
		].join("\n");
		const res = spawnSync(process.execPath, ["--experimental-strip-types", "-e", program], {
			encoding: "utf8",
			env: { ...process.env, WF_URL: workflowUrl, WF_SCRIPT: script },
		});
		return { status: res.status, stderr: res.stderr, out: res.stdout ? JSON.parse(res.stdout) : { isError: false, text: "" } };
	}

	it("contains a synchronously floated raw Promise.reject instead of crashing the host (best-effort gap)", () => {
		// A RAW float (no agent()/parallel() lineage) is NOT a TrackingPromise, so by
		// design it is not attributed: the run reports success. The load-bearing
		// guarantee here is R-crash — the host must SURVIVE (exit 0). This encodes the
		// documented best-effort limitation as an explicit contract, not a silent leak.
		const res = runWorkflowInSubprocess("Promise.reject(new Error('raw-boom'));\nreturn 'ok';", "async () => ({ status: 'ok', summary: 'u', result: 'u' })");
		assert.equal(res.status, 0, `host crashed (exit ${res.status}): ${res.stderr}`);
		assert.equal(res.out.isError, false);
		assert.equal(res.out.text, "ok");
	});

	it("reports a floated .then() workflow off agent() as an error (finding #1)", () => {
		// The script floats a DERIVATIVE of agent(): agent('bad').then(v=>v). Because
		// agent() returns a TrackingPromise (Symbol.species = itself), the .then result
		// is also a TrackingPromise registered in this run's owned Set, so the floated
		// child failure is still surfaced — not dropped as success.
		const dispatch = "async () => ({ isError: true, exitCode: 1, error: 'then-derived-boom' })";
		const res = runWorkflowInSubprocess("agent('explorer', 'bad').then((v) => v);\nreturn 'ok';", dispatch);
		assert.equal(res.status, 0, `host crashed (exit ${res.status}): ${res.stderr}`);
		assert.equal(res.out.isError, true);
		assert.match(res.out.text, /unhandled promise rejection.*then-derived-boom/);
	});

	it("reports a 2-deep floated workflow off agent() as an error", () => {
		const dispatch = "async () => ({ isError: true, exitCode: 1, error: 'deep-workflow-boom' })";
		const res = runWorkflowInSubprocess("agent('explorer', 'bad').then((v) => v).then((v) => v);\nreturn 'ok';", dispatch);
		assert.equal(res.status, 0, `host crashed (exit ${res.status}): ${res.stderr}`);
		assert.equal(res.out.isError, true);
		assert.match(res.out.text, /unhandled promise rejection.*deep-workflow-boom/);
	});

	it("reports a floated async-helper agent() rejection via reason marker, not promise identity (round-6 finding)", () => {
		// The unhandled promise is the async HELPER's intrinsic vm Promise, not a
		// TrackingPromise — so owned-Set identity alone misses it. The run token
		// stamped on the WorkflowAgentError reason still attributes it to this run.
		const dispatch = "async () => ({ isError: true, exitCode: 1, error: 'helper-boom' })";
		const res = runWorkflowInSubprocess("async function helper(){ await agent('explorer', 'bad'); }\nhelper();\nreturn 'ok';", dispatch);
		assert.equal(res.status, 0, `host crashed (exit ${res.status}): ${res.stderr}`);
		assert.equal(res.out.isError, true);
		assert.match(res.out.text, /unhandled promise rejection.*helper-boom/);
	});

	it("reports a floated Promise.all([agent()]) rejection, and does NOT false-fail when it is awaited+caught", () => {
		const dispatch = "async () => ({ isError: true, exitCode: 1, error: 'all-boom' })";
		const floated = runWorkflowInSubprocess("Promise.all([agent('explorer', 'bad')]);\nreturn 'ok';", dispatch);
		assert.equal(floated.status, 0, `host crashed (exit ${floated.status}): ${floated.stderr}`);
		assert.equal(floated.out.isError, true);
		assert.match(floated.out.text, /unhandled promise rejection.*all-boom/);
		const caught = runWorkflowInSubprocess("await Promise.all([agent('explorer', 'bad')]).catch(() => {});\nreturn 'ok';", dispatch);
		assert.equal(caught.status, 0, `host crashed (exit ${caught.status}): ${caught.stderr}`);
		assert.equal(caught.out.isError, false);
		assert.equal(caught.out.text, "ok");
	});

	it("survives a post-return agent() float scheduled via Atomics.waitAsync (round-6 critical, host crash-safety)", () => {
		// Atomics.waitAsync schedules a callback that fires AFTER the run returned and
		// after the settle drain. A per-run listener removed in finally would leave
		// zero listeners and crash the host. The PERMANENT process listener swallows
		// the marked agent error: host survives (exit 0). The already-returned result
		// cannot be retroactively failed (documented gap d), so isError is false.
		const dispatch = "async () => ({ isError: true, exitCode: 1, error: 'atomics-boom' })";
		const res = runWorkflowInSubprocess("Atomics.waitAsync(new Int32Array(new SharedArrayBuffer(4)), 0, 0).value.then(() => agent('explorer', 'bad'));\nreturn 'ok';", dispatch);
		assert.equal(res.status, 0, `host crashed (exit ${res.status}): ${res.stderr}`);
		assert.equal(res.out.isError, false);
		assert.equal(res.out.text, "ok");
	});

	it("survives a post-return agent() float scheduled via WebAssembly.compile (host crash-safety)", () => {
		const dispatch = "async () => ({ isError: true, exitCode: 1, error: 'wasm-boom' })";
		const res = runWorkflowInSubprocess("WebAssembly.compile(new Uint8Array([0,97,115,109,1,0,0,0])).then(() => agent('explorer', 'bad'));\nreturn 'ok';", dispatch);
		assert.equal(res.status, 0, `host crashed (exit ${res.status}): ${res.stderr}`);
		assert.equal(res.out.isError, false);
		assert.equal(res.out.text, "ok");
	});

	it("does not float the parallel settle-observer when its onUpdate throws (invariant 3: total observer)", () => {
		// The phantom-slot reap attaches work.then(clear, clear); clear() calls
		// onParallelGroupSettled -> emit -> onUpdate. If onUpdate THROWS on that frame,
		// the promise returned by .then(clear, clear) rejects and floats unless the
		// observer workflow is fully total (try/catch in clear + .catch on the workflow).
		// While a run is live the permanent containment listener would SWALLOW the
		// float (host survives either way), so host-exit can't discriminate — we assert
		// directly that NO unhandledRejection event is emitted for the clear frame.
		const workflowUrl = new URL("../../src/workflow/workflow.ts", import.meta.url).href;
		const program = [
			"const floats = [];",
			"process.on('unhandledRejection', (r) => { floats.push(String(r && r.message ? r.message : r)); });",
			"import(process.env.WF_URL).then(async (m) => {",
			"  const tool = m.createWorkflowTool({ openWorkflowGroup: () => ({ groupRunId: 'g', async dispatchChild({ role, task, index }) { await Promise.resolve(); return { agent: role, task, exitCode: 0, usage: { input: 0, output: 0 }, structuredResult: { status: 'ok', summary: 's', result: 'r' }, progress: { index, agent: role, status: 'completed', task, recentTools: [], recentOutput: [], toolCount: 0, tokens: 0, durationMs: 0, lastActivityAt: Date.now() } }; } }) });",
			// Mixed group (one real agent + one raw thunk) leaves a phantom slot, so
			// parallelGroupSettled actually deletes it and emits the CLEAR frame. That clear
			// frame is the 2nd emit with a single completed result (the 1st is childSettled);
			// throw only there so the observer's totality is what's under test.
			"  let seen = 0; const onUpdate = (u) => { const d = u && u.details; const done = d && d.results && d.results.length === 1 && d.results[0] && d.results[0].progress && d.results[0].progress.status === 'completed'; if (done) { seen++; if (seen === 2) throw new Error('clear onUpdate boom'); } };",
			"  const result = await tool.execute('wf', { script: process.env.WF_SCRIPT }, new AbortController().signal, onUpdate, {});",
			"  await new Promise((r) => setTimeout(r, 120));",
			"  process.stdout.write(JSON.stringify({ isError: result.isError === true, floats }));",
			"}).catch((e) => { process.stderr.write('OUTER:' + String(e)); process.exit(2); });",
		].join("\n");
		const res = spawnSync(process.execPath, ["--experimental-strip-types", "-e", program], {
			encoding: "utf8",
			env: { ...process.env, WF_URL: workflowUrl, WF_SCRIPT: "phase('mixed');\nawait parallel([() => agent('explorer', 'alpha'), async () => 'raw']);\nreturn 'ok';" },
		});
		assert.equal(res.status, 0, `host crashed (exit ${res.status}): ${res.stderr}`);
		const out = res.stdout ? JSON.parse(res.stdout) : { floats: [] };
		assert.deepEqual(out.floats, [], `settle-observer floated: ${JSON.stringify(out.floats)}`);
	});

	it("re-signals a genuine non-workflow rejection when no run is live (does not mask host bugs)", () => {
		// The permanent listener must NOT swallow rejections it cannot attribute to a
		// live workflow. With no run active and us as sole listener, a real host bug
		// must still crash as Node intends.
		const workflowUrl = new URL("../../src/workflow/workflow.ts", import.meta.url).href;
		const program = [
			"import(process.env.WF_URL).then(async (m) => {",
			"  const tool = m.createWorkflowTool({ dispatch: async () => ({ status: 'ok', summary: 's', result: 'r' }) });",
			"  await tool.execute('wf', { script: 'return 1;' }, new AbortController().signal, () => {}, {});",
			"  await new Promise((r) => setTimeout(r, 30));",
			"  Promise.reject(new Error('host-bug'));",
			"  await new Promise((r) => setTimeout(r, 100));",
			"  process.stdout.write('NO-CRASH');",
			"}).catch((e) => { process.stderr.write('OUTER:' + String(e)); process.exit(2); });",
		].join("\n");
		const res = spawnSync(process.execPath, ["--experimental-strip-types", "-e", program], { encoding: "utf8", env: { ...process.env, WF_URL: workflowUrl } });
		assert.notEqual(res.status, 0, "non-workflow host bug should have crashed the process");
		assert.match(res.stderr, /host-bug/);
	});

	it("shares listener state across in-process module reloads so a reloaded module's agent float is contained (round-7 critical)", () => {
		// This host re-imports the extension in the SAME Node process on reload. The
		// permanent unhandledRejection listener installed by the FIRST module instance
		// must still recognize a SECOND (cache-busted) instance's floated agent error
		// — otherwise the stale listener re-signals it as a host bug and crashes. The
		// fix shares the live-run set + run-token key via the globalThis registry.
		const workflowUrl = new URL("../../src/workflow/workflow.ts", import.meta.url).href;
		const program = [
			"const base = process.env.WF_URL;",
			"const m1 = await import(base + '?first');",
			"const tool1 = m1.createWorkflowTool({ dispatch: async () => ({ status: 'ok', summary: 's', result: 'r' }) });",
			"await tool1.execute('wf1', { script: 'return 1;' }, new AbortController().signal, () => {}, {});",
			"const m2 = await import(base + '?second');",
			"const tool2 = m2.createWorkflowTool({ dispatch: async () => ({ isError: true, exitCode: 1, error: 'reload-boom' }) });",
			"const result = await tool2.execute('wf2', { script: \"agent('explorer', 'bad');\\nreturn 'ok';\" }, new AbortController().signal, () => {}, {});",
			"await new Promise((r) => setTimeout(r, 120));",
			"process.stdout.write(JSON.stringify({ isError: result.isError === true, text: (result.content[0] && result.content[0].text) || '' }));",
		].join("\n");
		const res = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", program], { encoding: "utf8", env: { ...process.env, WF_URL: workflowUrl } });
		assert.equal(res.status, 0, `host crashed across reload (exit ${res.status}): ${res.stderr}`);
		const out = JSON.parse(res.stdout) as { isError: boolean; text: string };
		assert.equal(out.isError, true);
		assert.match(out.text, /unhandled promise rejection.*reload-boom/);
	});

	it("re-signals a foreign rejection that merely carries the global run-token symbol when no run is live (round-8 host hygiene)", () => {
		// The run-token key is a global Symbol.for, so any code can attach it. We must
		// brand a rejection as ours only when its token VALUE is one the runtime
		// actually issued (registry WeakSet) — not on mere key presence — otherwise a
		// foreign host bug carrying the symbol would be silently swallowed.
		const workflowUrl = new URL("../../src/workflow/workflow.ts", import.meta.url).href;
		const program = [
			"import(process.env.WF_URL).then(async (m) => {",
			"  const tool = m.createWorkflowTool({ dispatch: async () => ({ status: 'ok', summary: 's', result: 'r' }) });",
			"  await tool.execute('wf', { script: 'return 1;' }, new AbortController().signal, () => {}, {});",
			"  await new Promise((r) => setTimeout(r, 20));",
			"  const e = new Error('symbol-collision-host-bug');",
			"  e[Symbol.for('pi.subagents.workflow.runToken')] = 'foreign-token';",
			"  Promise.reject(e);",
			"  await new Promise((r) => setTimeout(r, 100));",
			"  process.stdout.write('NO-CRASH');",
			"}).catch((e) => { process.stderr.write('OUTER:' + String(e)); process.exit(2); });",
		].join("\n");
		const res = spawnSync(process.execPath, ["--experimental-strip-types", "-e", program], { encoding: "utf8", env: { ...process.env, WF_URL: workflowUrl } });
		assert.notEqual(res.status, 0, "foreign rejection carrying the token symbol must not be masked");
		assert.match(res.stderr, /symbol-collision-host-bug/);
	});

	it("still reports an agent() float when the script reassigns Promise intrinsics (finding #2)", () => {
		// Attribution no longer relies on a script-mutable instanceof brand. Even if
		// the script sets Promise[Symbol.hasInstance] = () => false to try to hide its
		// float, the owned-Set membership (set at TrackingPromise construction) still
		// surfaces the agent() failure.
		const dispatch = "async () => ({ isError: true, exitCode: 1, error: 'hasinstance-boom' })";
		const res = runWorkflowInSubprocess("Promise[Symbol.hasInstance] = () => false;\nagent('explorer', 'bad').then((v) => v);\nreturn 'ok';", dispatch);
		assert.equal(res.status, 0, `host crashed (exit ${res.status}): ${res.stderr}`);
		assert.equal(res.out.isError, true);
		assert.match(res.out.text, /unhandled promise rejection.*hasinstance-boom/);
	});

	it("contains a DELAYED unawaited agent() rejection instead of crashing the host", () => {
		// The hard case the one-macrotask drain missed: an unawaited agent() whose
		// dispatch rejects ~20ms later — long after a naive drain would have reported
		// success and detached the listener.
		const dispatch = "async () => { await new Promise((r) => setTimeout(r, 20)); return { isError: true, exitCode: 1, error: 'late-agent-boom' }; }";
		const res = runWorkflowInSubprocess("agent('explorer', 'late');\nreturn 'ok';", dispatch);
		assert.equal(res.status, 0, `host crashed (exit ${res.status}): ${res.stderr}`);
		assert.equal(res.out.isError, true);
		assert.match(res.out.text, /unhandled promise rejection.*late-agent-boom/);
	});

	it("does NOT false-fail a delayed agent() rejection the script awaits and catches", () => {
		const dispatch = "async () => { await new Promise((r) => setTimeout(r, 20)); return { isError: true, exitCode: 1, error: 'handled-boom' }; }";
		const res = runWorkflowInSubprocess("try { await agent('explorer', 'x'); } catch (e) { /* handled */ }\nreturn 'ok-handled';", dispatch);
		assert.equal(res.status, 0, `host crashed (exit ${res.status}): ${res.stderr}`);
		assert.equal(res.out.isError, false);
		assert.equal(res.out.text, "ok-handled");
	});

	// Run two concurrent workflows in a subprocess: A only awaits its own clean
	// slow work; B floats a rejection (bScript). Returns each run's settled state
	// plus the child exit code. Subprocess because B's floated promise stays
	// genuinely unhandled, which node:test's own listener would attribute to this
	// test in-process.
	function runConcurrentWorkflows(bScript: string): { status: number | null; stderr: string; out: { aStatus: string; aValue: string; bStatus: string; bReason: string } } {
		const workflowUrl = new URL("../../src/workflow/workflow.ts", import.meta.url).href;
		const program = [
			"import(process.env.WF_URL).then(async (m) => {",
			"  const delay = (ms) => new Promise((r) => setTimeout(r, ms));",
			"  const dispatch = async (_role, task) => {",
			"    if (task === 'slow-ok') { await delay(100); return { status: 'ok', summary: 'slow', result: 'slow' }; }",
			"    if (task === 'bad') { await delay(20); return { isError: true, exitCode: 1, error: 'foreign-boom' }; }",
			"    return { status: 'ok', summary: task, result: task };",
			"  };",
			"  const a = m.runWorkflowScript({ dispatch, script: \"await agent('explorer', 'slow-ok');\\nreturn 'A-ok';\" });",
			"  const b = m.runWorkflowScript({ dispatch, script: process.env.WF_B_SCRIPT });",
			"  const [ra, rb] = await Promise.allSettled([a, b]);",
			"  await delay(60);",
			"  process.stdout.write(JSON.stringify({",
			"    aStatus: ra.status, aValue: ra.status === 'fulfilled' ? ra.value : String(ra.reason && ra.reason.message),",
			"    bStatus: rb.status, bReason: rb.status === 'rejected' ? String(rb.reason && rb.reason.message) : '',",
			"  }));",
			"}).catch((e) => { process.stderr.write('OUTER:' + String(e)); process.exit(2); });",
		].join("\n");
		const res = spawnSync(process.execPath, ["--experimental-strip-types", "-e", program], {
			encoding: "utf8",
			env: { ...process.env, WF_URL: workflowUrl, WF_B_SCRIPT: bScript },
		});
		return { status: res.status, stderr: res.stderr, out: res.stdout ? JSON.parse(res.stdout) : { aStatus: "", aValue: "", bStatus: "", bReason: "" } };
	}

	it("does NOT cross-attribute a peer run's floated agent() rejection under concurrency", () => {
		// When B finishes first, a check-time sole-active test would let A claim B's
		// rejection. Per-run attribution keeps A clean while B owns its float.
		const res = runConcurrentWorkflows("agent('explorer', 'bad');\nreturn 'B-ok';");
		assert.equal(res.status, 0, `host crashed (exit ${res.status}): ${res.stderr}`);
		assert.equal(res.out.aStatus, "fulfilled", `A wrongly rejected: ${res.out.aValue}`);
		assert.equal(res.out.aValue, "A-ok");
		assert.equal(res.out.bStatus, "rejected");
		assert.match(res.out.bReason, /unhandled promise rejection.*foreign-boom/);
	});

	it("does not let a concurrent raw Promise.reject crash the host or affect a peer (best-effort gap)", () => {
		// B floats a RAW Promise.reject (no agent()/parallel() lineage). By design this
		// is best-effort: B is NOT failed (no TrackingPromise to attribute), but the
		// host must SURVIVE and the clean peer A must stay fulfilled. This encodes the
		// documented gap as a contract and guards the no-cross-attribution invariant.
		const res = runConcurrentWorkflows("Promise.reject(new Error('raw-boom'));\nreturn 'B-ok';");
		assert.equal(res.status, 0, `host crashed (exit ${res.status}): ${res.stderr}`);
		assert.equal(res.out.aStatus, "fulfilled", `A wrongly rejected: ${res.out.aValue}`);
		assert.equal(res.out.aValue, "A-ok");
		assert.equal(res.out.bStatus, "fulfilled");
	});
});
