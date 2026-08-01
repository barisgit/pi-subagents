// Pure dashboard row-derivation model. Given the already-fetched live runs plus
// UI state (collapsed container ids, session scope, branch anchors), it derives
// the ordered display rows and the per-row metadata the left pane renders:
// container enrichment, pending-delivery flags, the header agent count, and the
// session/sort transforms that run before row emission.
//
// This module is a PURE transform: no paneOverlay imports, no key input, and no
// disk IO. The component owns fetching the raw LiveRun[] (reading the registry /
// async-status from disk, foreground sync runs, sync-vs-disk dedupe) and then
// delegates the filter/sort/display-row derivation here.
import { compareRunsForDisplay } from "../state/run-liveness.ts";
import { formatWorkflowPhase, shapeWorkflowPhasePlan, type WorkflowPhasePlanState } from "../state/workflow-display.ts";
import type { AsyncRunSummary } from "../state/async-status.ts";
import type { LiveRun } from "../state/run-view.ts";
import { canonicalWorkflowPhaseTitle } from "../shared/workflow-phase-title.ts";
import type { ForegroundRunSummary } from "./subagents-status.ts";

/** Extra rendering context for a group-container row (parallel group, workflow
 * group): collapse marker, child progress, current phase synthesized from the
 * children, and the collapsed-state inline agent summary. */
export interface ContainerRowInfo {
	collapsed: boolean;
	done: number;
	total: number;
	phaseChip?: string;
	agentsSummary?: string;
}

export type DisplayRow =
	| { kind: "run"; run: LiveRun; depth: number; parallelMarker?: boolean; suppressPhaseChip?: boolean }
	| {
			kind: "pipelineItem";
			id: string;
			workflowId: string;
			pipelineId: string;
			itemIndex: number;
			label?: string;
			depth: number;
			done: number;
			total: number;
			running: boolean;
			collapsed: boolean;
	  }
	| {
			kind: "phase";
			id: string;
			workflowId: string;
			phaseIndex: number;
			title?: string;
			depth: number;
			done: number;
			total: number;
			running: boolean;
			collapsed: boolean;
			expandable: boolean;
			planState?: WorkflowPhasePlanState;
	  };

export function parentRunIdOf(run: LiveRun): string | undefined {
	return run.run.parentRunId;
}

// Decides whether a run row directly belongs to the current session. Sync runs
// always belong to the current session (they share the in-process cwd). Async
// rows are direct matches only when their own session/cwd metadata matches; the
// overlay separately keeps descendants of matching rows so nested runs with
// stale lineage still render under their visible parent.
function runMatchesSession(
	run: LiveRun,
	scope: { sessionId?: string; sessionCwd?: string } | string | undefined,
): boolean {
	// Back-compat: previously the second arg was just sessionCwd as a string.
	const { sessionId, sessionCwd } =
		typeof scope === "string" ? { sessionId: undefined, sessionCwd: scope } : (scope ?? {});
	if (!sessionId && !sessionCwd) return true;
	if (run.ownership === "live") return true;
	if (sessionId) {
		const tag = run.run.rootSessionId ?? run.run.parentSessionId;
		if (!tag) return false;
		return tag === sessionId;
	}
	const runCwd = run.run.cwd;
	if (!runCwd) return false;
	return runCwd === sessionCwd;
}

export function filterRunsToSessionTree(
	runs: LiveRun[],
	scope: { sessionId?: string; sessionCwd?: string },
	anchorRunIds?: Set<string>,
): LiveRun[] {
	if (!scope.sessionId && !scope.sessionCwd) return runs;
	const present = new Set(runs.map((run) => run.run.id));
	const byParent = new Map<string, LiveRun[]>();
	for (const run of runs) {
		const parentRunId = parentRunIdOf(run);
		if (!parentRunId) continue;
		const siblings = byParent.get(parentRunId) ?? [];
		siblings.push(run);
		byParent.set(parentRunId, siblings);
	}

	// A forest-root is a top-level row in the overlay tree: no parentRunId, or a
	// parent that is not itself present in the filtered set. Branch-aware
	// membership is decided ONLY at forest-roots; descendants of an included
	// root always flow in (a nested child is never independently anchored).
	const isForestRoot = (run: LiveRun): boolean => {
		const parentRunId = parentRunIdOf(run);
		return !parentRunId || !present.has(parentRunId);
	};

	const included = new Set<string>();
	const includeWithDescendants = (run: LiveRun): void => {
		if (included.has(run.run.id)) return;
		included.add(run.run.id);
		for (const child of byParent.get(run.run.id) ?? []) includeWithDescendants(child);
	};
	for (const run of runs) {
		if (!isForestRoot(run)) continue;
		if (!runMatchesSession(run, scope)) continue;
		// Tree-aware membership: when an anchor set is supplied, a top-level run is
		// a member only if its branch anchor is on the CURRENT message-tree branch
		// (a /tree revert drops abandoned-branch anchors). When no anchor set is
		// supplied (tests, or before anchors exist), fall back to session match.
		if (anchorRunIds && !anchorRunIds.has(run.run.id)) continue;
		includeWithDescendants(run);
	}
	return runs.filter((run) => included.has(run.run.id));
}

function baseSortLiveRuns(runs: LiveRun[]): LiveRun[] {
	return [...runs].sort((a, b) =>
		compareRunsForDisplay({ ...a.run, updatedAt: a.run.lastUpdate }, { ...b.run, updatedAt: b.run.lastUpdate }),
	);
}

function orderRunsWithChildren(sorted: LiveRun[]): LiveRun[] {
	// charter nested-subagent-display: parent rows immediately precede visible children.
	const byParent = new Map<string, LiveRun[]>();
	const ids = new Set(sorted.map((run) => run.run.id));
	const roots: LiveRun[] = [];
	for (const run of sorted) {
		const parentRunId = parentRunIdOf(run);
		if (parentRunId && ids.has(parentRunId)) {
			const children = byParent.get(parentRunId) ?? [];
			children.push(run);
			byParent.set(parentRunId, children);
		} else {
			roots.push(run);
		}
	}
	const childrenForDisplay = (parent: LiveRun, children: LiveRun[]): LiveRun[] => {
		// workflow is a disk-only field (foreground views never set it), so the
		// field read selects foreign workflow parents directly.
		if (!parent.run.workflow) return children;
		return children
			.map((child, index) => ({ child, index }))
			.sort((a, b) => {
				// phaseIndex/parallelGroupId are undefined on foreground views, so
				// ?? 0 / ?? "" reproduce the old live-arm defaults without a branch.
				const phaseA = a.child.run.phaseIndex ?? 0;
				const phaseB = b.child.run.phaseIndex ?? 0;
				if (phaseA !== phaseB) return phaseA - phaseB;
				const itemA = a.child.run.pipeline?.itemIndex ?? -1;
				const itemB = b.child.run.pipeline?.itemIndex ?? -1;
				if (itemA !== itemB) return itemA - itemB;
				const stageA = a.child.run.pipeline?.stageIndex ?? -1;
				const stageB = b.child.run.pipeline?.stageIndex ?? -1;
				if (stageA !== stageB) return stageA - stageB;
				const groupA = a.child.run.parallelGroupId ?? "";
				const groupB = b.child.run.parallelGroupId ?? "";
				if (groupA !== groupB) return groupA.localeCompare(groupB);
				return a.index - b.index;
			})
			.map(({ child }) => child);
	};
	const out: LiveRun[] = [];
	const visit = (run: LiveRun) => {
		out.push(run);
		for (const child of childrenForDisplay(run, byParent.get(run.run.id) ?? [])) visit(child);
	};
	for (const run of roots) visit(run);
	return out;
}

function buildDepthMap(runs: LiveRun[]): Map<string, number> {
	const ids = new Set(runs.map((run) => run.run.id));
	const byId = new Map(runs.map((run) => [run.run.id, run] as const));
	const depths = new Map<string, number>();
	const depthFor = (run: LiveRun, seen = new Set<string>()): number => {
		const cached = depths.get(run.run.id);
		if (cached !== undefined) return cached;
		const parent = parentRunIdOf(run);
		if (!parent || !ids.has(parent) || seen.has(parent)) {
			depths.set(run.run.id, 0);
			return 0;
		}
		seen.add(run.run.id);
		const parentRun = byId.get(parent);
		const depth = parentRun ? Math.min(4, depthFor(parentRun, seen) + 1) : 0;
		depths.set(run.run.id, depth);
		return depth;
	};
	for (const run of runs) depthFor(run);
	return depths;
}

export function sortLiveRuns(
	sync: ForegroundRunSummary[],
	async: AsyncRunSummary[],
	ownedIds?: ReadonlySet<string>,
): LiveRun[] {
	// Single ordering rule for the dashboard: needs_attention pinned to the very top,
	// then everything strictly by spawn time (newest first). State buckets are NOT
	// used here -- otherwise old failed runs would float above recently completed
	// runs just because 'failed' bucket ranks above 'complete'. The status glyph on
	// each row already communicates state, so bucketing only hurt the mental model.
	//
	// Provenance assignment: foreground runs are always live (in-process). Async
	// overlay runs are live ONLY when this process owns them (the registry memory
	// mirror still holds the run); after a reload the registry is empty so every
	// async run resolves as foreign (disk-hydrated) = today's behavior.
	const all: LiveRun[] = [];
	for (const run of sync) all.push({ ownership: "live", run });
	for (const run of async) all.push({ ownership: ownedIds?.has(run.id) ? "live" : "foreign", run });
	return orderRunsWithChildren(baseSortLiveRuns(all));
}

function phaseRowDone(run: LiveRun): boolean {
	const state = run.run.state;
	return state === "complete" || state === "failed" || state === "interrupted" || state === "skipped";
}

function isSkippedParallelContainer(runs: LiveRun[], run: LiveRun): boolean {
	// Container detection is structural (has child rows + group shape), NOT
	// provenance: an owned-async parallel group (now ownership:'live') is just as
	// much a container as a foreign disk one.
	if (run.run.workflow === true || run.run.mode !== "parallel") return false;
	return runs.some((other) => other.run.parentRunId === run.run.id);
}

export function isGroupContainerRow(runs: LiveRun[], run: LiveRun): boolean {
	// A container is a run that has child rows AND a group shape (workflow or
	// parallel) — detected by STRUCTURE, not provenance, so owned-async groups nest
	// their children identically to foreign disk groups.
	const hasChildRows = runs.some((other) => other.run.parentRunId === run.run.id);
	if (!hasChildRows) return false;
	return run.run.workflow === true || run.run.mode === "parallel";
}

/** Count of actual agent runs for the header label. A parallel/workflow GROUP
 * is a container, not an agent: when its leaf children are present as their own
 * rows, the container row itself must not be tallied (otherwise a 2-agent
 * parallel fan-out reads as "3 total"). A real agent that happens to have spawned
 * sub-agents (mode "single" with children) is still a genuine agent and counts. */
export function countAgentRows(runs: LiveRun[]): number {
	return runs.reduce((sum, run) => sum + (isGroupContainerRow(runs, run) ? 0 : 1), 0);
}

/** Synthesize the container-row enrichment (collapse marker, done/total child
 * progress, current phase, collapsed agent summary) from the children. */
export function containerRowInfo(
	runs: LiveRun[],
	collapsedIds: ReadonlySet<string>,
	run: LiveRun,
): ContainerRowInfo | undefined {
	if (!isGroupContainerRow(runs, run)) return undefined;
	const children = runs.filter((other) => other.run.parentRunId === run.run.id);
	const done = children.filter((child) => {
		const s = child.run.state;
		return s === "complete" || s === "failed" || s === "interrupted" || s === "skipped";
	}).length;
	// Current phase comes from the durable group marker, with latest child as a
	// compatibility fallback for records written before phase persistence.
	let phaseChip: string | undefined;
	if (run.run.workflow === true) {
		let phaseIndex = run.run.phaseIndex;
		let phaseTitle = run.run.phaseTitle ? canonicalWorkflowPhaseTitle(run.run.phaseTitle) : undefined;
		if (phaseIndex === undefined) {
			let best: { index: number; title?: string } | undefined;
			for (const child of children) {
				if (child.run.phaseIndex === undefined) continue;
				if (!best || child.run.phaseIndex > best.index) {
					best = {
						index: child.run.phaseIndex,
						...(child.run.phaseTitle !== undefined ? { title: child.run.phaseTitle } : {}),
					};
				}
			}
			phaseIndex = best?.index;
			phaseTitle = best?.title ? canonicalWorkflowPhaseTitle(best.title) : undefined;
		}
		if (phaseIndex !== undefined && run.run.state === "running") {
			phaseChip = formatWorkflowPhase(run.run.workflowMeta, phaseIndex, phaseTitle) ?? `Phase ${phaseIndex}`;
		}
	}
	const collapsed = collapsedIds.has(run.run.id);
	let agentsSummary: string | undefined;
	if (collapsed) {
		// Field priority preserved: currentAgent (live-only) wins, else first
		// step's agent (foreign), else mode. Live views carry steps:[] and foreign
		// views carry no currentAgent, so the unified read matches both old arms.
		const agents = children.map(
			(child) => child.run.currentAgent ?? child.run.steps.find((step) => step.agent)?.agent ?? child.run.mode,
		);
		const unique = Array.from(new Set(agents.filter(Boolean)));
		agentsSummary = `${children.length} ${children.length === 1 ? "agent" : "agents"}${unique.length > 0 ? `: ${unique.join(", ")}` : ""}`;
	}
	return {
		collapsed,
		done,
		total: children.length,
		...(phaseChip !== undefined ? { phaseChip } : {}),
		...(agentsSummary !== undefined ? { agentsSummary } : {}),
	};
}

/** A parallel-group child that finished while its group is still open has a
 * result not yet delivered to the parent turn (rollup batching). Workflow
 * children are excluded: the script consumes results as they complete. */
export function isPendingDelivery(runs: LiveRun[], run: LiveRun): boolean {
	if (run.run.state !== "complete" || !run.run.parentRunId) return false;
	const parent = runs.find((other) => other.run.id === run.run.parentRunId);
	// Pending-delivery is a structural property of the parent group, not its
	// provenance: an owned-async parallel parent batches child results too.
	if (!parent) return false;
	if (parent.run.workflow === true) return false;
	if (parent.run.mode !== "parallel") return false;
	const s = parent.run.state;
	return s === "running" || s === "queued";
}

export function deriveDisplayRows(runs: LiveRun[], collapsedIds: ReadonlySet<string>): DisplayRow[] {
	const skippedParallelIds = new Set(
		runs.filter((run) => isSkippedParallelContainer(runs, run)).map((run) => run.run.id),
	);
	const displayRuns = runs.filter((run) => !skippedParallelIds.has(run.run.id));
	const depthMap = buildDepthMap(displayRuns);
	const ids = new Set(runs.map((run) => run.run.id));
	const childrenByParent = new Map<string, LiveRun[]>();
	for (const run of runs) {
		const parentId = run.run.parentRunId;
		if (!parentId || !ids.has(parentId)) continue;
		const children = childrenByParent.get(parentId) ?? [];
		children.push(run);
		childrenByParent.set(parentId, children);
	}

	const rows: DisplayRow[] = [];
	const processed = new Set<string>();
	const emitRun = (
		run: LiveRun,
		depth: number,
		options: { parallelMarker?: boolean; suppressPhaseChip?: boolean } = {},
	) => {
		processed.add(run.run.id);
		rows.push({ kind: "run", run, depth, ...options });
	};
	const emitWorkflowChildren = (workflow: LiveRun, depth: number) => {
		if (collapsedIds.has(workflow.run.id)) return;
		const children = childrenByParent.get(workflow.run.id) ?? [];
		// phaseIndex is undefined on foreground views, so field-presence alone
		// partitions phaseless vs phased children identically to the old guard.
		const phaseless = children.filter((child) => child.run.phaseIndex === undefined);
		for (const child of phaseless) emitTree(child, depth + 1);

		const phaseIndexes = Array.from(
			new Set(
				children.filter((child) => child.run.phaseIndex !== undefined).map((child) => child.run.phaseIndex!),
			),
		).sort((a, b) => a - b);
		const runtimePhases = phaseIndexes.map((phaseIndex) => {
			const phaseChildren = children.filter((child) => child.run.phaseIndex === phaseIndex);
			const rawTitle = phaseChildren.find((child) => child.run.phaseTitle)?.run.phaseTitle;
			const title = rawTitle ? canonicalWorkflowPhaseTitle(rawTitle) : undefined;
			return { phaseIndex, phaseChildren, title };
		});
		const emitPhase = (
			phaseIndex: number,
			title: string | undefined,
			phaseChildren: LiveRun[],
			phaseId: string,
			planState?: WorkflowPhasePlanState,
		) => {
			const parallelGroups = new Set(
				phaseChildren.map((child) => child.run.parallelGroupId).filter((id): id is string => Boolean(id)),
			);
			const expandable = phaseChildren.length > 0;
			rows.push({
				kind: "phase",
				id: phaseId,
				workflowId: workflow.run.id,
				phaseIndex,
				...(title !== undefined ? { title } : {}),
				depth: depth + 1,
				done: phaseChildren.filter(phaseRowDone).length,
				total: phaseChildren.length,
				running:
					planState === "current" ||
					phaseChildren.some((child) => child.run.state === "running" || child.run.state === "queued"),
				collapsed: expandable && collapsedIds.has(phaseId),
				expandable,
				...(planState ? { planState } : {}),
			});
			if (!expandable || collapsedIds.has(phaseId)) return;
			const pipelineChildren = phaseChildren.filter((child) => child.run.pipeline);
			const pipelineKeys = Array.from(
				new Set(pipelineChildren.map((child) => `${child.run.pipeline!.id}:${child.run.pipeline!.itemIndex}`)),
			).sort((a, b) => {
				const [, itemA = "0"] = a.split(":");
				const [, itemB = "0"] = b.split(":");
				return Number(itemA) - Number(itemB);
			});
			const emittedPipelineIds = new Set<string>();
			for (const key of pipelineKeys) {
				const itemChildren = pipelineChildren
					.filter((child) => `${child.run.pipeline!.id}:${child.run.pipeline!.itemIndex}` === key)
					.sort((a, b) => (a.run.pipeline?.stageIndex ?? 0) - (b.run.pipeline?.stageIndex ?? 0));
				const first = itemChildren[0];
				if (!first?.run.pipeline) continue;
				const itemId = `pipeline:${workflow.run.id}:${first.run.pipeline.id}:${first.run.pipeline.itemIndex}`;
				rows.push({
					kind: "pipelineItem",
					id: itemId,
					workflowId: workflow.run.id,
					pipelineId: first.run.pipeline.id,
					itemIndex: first.run.pipeline.itemIndex,
					...(first.run.pipeline.itemLabel ? { label: first.run.pipeline.itemLabel } : {}),
					depth: depth + 2,
					done: itemChildren.filter(phaseRowDone).length,
					total: itemChildren.length,
					running: itemChildren.some(
						(child) => child.run.state === "running" || child.run.state === "queued",
					),
					collapsed: collapsedIds.has(itemId),
				});
				if (!collapsedIds.has(itemId)) {
					for (const child of itemChildren) emitTree(child, depth + 3, { suppressPhaseChip: true });
				}
				for (const child of itemChildren) emittedPipelineIds.add(child.run.id);
			}
			for (const child of phaseChildren) {
				if (emittedPipelineIds.has(child.run.id)) continue;
				emitTree(child, depth + 2, {
					suppressPhaseChip: true,
					parallelMarker:
						child.run.parallelGroupId !== undefined && parallelGroups.has(child.run.parallelGroupId),
				});
			}
		};
		const workflowMeta = workflow.run.workflowMeta;
		if (!workflowMeta) {
			for (const runtime of runtimePhases) {
				emitPhase(
					runtime.phaseIndex,
					runtime.title,
					runtime.phaseChildren,
					`phase:${workflow.run.id}:${runtime.phaseIndex}`,
				);
			}
			return;
		}

		const reachedTitles = [
			...(workflow.run.reachedPhaseTitles ?? []),
			...runtimePhases.map((runtime) => runtime.title).filter((title): title is string => title !== undefined),
		];
		const plan = shapeWorkflowPhasePlan(
			workflowMeta,
			reachedTitles,
			workflow.run.state === "running" || workflow.run.state === "queued",
			workflow.run.phaseTitle ? canonicalWorkflowPhaseTitle(workflow.run.phaseTitle) : undefined,
		);
		const matchedRuntimeIndexes = new Set<number>();
		for (const [declaredIndex, phase] of plan.entries()) {
			const matches = runtimePhases.filter((runtime) => runtime.title === phase.title);
			for (const match of matches) matchedRuntimeIndexes.add(match.phaseIndex);
			emitPhase(
				declaredIndex + 1,
				phase.title,
				matches.flatMap((match) => match.phaseChildren),
				`phase-plan:${workflow.run.id}:${declaredIndex}`,
				phase.state,
			);
		}
		for (const runtime of runtimePhases) {
			if (matchedRuntimeIndexes.has(runtime.phaseIndex)) continue;
			emitPhase(
				runtime.phaseIndex,
				runtime.title,
				runtime.phaseChildren,
				`phase:${workflow.run.id}:${runtime.phaseIndex}`,
			);
		}
	};
	const emitTree = (
		run: LiveRun,
		depth: number,
		options: { parallelMarker?: boolean; suppressPhaseChip?: boolean } = {},
	) => {
		if (processed.has(run.run.id)) return;
		if (skippedParallelIds.has(run.run.id)) {
			processed.add(run.run.id);
			for (const child of childrenByParent.get(run.run.id) ?? [])
				emitTree(child, depth, { parallelMarker: true });
			return;
		}
		emitRun(run, depth, options);
		if (run.run.workflow === true) {
			emitWorkflowChildren(run, depth);
			return;
		}
		for (const child of childrenByParent.get(run.run.id) ?? []) emitTree(child, depth + 1);
	};

	for (const run of runs) {
		const parentId = run.run.parentRunId;
		const hasKnownParent = parentId !== undefined && ids.has(parentId);
		if (hasKnownParent) continue;
		const depth = depthMap.get(run.run.id) ?? 0;
		emitTree(run, depth);
	}
	return rows;
}
