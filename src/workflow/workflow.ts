import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import vm from "node:vm";
import { ConcurrencySemaphore } from "../dispatch/concurrency-semaphore.ts";
import type { AgentToolUpdateCallback, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static, type TSchema } from "typebox";
import { ASYNC_NO_POLL_GUIDANCE, formatAsyncStatusHint } from "../surfaces/async-guidance.ts";
import {
	writeWorkflowGroupPhase,
	writeWorkflowGroupResult,
	writeWorkflowMeta,
	writeWorkflowScript,
} from "./workflow-group-state.ts";
import type { SubmitResultEnvelope } from "../protocol/output-contract.ts";
import { parseWorkflowMeta, type WorkflowMeta } from "../protocol/workflow-meta.ts";
import { processGlobal } from "../shared/process-global.ts";
import { canonicalWorkflowPhaseTitle } from "../shared/workflow-phase-title.ts";
import { formatWorkflowPhase } from "../state/workflow-display.ts";
import type { AgentProgress, Details, PipelineMetadata, SingleResult, SubagentToolResult } from "../protocol/types.ts";

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

function workflowRejectionMessage(error: unknown): string {
	try {
		if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
			return error.message;
		}
	} catch {
		// A rejected value may expose a throwing message getter.
	}
	try {
		return String(error);
	} catch {
		return "Unknown error";
	}
}

export type WorkflowDispatchResult = SubmitResultEnvelope | WorkflowDispatchOutcome;
export interface WorkflowDispatchTags {
	phaseIndex?: number;
	phaseTitle?: string;
	label?: string;
	cwd?: string;
	parallelGroupId?: string;
	pendingGroupId?: string;
	pipeline?: PipelineMetadata;
	// Workflow-authored result schema for this child's trailing <output> block. The script
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
	maxPipelineItemsInFlight?: number;
	async?: boolean;
	asyncDir?: string;
	dispatchChild(args: {
		role: string;
		task: string;
		index: number;
		phaseIndex?: number;
		phaseTitle?: string;
		label?: string;
		cwd?: string;
		parallelGroupId?: string;
		pipeline?: PipelineMetadata;
		resultSchema?: TSchema;
		// Live progress callback fired per child session event (sync path only).
		// Lets the workflow emitter repaint the running child's widget frame mid-run.
		onChildProgress?: (progress: AgentProgress) => void;
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
	maxPipelineItemsInFlight?: number;
	onMeta?: (meta: WorkflowMeta) => void;
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
// Attribution is identity-free: agent()/parallel()/pipeline() failures throw a host-realm
// WorkflowAgentError stamped (in track() below) with the producing run's token.
// That token rides on the rejection REASON through any number of intrinsic
// promises (async fns, await, Promise.all), so a floated failure stays
// attributable even when the floated promise itself is not one of ours. The
// owned-Set (TrackingPromise membership) is kept as a secondary claim for a
// non-agent raw error thrown through a tracked parallel()/pipeline()/agent() derivative.
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
	return processGlobal<WorkflowRejectionRegistry>("pi.subagents.workflow.unhandledRejection", () => ({
		liveRuns: new Set<WorkflowRunState>(),
		issuedTokens: new WeakSet<object>(),
		installed: false,
	}));
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

type WorkflowPipelineStage = (value: unknown, originalItem: unknown, index: number) => unknown | Promise<unknown>;

function compactPipelineItemLabel(value: unknown): string | undefined {
	if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return undefined;
	const label = String(value).replace(/\s+/g, " ").trim();
	if (!label) return undefined;
	return label.length > 80 ? `${label.slice(0, 79)}…` : label;
}

function pipelineItemLabel(item: unknown): string | undefined {
	const direct = compactPipelineItemLabel(item);
	if (direct) return direct;
	if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
	const record = item as Record<string, unknown>;
	for (const key of ["file", "path", "name", "title", "id", "label", "branch", "key", "slug"] as const) {
		const label = compactPipelineItemLabel(record[key]);
		if (label) return label;
	}
	return undefined;
}

export async function runWorkflowScript(options: WorkflowRuntimeOptions): Promise<unknown> {
	// See the module header above ensureWorkflowRejectionListener for the full
	// containment model. Briefly: we DETERMINISTICALLY drain every promise the
	// workflow globals create, then inspect floats captured by the permanent
	// process listener. A floated agent()/parallel()/pipeline() failure is attributed two
	// ways: (1) its WorkflowAgentError reason carries THIS run's token (survives
	// async fns / await / Promise.all — identity-independent), or (2) the floated
	// promise is a TrackingPromise derivative in this run's `owned` Set (catches a
	// NON-agent raw error thrown through a tracked parallel()/pipeline()/agent() path).
	//
	// Best-effort gap (documented in the tool description): a RAW promise the
	// script fabricates with no agent()/parallel()/pipeline() lineage (a bare
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
	const configuredPipelineLimit = options.maxPipelineItemsInFlight;
	const pipelineLimit =
		typeof configuredPipelineLimit === "number" &&
		Number.isInteger(configuredPipelineLimit) &&
		configuredPipelineLimit > 0
			? configuredPipelineLimit
			: 8;
	const pipelineAdmission = new ConcurrencySemaphore(pipelineLimit);
	let metadataDeclared = false;
	let orchestrationStarted = false;
	let workflowMeta: WorkflowMeta | undefined;
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
	const meta = (value: unknown) => {
		if (metadataDeclared) throw new Error("meta() may only be called once");
		if (orchestrationStarted) {
			throw new Error(
				"meta() must be called before phase(), agent(), parallel(), parallelSettled(), or pipeline()",
			);
		}
		metadataDeclared = true;
		const parsed = parseWorkflowMeta(value);
		if (!parsed.ok) throw new TypeError(parsed.reason);
		workflowMeta = parsed.value;
		options.onMeta?.(parsed.value);
	};
	const resolveAgentPhaseTitle = (value: unknown): string => {
		if (typeof value !== "string") throw new TypeError("phase title must be a string");
		const title = canonicalWorkflowPhaseTitle(value);
		if (
			workflowMeta &&
			workflowMeta.phases.length > 0 &&
			!workflowMeta.phases.some((phase) => phase.title === title)
		) {
			throw new Error(`phase title '${title}' is not declared in meta.phases`);
		}
		return title;
	};

	const parallelGroupStore = new AsyncLocalStorage<{
		pendingGroupId: string;
		parallelGroupId?: string;
		pipeline?: PipelineMetadata;
	}>();
	// A workflow script runs in a VM with no imports, so it cannot author a TypeBox
	// schema. It passes a PLAIN JSON Schema object via agent(role, task, { schema }).
	// We wrap it with Type.Unsafe at this boundary so the child's trailing <output> block
	// (Compile().Check()) enforces it — verified to reject missing/typed/extra fields.
	// Fail closed: a non-object schema is a script bug, so we throw rather than
	// silently drop the contract down to the default any-JSON result.
	const toResultSchema = (schema: unknown): TSchema => {
		if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
			throw new TypeError("agent(role, task, { schema }) expects a plain JSON Schema object");
		}
		return Type.Unsafe(schema as Record<string, unknown>);
	};
	const agent = (
		role: string,
		task: string,
		opts?: { schema?: unknown; phase?: unknown; label?: unknown; cwd?: unknown },
	) => {
		orchestrationStarted = true;
		const group = parallelGroupStore.getStore();
		const resultSchema = opts?.schema !== undefined ? toResultSchema(opts.schema) : undefined;
		const phaseTitle = opts?.phase !== undefined ? resolveAgentPhaseTitle(opts.phase) : undefined;
		const declaredPhaseIndex = phaseTitle
			? workflowMeta?.phases.findIndex((phase) => phase.title === phaseTitle)
			: undefined;
		if (opts?.label !== undefined && typeof opts.label !== "string") {
			throw new TypeError("agent(role, task, { label }) expects a string");
		}
		if (opts?.cwd !== undefined && (typeof opts.cwd !== "string" || opts.cwd.trim().length === 0)) {
			throw new TypeError("agent(role, task, { cwd }) expects a non-empty string");
		}
		return track(
			agentGlobal(options.dispatch, role, task, {
				...(declaredPhaseIndex !== undefined && declaredPhaseIndex >= 0
					? { phaseIndex: declaredPhaseIndex + 1 }
					: {}),
				...(phaseTitle ? { phaseTitle } : {}),
				...(opts?.label ? { label: opts.label } : {}),
				...(opts?.cwd ? { cwd: opts.cwd } : {}),
				...(group?.pendingGroupId ? { pendingGroupId: group.pendingGroupId } : {}),
				...(group?.parallelGroupId ? { parallelGroupId: group.parallelGroupId } : {}),
				...(group?.pipeline ? { pipeline: group.pipeline } : {}),
				...(resultSchema ? { resultSchema } : {}),
			}),
		);
	};
	const runParallel = <T, R>(
		name: "parallel" | "parallelSettled",
		thunks: Array<() => Promise<T>>,
		collect: (members: Array<Promise<T>>) => Promise<R[]>,
	): Promise<R[]> => {
		orchestrationStarted = true;
		if (!Array.isArray(thunks)) {
			return track(Promise.reject(new TypeError(`${name}(thunks) expects an array`)));
		}
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
		const outerGroup = parallelGroupStore.getStore();
		const memberPromises = parallelGroupStore.run(
			{
				pendingGroupId: groupId,
				parallelGroupId: groupId,
				...(outerGroup?.pipeline ? { pipeline: outerGroup.pipeline } : {}),
			},
			() => {
				const members: Array<Promise<T>> = [];
				for (let index = 0; index < size; index += 1) {
					try {
						const thunk = thunks[index];
						members.push(Promise.resolve(thunk()));
					} catch (error) {
						members.push(Promise.reject(error));
					}
				}
				return members;
			},
		);
		const work = collect(memberPromises);
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
	const parallel = <T>(thunks: Array<() => Promise<T>>) =>
		runParallel("parallel", thunks, (members) => Promise.all(members));
	type ParallelSettledResult<T> = { ok: true; value: T } | { ok: false; error: string };
	const parallelSettled = <T>(thunks: Array<() => Promise<T>>) =>
		runParallel<T, ParallelSettledResult<T>>("parallelSettled", thunks, (members) =>
			Promise.all(
				members.map((member) =>
					member.then<ParallelSettledResult<T>, ParallelSettledResult<T>>(
						(value) => ({ ok: true, value }),
						(error: unknown) => ({ ok: false, error: workflowRejectionMessage(error) }),
					),
				),
			),
		);
	const pipeline = (items: unknown[], ...stages: WorkflowPipelineStage[]) => {
		orchestrationStarted = true;
		if (!Array.isArray(items)) {
			return track(Promise.reject(new TypeError("pipeline(items, ...stages) expects an array")));
		}
		for (let stageIndex = 0; stageIndex < stages.length; stageIndex += 1) {
			if (typeof stages[stageIndex] !== "function") {
				return track(
					Promise.reject(new TypeError("pipeline(items, ...stages) expects every stage to be a function")),
				);
			}
		}
		if (stages.length === 0) {
			const copy: unknown[] = [];
			for (let index = 0; index < items.length; index += 1) copy.push(items[index]);
			return track(Promise.resolve(copy));
		}

		const pipelineId = randomUUID();
		const itemLabels = items.map((item) => pipelineItemLabel(item));
		const groupIds: string[] = [];
		for (let stageIndex = 0; stageIndex < stages.length; stageIndex += 1) groupIds.push(randomUUID());
		const announced = new Set<number>();
		const sized = items.length > 1;
		const runStage = (
			stageIndex: number,
			value: unknown,
			originalItem: unknown,
			itemIndex: number,
		): Promise<unknown> => {
			const groupId = groupIds[stageIndex];
			const stage = stages[stageIndex];
			if (!groupId || !stage) {
				return Promise.reject(new TypeError("pipeline(items, ...stages) expects every stage to be a function"));
			}
			if (sized && groupId && !announced.has(stageIndex)) {
				announced.add(stageIndex);
				options.onParallelGroup?.(groupId, items.length);
			}
			return parallelGroupStore.run(
				{
					pendingGroupId: groupId,
					pipeline: {
						id: pipelineId,
						itemIndex,
						stageIndex,
						...(itemLabels[itemIndex] ? { itemLabel: itemLabels[itemIndex] } : {}),
					},
				},
				() => Promise.resolve(stage(value, originalItem, itemIndex)),
			);
		};
		const itemPromises: Array<Promise<unknown>> = [];
		for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
			const initial = items[itemIndex];
			itemPromises.push(
				(async () => {
					const permit = await pipelineAdmission.acquire();
					try {
						let value = initial;
						for (let stageIndex = 0; stageIndex < stages.length; stageIndex += 1) {
							value = await runStage(stageIndex, value, initial, itemIndex);
						}
						return value;
					} finally {
						permit.release();
					}
				})(),
			);
		}
		const clear = () => {
			try {
				for (const stageIndex of announced) {
					const groupId = groupIds[stageIndex];
					if (groupId) options.onParallelGroupSettled?.(groupId);
				}
			} catch {
				// Reaping is best-effort; a render-side throw must never float.
			}
		};
		settled.push(Promise.allSettled(itemPromises).then(clear, clear));
		return track(Promise.all(itemPromises));
	};
	const phase = (title: string) => {
		orchestrationStarted = true;
		try {
			options.onPhase?.(title);
		} catch {
			// Progress must never affect the workflow result.
		}
	};
	// Keep the sandbox's global prototype chain out of the host realm. Passing an
	// object literal here exposes host Object -> Function through
	// `this.constructor.constructor`. Disabling string code generation also blocks
	// the context's own Function/eval constructors. node:vm is still an isolation
	// aid rather than a security boundary, but these options close the direct host
	// process escape while preserving the callable workflow globals.
	const sandbox = Object.assign(Object.create(null) as Record<string, unknown>, {
		agent,
		parallel,
		parallelSettled,
		pipeline,
		phase,
		meta,
	});
	// Host callables otherwise retain Function.prototype, which exposes the host
	// Function constructor even when the global object itself has no prototype.
	for (const callable of [agent, parallel, parallelSettled, pipeline, phase, meta]) {
		Object.setPrototypeOf(callable, null);
	}
	const ctx = vm.createContext(sandbox, {
		codeGeneration: { strings: false, wasm: false },
	});

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
	onUpdate?: (partialResult: SubagentToolResult) => void;
	ctx: ExtensionContext;
	requestedAsync?: boolean;
	tags?: WorkflowDispatchTags;
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
		meta?: {
			phaseIndex?: number;
			phaseTitle?: string;
			label?: string;
			parallelGroupId?: string;
			pendingGroupId?: string;
			pipeline?: PipelineMetadata;
		},
	): void;
	childSettled(result: SingleResult, index: number): void;
	// Live progress for a running child: replaces the running placeholder's
	// progress in results[] and re-emits, so a SYNC workflow's widget reflects
	// mid-run tool/token activity instead of freezing between childStarted and
	// childSettled. No-op shape change for async (async mirrors via status.json).
	childProgress(index: number, progress: AgentProgress): void;
	// Declares that `size` agents will be dispatched as the parallel group
	// `groupId`, so the live header denominator counts them before each has
	// individually registered into results[].
	expectParallel(groupId: string, size: number): void;
	// Drops any remaining pending slots for `groupId` once its parallel group has
	// fully settled, reaping phantom thunks that never dispatched an agent.
	parallelGroupSettled(groupId: string): void;
	setMeta(meta: WorkflowMeta): void;
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
	onUpdate?: (partialResult: SubagentToolResult) => void,
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
	const childPhases = new Map<
		number,
		{
			phaseIndex: number;
			phaseTitle?: string;
			label?: string;
			parallelGroupId?: string;
			pipeline?: PipelineMetadata;
		}
	>();
	let phaseIndex = 0;
	let phaseTitle = "";
	const reachedPhaseTitles: string[] = [];
	let workflowMeta: WorkflowMeta | undefined;
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
			...(workflowMeta ? { workflowMeta } : {}),
			...(reachedPhaseTitles.length > 0 ? { reachedPhaseTitles: [...reachedPhaseTitles] } : {}),
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
			...(phaseTitle ? { label: formatWorkflowPhase(workflowMeta, phaseIndex, phaseTitle) } : {}),
		};
	};
	const emit = (content: string) => {
		onUpdate?.({ content: [{ type: "text", text: content }], details: buildDetails() });
	};
	const phase = ((title: string) => {
		phaseIndex++;
		phaseTitle = canonicalWorkflowPhaseTitle(title);
		if (!reachedPhaseTitles.includes(phaseTitle)) reachedPhaseTitles.push(phaseTitle);
		emit(phaseTitle);
	}) as WorkflowPhaseEmitter;
	phase.phaseIndex = () => phaseIndex;
	phase.phaseTitle = () => phaseTitle || undefined;
	phase.setMeta = (meta) => {
		workflowMeta = meta;
		emit(phaseTitle);
	};
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
		const gid = meta?.pendingGroupId ?? meta?.parallelGroupId;
		if (gid) {
			const remaining = pendingByGroup.get(gid);
			if (remaining !== undefined) {
				if (remaining <= 1) pendingByGroup.delete(gid);
				else pendingByGroup.set(gid, remaining - 1);
			}
		}
		const childPhaseIndex = meta?.phaseIndex ?? phaseIndex;
		const childPhaseTitle = (meta?.phaseTitle ?? phaseTitle) || undefined;
		childPhases.set(index, {
			phaseIndex: childPhaseIndex,
			...(childPhaseTitle ? { phaseTitle: childPhaseTitle } : {}),
			...(meta?.label ? { label: meta.label } : {}),
			...(meta?.parallelGroupId ? { parallelGroupId: meta.parallelGroupId } : {}),
			...(meta?.pipeline ? { pipeline: meta.pipeline } : {}),
		});
		const label = meta?.label ?? (childPhaseTitle ? `Phase ${childPhaseIndex}: ${childPhaseTitle}` : undefined);
		results.set(index, {
			agent: role,
			task,
			exitCode: 0,
			usage: { input: 0, output: 0 },
			...(meta?.pipeline ? { pipeline: meta.pipeline } : {}),
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
		const label =
			childPhase?.label ??
			(childPhase?.phaseTitle ? `Phase ${childPhase.phaseIndex}: ${childPhase.phaseTitle}` : undefined);
		results.set(index, {
			...result,
			...(childPhase?.pipeline && !result.pipeline ? { pipeline: childPhase.pipeline } : {}),
			...(label && !result.label ? { label } : {}),
			progress,
		});
		emit(phaseTitle || `${result.agent} ${status}`);
	};
	phase.childProgress = (index, progress) => {
		const existing = results.get(index);
		// Only meaningful while the child is the running placeholder; once settled,
		// childSettled owns the final progress and a late frame must not resurrect
		// a "running" status.
		if (!existing || existing.progress?.status !== "running") return;
		results.set(index, { ...existing, progress });
		emit(phaseTitle || `${existing.agent} working`);
	};
	phase.snapshot = buildDetails;
	return phase;
}

/**
 * Workflow tool definition with the extension-owned result shape: `execute`
 * returns a `SubagentToolResult` so callers (and tests) can read the
 * `isError` flag the SDK's `AgentToolResult` no longer carries.
 */
export interface WorkflowToolDefinition extends ToolDefinition<typeof WorkflowParams, unknown> {
	execute(
		toolCallId: string,
		params: Static<typeof WorkflowParams>,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<unknown> | undefined,
		ctx: ExtensionContext,
	): Promise<SubagentToolResult<unknown>>;
}

export function createWorkflowTool(options: CreateWorkflowToolOptions): WorkflowToolDefinition {
	return {
		name: "workflow",
		label: "Workflow",
		promptSnippet: "Orchestrate subagents with JS control flow: branch on results, retry, loop, fan out",
		description: `Orchestrate multiple subagents with real control flow, written as JavaScript. Workflow is the harness's programmable control plane: agent calls, ordinary JavaScript state, and control flow can be nested and composed freely. Use it when runtime results shape later topology—dynamic fan-out, fan-in, branching, retries, feedback, convergence, or synthesis. Plain subagents and Workflow intentionally overlap; choose whichever representation helps the task.

Scaling and composition:
- config maxConcurrentAgents is the process-global active leaf limit and per-workflow direct-child limit. Admission happens before child run records are created.
- pipeline() streams at most config workflow.maxPipelineItemsInFlight item chains at once (default 8); parallel() is a barrier. Both compose in nested loops and branches.

Worked examples—not templates or limits (replace role placeholders with configured roles):
- Discovery fan-out: let a structured child result set the topology; give each branch one self-contained brief and distinct focus.
    const areas = await agent("<investigation-role>", "List the distinct areas this audit must cover. Return only the list.", { schema: { type: "array", items: { type: "string" } } });
    const brief = "Read-only audit of <repo and key paths>. Cite file and line evidence for every claim. Expected output: a findings list. Area: ";
    const reports = await parallel(areas.map((a) => () => agent("<investigation-role>", brief + a)));
- Explore → verify → synthesize: per-item pipeline stages keep every child's context bounded instead of pasting all reports into one prompt.
    const verified = await pipeline(areas,
      (a) => agent("<investigation-role>", "Audit area: " + a),
      (report) => agent("<review-role>", "Re-check each claim against the actual files and commands it cites; drop claims you cannot reproduce, keep the rest verbatim:\\n" + report));
    return await agent("<review-role>", "Synthesize a decision-ready report from these verified area reports:\\n" + verified.join("\\n---\\n"));
- Gate loop: requeue only what has not passed, under an attempt bound.
    let gaps = await agent("<review-role>", "List remaining coverage gaps. Return only the list.", { schema: { type: "array", items: { type: "string" } } });
    for (let round = 0; round < 3 && gaps.length > 0; round++) {
      await parallel(gaps.map((gap) => () => agent("<investigation-role>", "Close this gap: " + gap)));
      gaps = await agent("<review-role>", "List remaining coverage gaps. Return only the list.", { schema: { type: "array", items: { type: "string" } } });
    }
These are ingredients, not canonical recipes. Queues, panels, repair loops, and convergence gates are ordinary JavaScript over the same primitives; design the harness the task deserves.

The script runs in a sandbox with six globals:
- meta({ name, description, phases }) — call once before other globals. phases: ["Recon"] or [{ title: "Recon" }]; objects may add detail; titles are non-empty and unique.
- agent(role, task, opts?) -> Promise<result> — dispatch one subagent. role is a string chosen from the caller's configured agent roles; placeholders like "<investigation-role>" or "<implementation-role>" must be replaced with a real configured role. opts may contain schema, phase, label, and cwd. opts.phase selects this child's phase without changing the default and must match metadata when phases are declared; opts.label is its persisted display label; a relative opts.cwd resolves from the caller/session cwd. By default result is a STRING (the child's text output). Rejects if the child fails, so failures propagate unless you catch them. To branch on structured fields, pass opts.schema (a plain JSON Schema object): the runtime validates and reprompts a non-compliant child, so result is guaranteed to match. The workflow authors the schema; the child never decides its own shape.
- parallel(thunks) -> Promise<results[]> — run thunks concurrently; maxConcurrentAgents bounds direct-child admission and active leaves. It is a FAIL-FAST Promise.all barrier.
- parallelSettled(thunks) -> Promise<Array<{ ok: true, value } | { ok: false, error: string }>> — use instead of per-thunk try/catch when partial results are acceptable; results preserve input order.
- pipeline(items, ...stages) -> Promise<results[]> — stream each item through stages with at most workflow.maxPipelineItemsInFlight item chains active; results preserve input order. Each stage receives (previousResult, originalItem, index); the first receives (item, item, index). It is fail-fast like Promise.all.
- phase(title) — set the default phase for subsequent dispatches. opts.phase overrides one call and is the right tool inside pipeline/parallel callbacks.

Use one pipeline with N stages for dependent per-item work; attribute later stages via opts.phase inside the stage callback. Never split dependent stages into separate pipeline() calls with a phase() barrier between them.

Top-level await is supported; the script's return value is the workflow result. Set async:true to run in the background — the tool returns an id and Pi notifies you on completion; do not poll. Child-session Workflow calls run synchronously despite async/default unless nested async is explicitly enabled in extension config; when enabled, completion starts a new turn in the immediate parent session.

Rules: always await every agent()/parallel()/parallelSettled()/pipeline() call — failures surface only when promises are awaited. Use these concurrency primitives, not raw Promise.all/Promise.reject on agent work, so failures are attributed. No setTimeout/fetch/fs in the sandbox; subagents do the real work.

Each child starts with no conversation context. Make tasks self-contained with paths, constraints, observed behavior, expected output, and whether work is read-only or includes implementation. Verification stages check actual files and commands, not an earlier child's summary.`,
		parameters: WorkflowParams,
		async execute(id, params, signal, onUpdate, ctx) {
			// Declared outside the try so the catch can record a synthetic failed child
			// (failWorkflow) for a raw workflow-level error.
			let group: WorkflowGroupHandle | undefined;
			let emitter: WorkflowPhaseEmitter | undefined;
			try {
				const workflowOnUpdate = onUpdate as ((partialResult: SubagentToolResult) => void) | undefined;
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
						...(group ? { maxPipelineItemsInFlight: group.maxPipelineItemsInFlight } : {}),
						onMeta: (meta) => {
							if (group?.asyncDir) writeWorkflowMeta(group.asyncDir, meta);
							emitter!.setMeta(meta);
						},
						dispatch: async (role, task, tags) => {
							if (group) {
								const index = childIndex++;
								const childPhaseIndex = tags?.phaseIndex ?? emitter!.phaseIndex();
								const childPhaseTitle = tags?.phaseTitle ?? emitter!.phaseTitle();
								emitter!.childStarted(role, task, index, {
									phaseIndex: childPhaseIndex,
									...(childPhaseTitle ? { phaseTitle: childPhaseTitle } : {}),
									...(tags?.label ? { label: tags.label } : {}),
									...(tags?.cwd ? { cwd: tags.cwd } : {}),
									...(tags?.pendingGroupId ? { pendingGroupId: tags.pendingGroupId } : {}),
									...(tags?.parallelGroupId ? { parallelGroupId: tags.parallelGroupId } : {}),
									...(tags?.pipeline ? { pipeline: tags.pipeline } : {}),
								});
								const result = await group.dispatchChild({
									role,
									task,
									index,
									phaseIndex: childPhaseIndex,
									...(childPhaseTitle ? { phaseTitle: childPhaseTitle } : {}),
									...(tags?.label ? { label: tags.label } : {}),
									...(tags?.cwd ? { cwd: tags.cwd } : {}),
									...(tags?.parallelGroupId ? { parallelGroupId: tags.parallelGroupId } : {}),
									...(tags?.pipeline ? { pipeline: tags.pipeline } : {}),
									...(tags?.resultSchema ? { resultSchema: tags.resultSchema } : {}),
									onChildProgress: (progress) => emitter!.childProgress(index, progress),
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
							return options.dispatch(role, task, { ...workflowContext, ...(tags ? { tags } : {}) });
						},
						onPhase: (title) => {
							emitter!(title);
							if (group?.asyncDir) {
								writeWorkflowGroupPhase(group.asyncDir, emitter!.phaseIndex(), title);
							}
						},
						onParallelGroup: (groupId, size) => emitter!.expectParallel(groupId, size),
						onParallelGroupSettled: (groupId) => emitter!.parallelGroupSettled(groupId),
						script: params.script,
					});
				const runAndPersistResult = async () => {
					const value = await run();
					if (group?.asyncDir) writeWorkflowGroupResult(group.asyncDir, value);
					return value;
				};
				if (group?.async) {
					const asyncGroup = group;
					void runAndPersistResult()
						.then((value) => {
							asyncGroup.finishAsync?.(true, value === undefined ? "" : stringifyWorkflowValue(value));
						})
						.catch(async (error) => {
							const message = error instanceof Error ? error.message : String(error);
							try {
								await asyncGroup.failWorkflow?.(message, currentPhaseTags());
							} finally {
								asyncGroup.finishAsync?.(false, message);
							}
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
							...emitter.snapshot(),
							results: [],
							progress: [],
							runId: asyncGroup.groupRunId,
							asyncId: asyncGroup.groupRunId,
							asyncDir,
						},
					};
				}
				const value = group?.parkWhileRunning
					? await group.parkWhileRunning(runAndPersistResult)
					: await runAndPersistResult();
				return {
					content: [{ type: "text", text: stringifyWorkflowValue(value) }],
					// `details` must ALWAYS be a real Details (or undefined), never the
					// script's arbitrary return value — the renderer derefs Details fields.
					// The value still reaches the model via the content text above.
					details: emitter.snapshot(),
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				try {
					await group?.failWorkflow?.(
						message,
						emitter
							? {
									phaseIndex: emitter.phaseIndex(),
									...(emitter.phaseTitle() ? { phaseTitle: emitter.phaseTitle() } : {}),
								}
							: undefined,
					);
				} finally {
					if (group?.async) group.finishAsync?.(false, message);
				}
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
