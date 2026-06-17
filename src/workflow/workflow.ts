import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import vm from "node:vm";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { ASYNC_NO_POLL_GUIDANCE, formatAsyncStatusHint } from "../surfaces/async-guidance.ts";
import { writeWorkflowScript } from "./workflow-group-state.ts";
import type { SubmitResultEnvelope } from "../protocol/submit-result.ts";
import type { AgentProgress, Details, SingleResult } from "../protocol/types.ts";

export const WorkflowParams = Type.Object(
	{
		script: Type.String(),
		async: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);

export interface WorkflowDispatchOutcome {
	envelope?: SubmitResultEnvelope;
	isError?: boolean;
	exitCode?: number;
	error?: string;
	interrupted?: boolean;
}

export type WorkflowDispatchResult = SubmitResultEnvelope | WorkflowDispatchOutcome;
export interface WorkflowDispatchTags {
	parallelGroupId?: string;
	// Workflow-authored result schema for this child's submit_result. The script
	// owns the contract via agent(role, task, { schema }); the child never decides
	// its own shape and the public subagent tool never receives a schema.
	resultSchema?: TSchema;
}
export type WorkflowDispatch = (
	role: string,
	task: string,
	tags?: WorkflowDispatchTags,
) => Promise<WorkflowDispatchResult>;
export type WorkflowPhaseEmit = (title: string) => void;

export interface WorkflowGroupHandle {
	groupRunId: string;
	async?: boolean;
	asyncDir?: string;
	dispatchChild(args: {
		role: string;
		task: string;
		index: number;
		phaseIndex?: number;
		phaseTitle?: string;
		parallelGroupId?: string;
		resultSchema?: TSchema;
	}): Promise<SingleResult>;
	finishAsync?(success: boolean, summary?: string): void;
	failWorkflow?(message: string, tags?: { phaseIndex?: number; phaseTitle?: string }): Promise<void>;
	/**
	 * Run `fn` (a SYNC workflow script execution) while the calling agent's leaf
	 * permit is parked. The agent that invoked the workflow tool is mid-prompt and
	 * holds a leaf slot; parking it for the span it awaits its workflow children
	 * keeps the one process-wide concurrency pool deadlock-free. Implemented by the
	 * dispatch layer (which knows the caller's runId); a no-op when absent.
	 */
	parkWhileRunning?<T>(fn: () => Promise<T>): Promise<T>;
}

export interface WorkflowRuntimeOptions {
	dispatch: WorkflowDispatch;
	onPhase?: WorkflowPhaseEmit;
	// Announced synchronously when parallel(thunks) starts, BEFORE any child
	// dispatches, carrying the group id + size so the live header denominator can
	// account for siblings that have not registered into results[] yet.
	onParallelGroup?: (groupId: string, size: number) => void;
	// Announced when a parallel(thunks) group settles (all thunks resolved/rejected).
	// Clears any pending slots a thunk reserved but never spent on an agent() dispatch
	// (e.g. a raw `async () => 'x'` thunk), so a completed run never shows an inflated
	// denominator. By settle time every real agent has already registered (a thunk only
	// resolves after its awaited agent() does), so this only reaps phantom slots.
	onParallelGroupSettled?: (groupId: string) => void;
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
	const rawToken =
		reason && typeof reason === "object" ? (reason as Record<symbol, unknown>)[WORKFLOW_RUN_TOKEN] : undefined;
	const token =
		typeof rawToken === "object" && rawToken !== null && issuedTokens.has(rawToken) ? rawToken : undefined;
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
		setImmediate(() => {
			throw reason instanceof Error ? reason : new Error(String(reason));
		});
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
	// A direct envelope is the single-field { result } shape. The alternative
	// (WorkflowDispatchOutcome) carries envelope/isError/exitCode/... at top level
	// and never a bare top-level `result`, so this stays unambiguous.
	return Boolean(value) && typeof value === "object" && "result" in value && !("envelope" in value);
}

function dispatchFailureMessage(role: string, outcome: WorkflowDispatchOutcome): string {
	if (outcome.interrupted) return `agent '${role}' was interrupted`;
	if (outcome.error) return `agent '${role}' failed: ${outcome.error}`;
	if (outcome.exitCode !== undefined && outcome.exitCode !== 0)
		return `agent '${role}' failed with exit code ${outcome.exitCode}`;
	return `agent '${role}' failed`;
}

function failureEnvelope(role: string, task: string, outcome: WorkflowDispatchOutcome): SubmitResultEnvelope {
	return (
		outcome.envelope ?? {
			result: { role, task, exitCode: outcome.exitCode, error: outcome.error, interrupted: outcome.interrupted },
		}
	);
}

// Returns the child's `result` value DIRECTLY (a string by default, or the typed
// object when the workflow supplied a schema) — Claude-style. The single-field
// envelope is unwrapped here so scripts write `fix` / `review.approved`, never
// `fix.result`. Failure is keyed on the dispatch outcome (isError/exitCode/error/
// interrupted), never on any child self-reported status, and throws so the script
// can catch/branch.
async function agentGlobal(
	dispatch: WorkflowDispatch,
	role: string,
	task: string,
	tags?: WorkflowDispatchTags,
): Promise<unknown> {
	const outcome = await dispatch(role, task, tags);
	if (isSubmitResultEnvelopeLike(outcome)) return outcome.result;
	if (
		outcome.isError === true ||
		(outcome.exitCode !== undefined && outcome.exitCode !== 0) ||
		outcome.error ||
		outcome.interrupted === true
	) {
		const envelope = failureEnvelope(role, task, outcome);
		throw new WorkflowAgentError(dispatchFailureMessage(role, outcome), envelope);
	}
	if (outcome.envelope) return outcome.envelope.result;
	throw new WorkflowAgentError(
		`agent '${role}' returned no submit_result envelope`,
		failureEnvelope(role, task, { ...outcome, error: "missing submit_result envelope" }),
	);
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
	// NON-agent raw error thrown through a tracked parallel()/agent() path).
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
		static get [Symbol.species]() {
			return TrackingPromise;
		}
		constructor(
			executor: (resolve: (value: T | PromiseLike<T>) => void, reject: (reason?: unknown) => void) => void,
		) {
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
		settled.push(
			stamped.then(
				() => {},
				() => {},
			),
		);
		return new TrackingPromise<T>((resolve, reject) => {
			stamped.then(resolve, reject);
		});
	};

	const parallelGroupStore = new AsyncLocalStorage<string>();
	// A workflow script runs in a VM with no imports, so it cannot author a TypeBox
	// schema. It passes a PLAIN JSON Schema object via agent(role, task, { schema }).
	// We wrap it with Type.Unsafe at this boundary so the child's submit_result tool
	// (Compile().Check()) enforces it — verified to reject missing/typed/extra fields.
	// Fail closed: a non-object schema is a script bug, so we throw rather than
	// silently drop the contract down to the default any-JSON result.
	const toResultSchema = (schema: unknown): TSchema => {
		if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
			throw new TypeError("agent(role, task, { schema }) expects a plain JSON Schema object");
		}
		return Type.Unsafe(schema as Record<string, unknown>);
	};
	const agent = (role: string, task: string, opts?: { schema?: unknown }) => {
		const groupId = parallelGroupStore.getStore();
		const resultSchema = opts?.schema !== undefined ? toResultSchema(opts.schema) : undefined;
		return track(
			agentGlobal(options.dispatch, role, task, {
				...(groupId ? { parallelGroupId: groupId } : {}),
				...(resultSchema ? { resultSchema } : {}),
			}),
		);
	};
	const parallel = <T>(thunks: Array<() => Promise<T>>) => {
		if (!Array.isArray(thunks)) return track(parallelGlobal(thunks));
		const groupId = randomUUID();
		const size = thunks.length;
		const sized = size > 1;
		if (sized) options.onParallelGroup?.(groupId, size);
		// Build the member-promise array with a HOST-OWNED loop (never the script
		// array's own .map, which a hostile script can poison to throw AFTER the
		// pending slot is reserved, stranding it). Invoke each thunk EXACTLY once
		// inside the ALS scope so the groupId propagates into every agent() it
		// awaits, and normalize each member with Promise.resolve(...) so a custom
		// thenable is assimilated ONCE here (inside the store) — otherwise sharing
		// the raw thenable would let Promise.all and Promise.allSettled call its
		// .then separately (double dispatch, untagged, outside the store). A
		// synchronous throw (bad thunk, poisoned element access) becomes a rejected
		// promise so it can never escape before the reaper observer attaches.
		const memberPromises = parallelGroupStore.run(groupId, () => {
			const members: Array<Promise<unknown>> = [];
			for (let index = 0; index < size; index += 1) {
				try {
					const thunk = thunks[index];
					members.push(Promise.resolve(thunk()));
				} catch (error) {
					members.push(Promise.reject(error));
				}
			}
			return members;
		});
		const work = Promise.all(memberPromises);
		if (sized) {
			// Reap any phantom pending slot once the whole group settles. Driven by
			// allSettled (NOT `work`, which rejects on the FIRST rejection) so a slow
			// sibling that calls agent() late still registers its childStarted before
			// we reap — otherwise a failing-fast group could delete a not-yet-registered
			// sibling's pending slot and render a premature 'agent N-1/N'. Attached as a
			// fully-total observer so it never floats: allSettled never rejects, the
			// callback itself can't throw (a throwing onParallelGroupSettled/emit must
			// not reject the observer path), and the returned promise is swallowed.
			// The script still awaits the separate tracked Promise.all below.
			const clear = () => {
				try {
					options.onParallelGroupSettled?.(groupId);
				} catch {
					// Reaping is best-effort; a render-side throw must never float.
				}
			};
			void Promise.allSettled(memberPromises)
				.then(clear, clear)
				.catch(() => {});
		}
		return track(work);
	};
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
	requestedAsync?: boolean;
}

export interface CreateWorkflowToolOptions {
	dispatch?: (role: string, task: string, context: WorkflowToolDispatchContext) => Promise<WorkflowDispatchResult>;
	openWorkflowGroup?: (context: WorkflowToolDispatchContext) => WorkflowGroupHandle;
}

type WorkflowPhaseEmitter = WorkflowPhaseEmit & {
	phaseIndex(): number;
	phaseTitle(): string | undefined;
	childStarted(
		role: string,
		task: string,
		index: number,
		meta?: { phaseIndex?: number; parallelGroupId?: string },
	): void;
	childSettled(result: SingleResult, index: number): void;
	// Declares that `size` agents will be dispatched as the parallel group
	// `groupId`, so the live header denominator counts them before each has
	// individually registered into results[].
	expectParallel(groupId: string, size: number): void;
	// Drops any remaining pending slots for `groupId` once its parallel group has
	// fully settled, reaping phantom thunks that never dispatched an agent.
	parallelGroupSettled(groupId: string): void;
	// Canonical Details snapshot of the run so far. The success path returns this
	// as the tool result's `details` so the final widget frame is a real Details
	// (never the script's arbitrary return value — that flows through content text).
	snapshot(): Details;
};

function makeProgress(role: string, task: string, index: number, status: AgentProgress["status"]): AgentProgress {
	return {
		index,
		agent: role,
		status,
		task,
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		tokens: 0,
		durationMs: 0,
		lastActivityAt: Date.now(),
	};
}

export function createWorkflowPhaseEmitter(
	toolCallId: string,
	onUpdate?: (partialResult: AgentToolResult<Details>) => void,
): WorkflowPhaseEmitter {
	void toolCallId;
	// Canonical parallel shape (mirrors runForegroundParallelTasks' mergedResults):
	// ONE SingleResult per agent lives in results[] for the whole run — a running
	// placeholder from childStarted, replaced in place at childSettled. The renderer
	// iterates results[] for body rows and uses results.length as the denominator,
	// so a running agent MUST already be in results[] or it vanishes from the body
	// and the "k/N" count is wrong. progress[] is derived from results[].progress so
	// header, body, and denominator stay aligned.
	const results = new Map<number, SingleResult>();
	const childPhases = new Map<number, { phaseIndex: number; phaseTitle?: string; parallelGroupId?: string }>();
	let phaseIndex = 0;
	let phaseTitle = "";
	// Per-group count of agents declared via parallel() that have not yet
	// registered into results[] (each suspends at its own dispatch before
	// childStarted fires). A fan-out of N records N up front, then decrements as
	// each member starts, so the running-frame denominator is (registered +
	// sum(pending)) and a 2-agent group reads "1/2" from its first frame instead
	// of "1/1". Keyed by groupId so concurrent groups never cross-decrement and a
	// size-1 group (never recorded) cannot consume another group's pending slot.
	const pendingByGroup = new Map<string, number>();
	const pendingParallelTotal = () => {
		let n = 0;
		for (const v of pendingByGroup.values()) n += v;
		return n;
	};
	// ONE builder for both the live onUpdate frame and the final snapshot() so the
	// two can never drift in shape.
	const buildDetails = (): Details => {
		const orderedEntries = [...results.entries()].sort(([a], [b]) => a - b);
		const ordered = orderedEntries.map(([, result]) => result);
		const agentGroups: string[] = [];
		for (let i = 0; i < orderedEntries.length; i++) {
			const [index, result] = orderedEntries[i]!;
			const parallelGroupId = childPhases.get(index)?.parallelGroupId;
			if (!parallelGroupId) {
				agentGroups.push(result.agent);
				continue;
			}
			const group = [result.agent];
			while (i + 1 < orderedEntries.length) {
				const [nextIndex, nextResult] = orderedEntries[i + 1]!;
				if (childPhases.get(nextIndex)?.parallelGroupId !== parallelGroupId) break;
				group.push(nextResult.agent);
				i++;
			}
			agentGroups.push(group.length === 1 ? group[0]! : `[${group.join("+")}]`);
		}
		return {
			mode: "parallel",
			workflow: true,
			results: ordered,
			progress: ordered.map((result) => result.progress).filter((p): p is AgentProgress => p !== undefined),
			agentGroups,
			totalSteps: agentGroups.length,
			// Widen the running-frame denominator to include parallel siblings that
			// have not registered yet. Only meaningful while agents are in flight; once
			// everything settles, pendingByGroup is empty and the header falls back to
			// results.length, so a completed run never shows an inflated total.
			...(pendingParallelTotal() > 0 ? { expectedAgents: ordered.length + pendingParallelTotal() } : {}),
			// Surface the live phase title through the typed run-level label, which the
			// parallel header renders via uniformLabel. No fake "k/N" denominator: the
			// total phase count is unknowable until the script finishes.
			...(phaseTitle ? { label: `Phase ${phaseIndex}: ${phaseTitle}` } : {}),
		};
	};
	const emit = (content: string) => {
		onUpdate?.({ content: [{ type: "text", text: content }], details: buildDetails() });
	};
	const phase = ((title: string) => {
		phaseIndex++;
		phaseTitle = title;
		emit(title);
	}) as WorkflowPhaseEmitter;
	phase.phaseIndex = () => phaseIndex;
	phase.phaseTitle = () => phaseTitle || undefined;
	phase.expectParallel = (groupId: string, size: number) => {
		if (size > 1) pendingByGroup.set(groupId, size);
	};
	phase.parallelGroupSettled = (groupId: string) => {
		// Every agent in this group has registered by now; anything still pending is a
		// phantom thunk (settled without dispatching an agent). Drop it so the completed
		// frame's denominator falls back to results.length.
		if (pendingByGroup.delete(groupId)) emit(phaseTitle || "");
	};
	phase.childStarted = (role, task, index, meta) => {
		// This member is about to register into results[]; drop it from its group's
		// pending count so the denominator (registered + pending) does not
		// double-count it. Only groups recorded by expectParallel (size > 1) decrement.
		const gid = meta?.parallelGroupId;
		if (gid) {
			const remaining = pendingByGroup.get(gid);
			if (remaining !== undefined) {
				if (remaining <= 1) pendingByGroup.delete(gid);
				else pendingByGroup.set(gid, remaining - 1);
			}
		}
		const childPhaseIndex = meta?.phaseIndex ?? phaseIndex;
		const childPhaseTitle = phaseTitle || undefined;
		childPhases.set(index, {
			phaseIndex: childPhaseIndex,
			...(childPhaseTitle ? { phaseTitle: childPhaseTitle } : {}),
			...(meta?.parallelGroupId ? { parallelGroupId: meta.parallelGroupId } : {}),
		});
		const label = childPhaseTitle ? `Phase ${childPhaseIndex}: ${childPhaseTitle}` : undefined;
		results.set(index, {
			agent: role,
			task,
			exitCode: 0,
			usage: { input: 0, output: 0 },
			...(label ? { label } : {}),
			progress: makeProgress(role, task, index, "running"),
		});
		emit(label || `${role} working`);
	};
	phase.childSettled = (result, index) => {
		const status: AgentProgress["status"] = result.exitCode === 0 && !result.interrupted ? "completed" : "failed";
		const progress: AgentProgress = {
			...(result.progress ?? makeProgress(result.agent, result.task, index, status)),
			status,
			...(result.error ? { error: result.error } : {}),
		};
		const childPhase = childPhases.get(index);
		const label = childPhase?.phaseTitle ? `Phase ${childPhase.phaseIndex}: ${childPhase.phaseTitle}` : undefined;
		results.set(index, { ...result, ...(label && !result.label ? { label } : {}), progress });
		emit(phaseTitle || `${result.agent} ${status}`);
	};
	phase.snapshot = buildDetails;
	return phase;
}

export function createWorkflowTool(options: CreateWorkflowToolOptions): ToolDefinition<typeof WorkflowParams, unknown> {
	return {
		name: "workflow",
		label: "Workflow",
		promptSnippet: "Orchestrate subagents with JS control flow: branch on results, retry, loop, fan out",
		description: `Orchestrate multiple subagents with real control flow, written as JavaScript. Use whenever the NEXT step depends on a previous step's result: branch on a child's structured output, retry/fallback on failure, loop until a condition holds (e.g. review until approved), decide fan-out width at runtime, or pass data between steps. Prefer this over multiple subagent calls when any decision sits between dispatches; use plain subagent for a single task or a fixed independent batch.

The script runs in a sandbox with three globals:
- agent(role, task, opts?) -> Promise<result> — dispatch one subagent (same roles as the subagent tool) and get its result DIRECTLY. By default result is a STRING (the child's text output). Rejects if the child fails, so failures propagate unless you catch them. To branch on structured fields, pass opts.schema (a plain JSON Schema object) to FORCE result into that exact shape: the runtime validates it and reprompts a non-compliant child, so result is guaranteed to match. The workflow authors the schema; the child never decides its own shape. Example: const r = await agent("review", "Review this fix.", { schema: { type: "object", required: ["approved"], properties: { approved: { type: "boolean" }, blockers: { type: "array", items: { type: "string" } } }, additionalProperties: false } }); then branch on r.approved.
- parallel(thunks) -> Promise<results[]> — run agent calls concurrently: parallel([() => agent("explorer", "..."), () => agent("qa", "...")]).
- phase(title) — label the current stage for live status displays.

Top-level await is supported. Return a value from the script; it becomes the workflow result. Set async:true to run the whole workflow in the background.

Example (fix, then review-loop until approved, max 2 rounds):
const fix = await agent("fixer", "Fix the flaky test in foo.test.ts");
for (let round = 0; round < 2; round++) {
  const review = await agent("review", "Review the fix and return { approved: boolean }: " + fix, { schema: { type: "object", required: ["approved"], properties: { approved: { type: "boolean" } }, additionalProperties: false } });
  if (review.approved) return { fix, review };
  await agent("fixer", "Address review findings.");
}
return "escalate: review did not approve after 2 rounds";

Rules: always await every agent()/parallel() call — a failed agent surfaces only when its promise is awaited. For concurrency use parallel(), not raw Promise.all/Promise.reject on agent work, so failures are attributed. No setTimeout/fetch/fs in the sandbox; subagents do the real work.`,
		parameters: WorkflowParams,
		async execute(id, params, signal, onUpdate, ctx) {
			// Declared outside the try so the catch can record a synthetic failed child
			// (failWorkflow) for a raw workflow-level error.
			let group: WorkflowGroupHandle | undefined;
			let emitter: WorkflowPhaseEmitter | undefined;
			try {
				const workflowOnUpdate = onUpdate as ((partialResult: AgentToolResult<Details>) => void) | undefined;
				const workflowContext = {
					toolCallId: id,
					signal: signal as AbortSignal,
					onUpdate: workflowOnUpdate,
					ctx,
					requestedAsync: params.async,
				};
				group = options.openWorkflowGroup?.(workflowContext);
				// Persist the script next to the group record so status surfaces can show
				// WHAT this workflow does, not just its children.
				if (group?.asyncDir) writeWorkflowScript(group.asyncDir, params.script);
				let childIndex = 0;
				emitter = createWorkflowPhaseEmitter(id, group?.async ? undefined : workflowOnUpdate);
				const currentPhaseTags = () => ({
					phaseIndex: emitter!.phaseIndex(),
					...(emitter!.phaseTitle() ? { phaseTitle: emitter!.phaseTitle() } : {}),
				});
				const run = () =>
					runWorkflowScript({
						dispatch: async (role, task, tags) => {
							if (group) {
								const index = childIndex++;
								emitter!.childStarted(role, task, index, {
									phaseIndex: emitter!.phaseIndex(),
									...(tags?.parallelGroupId ? { parallelGroupId: tags.parallelGroupId } : {}),
								});
								const result = await group.dispatchChild({
									role,
									task,
									index,
									phaseIndex: emitter!.phaseIndex(),
									...(emitter!.phaseTitle() ? { phaseTitle: emitter!.phaseTitle() } : {}),
									...(tags?.parallelGroupId ? { parallelGroupId: tags.parallelGroupId } : {}),
									...(tags?.resultSchema ? { resultSchema: tags.resultSchema } : {}),
								});
								emitter!.childSettled(result, index);
								return {
									envelope: result.structuredResult,
									isError:
										result.exitCode !== 0 || Boolean(result.error) || result.interrupted === true,
									exitCode: result.exitCode,
									error: result.error,
									interrupted: result.interrupted,
								};
							}
							if (!options.dispatch) throw new Error("workflow dispatch is not configured");
							return options.dispatch(role, task, workflowContext);
						},
						onPhase: emitter,
						onParallelGroup: (groupId, size) => emitter!.expectParallel(groupId, size),
						onParallelGroupSettled: (groupId) => emitter!.parallelGroupSettled(groupId),
						script: params.script,
					});
				if (group?.async) {
					const asyncGroup = group;
					void run()
						.then((value) =>
							asyncGroup.finishAsync?.(true, value === undefined ? "" : stringifyWorkflowValue(value)),
						)
						.catch(async (error) => {
							const message = error instanceof Error ? error.message : String(error);
							await asyncGroup.failWorkflow?.(message, currentPhaseTags());
							asyncGroup.finishAsync?.(false, message);
						});
					const asyncDir = asyncGroup.asyncDir ?? "";
					return {
						content: [
							{
								type: "text",
								text: `Workflow running...\nState: running\n${formatAsyncStatusHint(asyncGroup.groupRunId)}\n${ASYNC_NO_POLL_GUIDANCE}`,
							},
						],
						details: {
							mode: "parallel",
							workflow: true,
							results: [],
							runId: asyncGroup.groupRunId,
							asyncId: asyncGroup.groupRunId,
							asyncDir,
						},
					};
				}
				const value = group?.parkWhileRunning ? await group.parkWhileRunning(run) : await run();
				return {
					content: [{ type: "text", text: stringifyWorkflowValue(value) }],
					// `details` must ALWAYS be a real Details (or undefined), never the
					// script's arbitrary return value — the renderer derefs Details fields.
					// The value still reaches the model via the content text above.
					details: emitter.snapshot(),
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				await group?.failWorkflow?.(
					message,
					emitter
						? {
								phaseIndex: emitter.phaseIndex(),
								...(emitter.phaseTitle() ? { phaseTitle: emitter.phaseTitle() } : {}),
							}
						: undefined,
				);
				return {
					content: [{ type: "text", text: message }],
					isError: true,
					// No Details to show (the envelope/{message} are not a Details); let the
					// renderer fall back to the content text above.
					details: undefined,
				};
			}
		},
	};
}
