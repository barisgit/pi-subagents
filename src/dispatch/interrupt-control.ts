import type { ChildAgentResult, ChildAgentRegistry } from "./in-process-executor.ts";
import { readAllEntries } from "../state/runs-registry.ts";
import { evictCompletionDedupeForRunId, markCompletionDedupeForRunId } from "../state/completion-dedupe.ts";
import { interruptRun, awaitRunTerminal, type AwaitRunTerminalOutcome } from "./layer0-runs.ts";
import type { SubagentState, SubagentToolResult } from "../protocol/types.ts";

export function getForegroundControl(state: SubagentState, runId: string | undefined) {
	if (runId) return state.foregroundControls.get(runId);
	if (state.lastForegroundControlId) {
		const latest = state.foregroundControls.get(state.lastForegroundControlId);
		if (latest) return latest;
	}
	let newest: (SubagentState["foregroundControls"] extends Map<string, infer T> ? T : never) | undefined;
	for (const control of state.foregroundControls.values()) {
		if (!newest || control.updatedAt > newest.updatedAt) newest = control;
	}
	return newest;
}
function formatForegroundActivity(
	control: SubagentState["foregroundControls"] extends Map<string, infer T> ? T : never,
): string | undefined {
	if (control.currentTool && control.currentToolStartedAt !== undefined) {
		return `tool ${control.currentTool} for ${Math.floor(Math.max(0, Date.now() - control.currentToolStartedAt) / 1000)}s`;
	}
	if (control.lastActivityAt === undefined)
		return control.currentActivityState === "needs_attention" ? "needs attention" : undefined;
	const seconds = Math.floor(Math.max(0, Date.now() - control.lastActivityAt) / 1000);
	return control.currentActivityState === "needs_attention"
		? `no activity for ${seconds}s`
		: `active ${seconds}s ago`;
}
export function foregroundStatusResult(
	control: SubagentState["foregroundControls"] extends Map<string, infer T> ? T : never,
): SubagentToolResult {
	const lines = [
		`Run: ${control.runId}`,
		"State: running",
		`Mode: ${control.mode}`,
		control.currentAgent
			? `Current: ${control.currentAgent}${control.currentIndex !== undefined ? ` step ${control.currentIndex + 1}` : ""}`
			: undefined,
		formatForegroundActivity(control) ? `Activity: ${formatForegroundActivity(control)}` : undefined,
	].filter((line): line is string => Boolean(line));
	return { content: [{ type: "text", text: lines.join("\n") }], details: { mode: "management", results: [] } };
}
function getAsyncInterruptTarget(
	state: SubagentState,
	runId: string | undefined,
): { asyncId: string; asyncDir: string } | undefined {
	if (runId) {
		const direct = state.asyncJobs.get(runId);
		if (direct) return { asyncId: direct.asyncId, asyncDir: direct.asyncDir };
		const registered = readAllEntries().find((entry) => entry.runId === runId);
		if (registered) return { asyncId: registered.runId, asyncDir: registered.runRecordDir };
	}
	let newest: { asyncId: string; asyncDir: string; updatedAt: number } | undefined;
	for (const job of state.asyncJobs.values()) {
		if (job.status !== "running") continue;
		if (!newest || (job.updatedAt ?? 0) > newest.updatedAt) {
			newest = { asyncId: job.asyncId, asyncDir: job.asyncDir, updatedAt: job.updatedAt ?? 0 };
		}
	}
	return newest ? { asyncId: newest.asyncId, asyncDir: newest.asyncDir } : undefined;
}

const DEFAULT_INTERRUPT_WAIT_MS = 10_000;
let interruptWaitMs = DEFAULT_INTERRUPT_WAIT_MS;

/** Test-only override for the synchronous interrupt wait deadline. */
export function __setInterruptWaitMsForTest(ms: number | null): void {
	interruptWaitMs = ms ?? DEFAULT_INTERRUPT_WAIT_MS;
}

interface InterruptWaitTarget {
	runId: string;
	runRecordDir?: string;
	completed?: Promise<ChildAgentResult>;
}

// Wait for an already-aborted run to actually reach a terminal state so the
// tool result can report the final outcome inline. The completion-dedupe key is
// marked BEFORE the wait: a completion landing mid-wait is swallowed by the
// notify dedupe (which still emits notify-delivered, so the async tracker
// clears pendingDelivery and retires the widget row through the normal path).
// The timeout path evicts the keys again so the eventual notification is
// delivered instead — the old fire-and-forget message is the degraded path.
async function settleInterruptedRun(
	state: SubagentState,
	target: InterruptWaitTarget,
	coveredRunIds: string[],
	deadline: number,
): Promise<AwaitRunTerminalOutcome> {
	const newlyMarkedRunIds = coveredRunIds.filter((coveredRunId) => markCompletionDedupeForRunId(coveredRunId));
	const outcome = await awaitRunTerminal(target.runId, {
		deadline,
		...(target.completed ? { completed: target.completed } : {}),
		...(target.runRecordDir ? { runRecordDir: target.runRecordDir } : {}),
	});
	if (!outcome.terminal) {
		// Degraded fire-and-forget path: release only the marks THIS wait created so
		// the eventual completion notification is delivered; marks that pre-existed
		// belong to notifications already sent and must stay deduped.
		for (const coveredRunId of newlyMarkedRunIds) evictCompletionDedupeForRunId(coveredRunId);
		return outcome;
	}
	const tracked = state.asyncJobs.get(target.runId);
	if (tracked) {
		if (
			outcome.state === "complete" ||
			outcome.state === "failed" ||
			outcome.state === "interrupted" ||
			outcome.state === "skipped" ||
			outcome.state === "paused" ||
			outcome.state === "lost"
		) {
			tracked.status = outcome.state;
		}
		tracked.activityState = undefined;
		tracked.updatedAt = Date.now();
	}
	return outcome;
}

function interruptOutcomeText(runId: string, outcome: AwaitRunTerminalOutcome, requestedText: string): string {
	if (!outcome.terminal)
		return `${requestedText} The run is still unwinding; its completion notification will follow.`;
	return outcome.state === "interrupted"
		? `Run ${runId} interrupted.`
		: `Run ${runId} finished with state '${outcome.state}' after the interrupt.`;
}

export async function interruptAllAsyncRuns(
	state: SubagentState,
	childRegistry: ChildAgentRegistry,
): Promise<SubagentToolResult> {
	// Sweep state.asyncJobs (rehydrated from disk after a reload), not just the
	// per-activation childRegistry: a run spawned before a reload has no handle in
	// the fresh registry but its AbortController survives in the shared layer0
	// controller map, so interruptRun still reaches it.
	const targets: InterruptWaitTarget[] = [];
	for (const job of state.asyncJobs.values()) {
		if (job.status !== "running" && job.status !== "queued") continue;
		try {
			const handle = childRegistry.get(job.asyncId);
			let aborted: boolean;
			if (handle) {
				await childRegistry.abortRun(job.asyncId, "interrupt-all requested");
				aborted = true;
			} else {
				aborted = interruptRun(job.asyncId, { cascade: true }).interruptedRunIds.length > 0;
			}
			if (!aborted) continue;
			targets.push({
				runId: job.asyncId,
				runRecordDir: job.asyncDir,
				...(handle ? { completed: handle.completed } : {}),
			});
			job.activityState = undefined;
			job.updatedAt = Date.now();
		} catch {
			// best-effort: continue aborting remaining runs
		}
	}
	if (targets.length === 0) {
		return {
			content: [{ type: "text", text: "No running runs to interrupt." }],
			details: { mode: "management", results: [] },
		};
	}
	// One shared deadline across all aborted runs; report per-run final states.
	const deadline = Date.now() + interruptWaitMs;
	const settled = await Promise.allSettled(
		targets.map((target) => settleInterruptedRun(state, target, [target.runId], deadline)),
	);
	const outcomes = settled.map(
		(entry): AwaitRunTerminalOutcome => (entry.status === "fulfilled" ? entry.value : { terminal: false }),
	);
	const lines = targets.map((target, index) => {
		const outcome = outcomes[index]!;
		return `- ${target.runId}: ${outcome.terminal ? outcome.state : "still unwinding"}`;
	});
	const allTerminal = outcomes.every((outcome) => outcome.terminal);
	const headline = allTerminal
		? `Interrupted ${targets.length} run(s):`
		: `Interrupt requested for ${targets.length} run(s); some are still unwinding (their completion notifications will follow):`;
	return {
		content: [{ type: "text", text: [headline, ...lines].join("\n") }],
		details: { mode: "management", results: [] },
	};
}
export async function interruptAsyncRun(
	state: SubagentState,
	childRegistry: ChildAgentRegistry,
	runId: string | undefined,
	requestingRootSessionId?: string,
): Promise<SubagentToolResult | null> {
	if (runId && !state.asyncJobs.has(runId)) {
		const entry = readAllEntries().find((candidate) => candidate.runId === runId);
		const recordedRootSessionId = entry?.rootSessionId ?? entry?.parentSessionId;
		if (recordedRootSessionId && recordedRootSessionId !== requestingRootSessionId) {
			return {
				content: [
					{
						type: "text",
						text: `Run ${runId} belongs to root session ${recordedRootSessionId}, not the current root session ${requestingRootSessionId ?? "unavailable"}. Interrupt it from its owning root session.`,
					},
				],
				isError: true,
				details: { mode: "management", results: [] },
			};
		}
	}
	const target = getAsyncInterruptTarget(state, runId);
	if (!target) return null;
	const handle = childRegistry.get(target.asyncId);
	try {
		let abortedRunIds: string[];
		if (handle) {
			void handle.abort("interrupt requested");
			abortedRunIds = [target.asyncId];
		} else {
			const cascade = interruptRun(target.asyncId, { cascade: true });
			// interruptRun already aborted every controller it found in the shared
			// layer0 map (the target included). Additionally fire the per-activation
			// registry controllers for registry-resident descendants.
			for (const abortedRunId of cascade.interruptedRunIds) {
				if (abortedRunId !== target.asyncId && childRegistry.get(abortedRunId)) {
					void childRegistry.abortRun(abortedRunId, "interrupt requested");
				}
			}
			// Success is "anything was aborted anywhere": the target aborted via the
			// shared layer0 map counts even with zero registry-resident descendants
			// (the post-reload case — the registry is empty but the map survives).
			if (cascade.interruptedRunIds.length === 0) {
				return {
					content: [
						{ type: "text", text: `No running in-process run was found for '${runId ?? "current"}'.` },
					],
					isError: true,
					details: { mode: "management", results: [] },
				};
			}
			abortedRunIds = cascade.interruptedRunIds;
		}
		// Clear tracked activity for every aborted run (target included).
		for (const abortedRunId of abortedRunIds) {
			const tracked = state.asyncJobs.get(abortedRunId);
			if (tracked) {
				tracked.activityState = undefined;
				tracked.updatedAt = Date.now();
			}
		}
		const descendantRunIds = abortedRunIds.filter((id) => id !== target.asyncId);
		const requestedText =
			descendantRunIds.length > 0
				? `Interrupt requested for run ${target.asyncId} (${descendantRunIds.length} descendant run(s): ${descendantRunIds.join(", ")}).`
				: `Interrupt requested for run ${target.asyncId}.`;
		const outcome = await settleInterruptedRun(
			state,
			{
				runId: target.asyncId,
				runRecordDir: target.asyncDir,
				...(handle ? { completed: handle.completed } : {}),
			},
			abortedRunIds,
			Date.now() + interruptWaitMs,
		);
		return {
			content: [{ type: "text", text: interruptOutcomeText(target.asyncId, outcome, requestedText) }],
			details: { mode: "management", results: [] },
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			content: [{ type: "text", text: `Failed to interrupt run ${target.asyncId}: ${message}` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
}
