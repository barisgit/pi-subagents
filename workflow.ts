import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { parseFrontmatter } from "./frontmatter.ts";
import type { SubmitResultEnvelope } from "./submit-result.ts";
import type { Details } from "./types.ts";

export const WorkflowParams = Type.Object({
	script: Type.String(),
}, { additionalProperties: false });

export interface WorkflowDispatchOutcome {
	envelope?: SubmitResultEnvelope;
	isError?: boolean;
	exitCode?: number;
	error?: string;
	interrupted?: boolean;
}

export type WorkflowDispatchResult = SubmitResultEnvelope | WorkflowDispatchOutcome;
export type WorkflowDispatch = (role: string, task: string) => Promise<WorkflowDispatchResult>;
export type WorkflowPhaseEmit = (title: string) => void;

export interface WorkflowRuntimeOptions {
	dispatch: WorkflowDispatch;
	onPhase?: WorkflowPhaseEmit;
	script: string;
}

export class WorkflowAgentError extends Error {
	envelope: SubmitResultEnvelope;
	constructor(message: string, envelope: SubmitResultEnvelope) {
		super(message);
		this.name = "WorkflowAgentError";
		this.envelope = envelope;
	}
}

// A workflow script runs model-authored JS in a node:vm context and can FLOAT a
// rejected promise. With no process listener Node terminates the HOST pi process
// on unhandledRejection — and that can fire AFTER the tool already reported
// success (e.g. an Atomics.waitAsync/WebAssembly callback that calls agent()
// long after the run returned). A per-run listener removed in finally therefore
// has an uncomputable post-return crash window, so we install ONE permanent,
// process-lifetime listener shared by every run instead.
//
// Attribution is identity-free: agent()/parallel() failures throw a host-realm
// WorkflowAgentError stamped (in track() below) with the producing run's token.
// That token rides on the rejection REASON through any number of intrinsic
// promises (async fns, await, Promise.all), so a floated failure stays
// attributable even when the floated promise itself is not one of ours. The
// owned-Set (TrackingPromise membership) is kept as a secondary claim for a
// non-agent raw error thrown through a tracked parallel()/agent() derivative.
// Shared (Symbol.for) so a token stamped by ONE module instance is read with the
// same key by the permanent listener — which may belong to a DIFFERENT module
// instance after an in-process reload (this host re-imports the extension in the
// same Node process). A module-local Symbol() would make the stale listener
// unable to recognize a reloaded module's agent errors and wrongly crash the host.
const WORKFLOW_RUN_TOKEN = Symbol.for("pi.subagents.workflow.runToken");

interface WorkflowRunState {
	token: object;
	owned: Set<Promise<unknown>>;
	floats: Map<Promise<unknown>, unknown>;
}

interface WorkflowRejectionRegistry {
	liveRuns: Set<WorkflowRunState>;
	// Tokens this runtime actually issued (run.token objects). The listener brands
	// a rejection as ours only if its WORKFLOW_RUN_TOKEN value is in here — mere
	// presence of the Symbol.for key is NOT trusted, since any code can attach a
	// global symbol property and would otherwise opt a foreign host bug into our
	// swallow path. A WeakSet lets returned runs' tokens be GC'd.
	issuedTokens: WeakSet<object>;
	installed: boolean;
}

// The listener's attribution state lives in the globalThis registry, NOT in
// module scope, so every module instance (across reloads) shares ONE live-run
// set and the single installed process listener reads it regardless of which
// instance installed it.
function workflowRejectionRegistry(): WorkflowRejectionRegistry {
	const key = Symbol.for("pi.subagents.workflow.unhandledRejection");
	const globals = globalThis as unknown as Record<symbol, WorkflowRejectionRegistry | undefined>;
	let registry = globals[key];
	if (!registry) {
		registry = { liveRuns: new Set<WorkflowRunState>(), issuedTokens: new WeakSet<object>(), installed: false };
		globals[key] = registry;
	}
	return registry;
}

function handleWorkflowUnhandledRejection(reason: unknown, promise: Promise<unknown>): void {
	const { liveRuns, issuedTokens } = workflowRejectionRegistry();
	// A WorkflowAgentError stamped by track() carries its run's token object under
	// the shared WORKFLOW_RUN_TOKEN key. We trust it ONLY if that value is a token
	// THIS runtime issued (issuedTokens) — not mere key presence, which any code
	// could spoof to opt a foreign host bug into our swallow path. Token identity
	// is cross-module-safe (replaces instanceof, which fails across module instances).
	const rawToken = (reason && typeof reason === "object")
		? (reason as Record<symbol, unknown>)[WORKFLOW_RUN_TOKEN]
		: undefined;
	const token = (typeof rawToken === "object" && rawToken !== null && issuedTokens.has(rawToken))
		? rawToken
		: undefined;
	for (const run of liveRuns) {
		if ((token !== undefined && token === run.token) || run.owned.has(promise)) {
			run.floats.set(promise, reason);
		}
	}
	// R-crash: swallow anything attributable to a workflow (a stamped agent error,
	// even after its run returned) or occurring while any run is live (bounded
	// best-effort masking, equal to the active-run window). Never crash the host.
	if (token !== undefined || liveRuns.size > 0) return;
	// Host hygiene: a genuine NON-workflow rejection with no run live. We must not
	// mask other extensions' / host bugs. If we are the sole listener, reproduce
	// Node's default crash (an approximation — exact stack/exit nuance aside).
	if (process.listenerCount("unhandledRejection") === 1) {
		setImmediate(() => { throw reason instanceof Error ? reason : new Error(String(reason)); });
	}
}

function handleWorkflowRejectionHandled(promise: Promise<unknown>): void {
	// The script caught a previously-floated rejection before our drain read it.
	for (const run of workflowRejectionRegistry().liveRuns) run.floats.delete(promise);
}

function ensureWorkflowRejectionListener(): void {
	const registry = workflowRejectionRegistry();
	if (registry.installed) return;
	registry.installed = true;
	process.on("unhandledRejection", handleWorkflowUnhandledRejection);
	process.on("rejectionHandled", handleWorkflowRejectionHandled);
}

function isSubmitResultEnvelopeLike(value: WorkflowDispatchResult): value is SubmitResultEnvelope {
	return Boolean(value)
		&& typeof value === "object"
		&& "status" in value
		&& "summary" in value
		&& "result" in value;
}

function dispatchFailureMessage(role: string, outcome: WorkflowDispatchOutcome): string {
	if (outcome.interrupted) return `agent '${role}' was interrupted`;
	if (outcome.error) return `agent '${role}' failed: ${outcome.error}`;
	if (outcome.exitCode !== undefined && outcome.exitCode !== 0) return `agent '${role}' failed with exit code ${outcome.exitCode}`;
	return `agent '${role}' failed`;
}

function failureEnvelope(role: string, task: string, outcome: WorkflowDispatchOutcome): SubmitResultEnvelope {
	return outcome.envelope ?? {
		status: "failed",
		summary: dispatchFailureMessage(role, outcome),
		result: { role, task, exitCode: outcome.exitCode, error: outcome.error, interrupted: outcome.interrupted },
		artifacts: [],
	};
}

async function agentGlobal(dispatch: WorkflowDispatch, role: string, task: string): Promise<SubmitResultEnvelope> {
	const outcome = await dispatch(role, task);
	if (isSubmitResultEnvelopeLike(outcome)) return outcome;
	if (outcome.isError === true || outcome.exitCode !== undefined && outcome.exitCode !== 0 || Boolean(outcome.error) || outcome.interrupted === true) {
		const envelope = failureEnvelope(role, task, outcome);
		throw new WorkflowAgentError(dispatchFailureMessage(role, outcome), envelope);
	}
	if (outcome.envelope) return outcome.envelope;
	throw new WorkflowAgentError(`agent '${role}' returned no submit_result envelope`, failureEnvelope(role, task, { ...outcome, error: "missing submit_result envelope" }));
}

async function parallelGlobal<T>(thunks: Array<() => Promise<T>>): Promise<T[]> {
	if (!Array.isArray(thunks)) throw new TypeError("parallel(thunks) expects an array");
	return Promise.all(thunks.map((thunk) => thunk()));
}

export async function runWorkflowScript(options: WorkflowRuntimeOptions): Promise<unknown> {
	// See the module header above ensureWorkflowRejectionListener for the full
	// containment model. Briefly: we DETERMINISTICALLY drain every promise the
	// workflow globals create, then inspect floats captured by the permanent
	// process listener. A floated agent()/parallel() failure is attributed two
	// ways: (1) its WorkflowAgentError reason carries THIS run's token (survives
	// async fns / await / Promise.all — identity-independent), or (2) the floated
	// promise is a TrackingPromise derivative in this run's `owned` Set (catches a
	// NON-agent raw error thrown through a tracked parallel()/agent() chain).
	//
	// Best-effort gap (documented in the tool description): a RAW promise the
	// script fabricates with no agent()/parallel() lineage (a bare
	// `Promise.reject(...)` or raw `Promise.all([...])`) carries no token and is
	// no TrackingPromise, so it is not attributed and the run may report success.
	// The host still survives (the permanent listener swallows it while a run is
	// live). A post-return agent float (e.g. via Atomics.waitAsync/WebAssembly
	// callbacks) likewise cannot crash the host but cannot retroactively fail an
	// already-returned result. Scripts should await and use the blessed parallel().
	ensureWorkflowRejectionListener();
	const registry = workflowRejectionRegistry();
	const liveRuns = registry.liveRuns;
	const settled: Array<Promise<void>> = [];
	const owned = new Set<Promise<unknown>>();
	const runState: WorkflowRunState = { token: {}, owned, floats: new Map<Promise<unknown>, unknown>() };
	registry.issuedTokens.add(runState.token);
	class TrackingPromise<T> extends Promise<T> {
		static get [Symbol.species]() { return TrackingPromise; }
		constructor(executor: (resolve: (value: T | PromiseLike<T>) => void, reject: (reason?: unknown) => void) => void) {
			super(executor);
			owned.add(this as unknown as Promise<unknown>);
		}
	}
	// Tee: observe settlement on the INTERNAL work (always-handled, so it never
	// counts as floating and tells us when work is done), and hand the script a
	// separate TrackingPromise with NO reaction attached — so its handled-ness
	// reflects only the script's own await/.catch/.then. Stamp this run's token
	// onto any WorkflowAgentError so its reason stays attributable no matter what
	// promise (intrinsic async fn, Promise.all, …) ends up floating it.
	const track = <T>(work: Promise<T>): Promise<T> => {
		const stamped = work.catch((reason: unknown) => {
			if (reason instanceof WorkflowAgentError) {
				(reason as unknown as Record<symbol, unknown>)[WORKFLOW_RUN_TOKEN] = runState.token;
			}
			throw reason;
		});
		settled.push(stamped.then(() => {}, () => {}));
		return new TrackingPromise<T>((resolve, reject) => { stamped.then(resolve, reject); });
	};

	const agent = (role: string, task: string) => track(agentGlobal(options.dispatch, role, task));
	const parallel = <T>(thunks: Array<() => Promise<T>>) => track(parallelGlobal(thunks));
	const phase = (title: string) => {
		try {
			options.onPhase?.(title);
		} catch {
			// Progress must never affect the workflow result.
		}
	};
	const ctx = vm.createContext({ agent, parallel, phase });

	liveRuns.add(runState);
	try {
		let value: unknown;
		let scriptError: unknown;
		let threw = false;
		try {
			value = await vm.runInContext(`(async () => {\n${options.script}\n})()`, ctx);
		} catch (error) {
			threw = true;
			scriptError = error;
		}
		// Wait for ALL workflow-created work to settle (no guessed drain window),
		// re-checking because settling work can schedule more. Then one macrotask so
		// Node fires unhandledRejection for anything the script floated.
		let lastLen = -1;
		while (settled.length !== lastLen) {
			lastLen = settled.length;
			await Promise.allSettled(settled.slice());
		}
		await new Promise((resolve) => setImmediate(resolve));
		if (threw) throw scriptError;
		if (runState.floats.size > 0) {
			const [, reason] = runState.floats.entries().next().value as [Promise<unknown>, unknown];
			const message = reason instanceof Error ? reason.message : String(reason);
			throw new Error(`workflow script left an unhandled promise rejection: ${message}`);
		}
		return value;
	} finally {
		liveRuns.delete(runState);
	}
}

function stringifyWorkflowValue(value: unknown): string {
	if (typeof value === "string") return value;
	if (value === undefined) return "undefined";
	return JSON.stringify(value, null, 2);
}

export interface WorkflowToolDispatchContext {
	toolCallId: string;
	signal: AbortSignal;
	onUpdate?: (partialResult: AgentToolResult<Details>) => void;
	ctx: ExtensionContext;
}

export interface CreateWorkflowToolOptions {
	dispatch: (role: string, task: string, context: WorkflowToolDispatchContext) => Promise<WorkflowDispatchResult>;
}

export function createWorkflowPhaseEmitter(toolCallId: string, onUpdate?: (partialResult: AgentToolResult<Details>) => void): WorkflowPhaseEmit {
	return (title: string) => {
		onUpdate?.({
			content: [{ type: "text", text: title }],
			details: {
				mode: "single",
				results: [],
				progress: [{
					index: 0,
					agent: "workflow",
					status: "running",
					task: title,
					recentTools: [],
					recentOutput: [title],
					toolCount: 0,
					tokens: 0,
					durationMs: 0,
					lastActivityAt: Date.now(),
				}],
			} as Details,
		});
	};
}

export function createWorkflowTool(options: CreateWorkflowToolOptions): ToolDefinition<typeof WorkflowParams, unknown> {
	return {
		name: "workflow",
		label: "Workflow",
		promptSnippet: "Run a small JS workflow with agent, parallel, and phase globals",
		description: "Run agent-authored JavaScript in a node:vm sandbox. Globals: agent(role, task) -> Promise<envelope> (rejects if the child fails), parallel(thunks) -> Promise<results[]>, phase(title). Always await every agent()/parallel() call (or run them through parallel()); a failed agent surfaces only when its promise is awaited. Avoid raw Promise.reject/Promise.all on agent work — use parallel() so failures are reported.",
		parameters: WorkflowParams,
		async execute(id, params, signal, onUpdate, ctx) {
			try {
				const workflowOnUpdate = onUpdate as ((partialResult: AgentToolResult<Details>) => void) | undefined;
				const value = await runWorkflowScript({
					dispatch: (role, task) => options.dispatch(role, task, { toolCallId: id, signal: signal as AbortSignal, onUpdate: workflowOnUpdate, ctx }),
					onPhase: createWorkflowPhaseEmitter(id, workflowOnUpdate),
					script: params.script,
				});
				return {
					content: [{ type: "text", text: stringifyWorkflowValue(value) }],
					details: value,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text", text: message }],
					isError: true,
					details: error instanceof WorkflowAgentError ? error.envelope : { message },
				};
			}
		},
	};
}

export interface WorkflowRecipe {
	name: string;
	meta: Record<string, string>;
	script: string;
	filePath: string;
	source: "project" | "user" | "builtin";
}

export interface WorkflowSearchRoot {
	dir: string;
	source: WorkflowRecipe["source"];
}

function isDirectory(candidate: string): boolean {
	try {
		return fs.statSync(candidate).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectRoot(cwd: string): string | undefined {
	let current = path.resolve(cwd);
	while (true) {
		if (isDirectory(path.join(current, ".git")) || isDirectory(path.join(current, ".pi")) || fs.existsSync(path.join(current, "package.json"))) return current;
		const parent = path.dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

export function defaultWorkflowSearchRoots(cwd: string): WorkflowSearchRoot[] {
	const roots: WorkflowSearchRoot[] = [];
	const projectRoot = findNearestProjectRoot(cwd);
	if (projectRoot) {
		roots.push({ dir: path.join(projectRoot, ".workflows"), source: "project" });
		roots.push({ dir: path.join(projectRoot, ".pi", "workflows"), source: "project" });
	}
	roots.push({ dir: path.join(os.homedir(), ".pi", "agent", "workflows"), source: "user" });
	roots.push({ dir: path.join(os.homedir(), ".workflows"), source: "user" });
	roots.push({ dir: path.join(path.dirname(fileURLToPath(import.meta.url)), "workflows"), source: "builtin" });
	return roots;
}

function recipeNameFromFile(filePath: string, frontmatter: Record<string, string>): string {
	return frontmatter.name?.trim() || path.basename(filePath).replace(/\.[^.]+$/, "");
}

function loadRecipesFromRoot(root: WorkflowSearchRoot): WorkflowRecipe[] {
	if (!isDirectory(root.dir)) return [];
	const entries = fs.readdirSync(root.dir, { withFileTypes: true });
	const recipes: WorkflowRecipe[] = [];
	for (const entry of entries) {
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;
		if (!/\.(js|mjs|workflow)$/.test(entry.name)) continue;
		const filePath = path.join(root.dir, entry.name);
		const content = fs.readFileSync(filePath, "utf8");
		const { frontmatter, body } = parseFrontmatter(content);
		recipes.push({
			name: recipeNameFromFile(filePath, frontmatter),
			meta: frontmatter,
			script: body,
			filePath,
			source: root.source,
		});
	}
	return recipes;
}

export function discoverWorkflowRecipes(options?: { cwd?: string; searchRoots?: WorkflowSearchRoot[] }): WorkflowRecipe[] {
	const roots = options?.searchRoots ?? defaultWorkflowSearchRoots(options?.cwd ?? process.cwd());
	const byName = new Map<string, WorkflowRecipe>();
	for (const root of roots) {
		for (const recipe of loadRecipesFromRoot(root)) {
			if (!byName.has(recipe.name)) byName.set(recipe.name, recipe);
		}
	}
	return [...byName.values()];
}

export function loadWorkflowRecipe(name: string, options?: { cwd?: string; searchRoots?: WorkflowSearchRoot[] }): WorkflowRecipe | undefined {
	return discoverWorkflowRecipes(options).find((recipe) => recipe.name === name);
}
