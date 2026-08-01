import type { WorkflowMeta } from "../protocol/workflow-meta.ts";
import { canonicalWorkflowPhaseTitle } from "../shared/workflow-phase-title.ts";

export function workflowDisplayName(meta: WorkflowMeta | undefined): string {
	return meta?.name ?? "workflow";
}

export type WorkflowPhasePlanState = "completed" | "current" | "upcoming" | "unreached";

export function shapeWorkflowPhasePlan(
	meta: WorkflowMeta,
	reachedTitles: string[],
	workflowRunning: boolean,
	currentTitle?: string,
): Array<{ title: string; detail?: string; state: WorkflowPhasePlanState }> {
	const reached = new Set(reachedTitles.map(canonicalWorkflowPhaseTitle));
	const latestReached = [...reachedTitles]
		.reverse()
		.map(canonicalWorkflowPhaseTitle)
		.find((title) => meta.phases.some((phase) => canonicalWorkflowPhaseTitle(phase.title) === title));
	const canonicalCurrent = currentTitle === undefined ? undefined : canonicalWorkflowPhaseTitle(currentTitle);
	const current =
		currentTitle === undefined
			? latestReached
			: meta.phases.some((phase) => canonicalWorkflowPhaseTitle(phase.title) === canonicalCurrent)
				? canonicalCurrent
				: undefined;
	const currentIndex = current
		? meta.phases.findIndex((phase) => canonicalWorkflowPhaseTitle(phase.title) === current)
		: -1;
	return meta.phases.map((phase, index) => {
		const title = canonicalWorkflowPhaseTitle(phase.title);
		let state: WorkflowPhasePlanState;
		if (workflowRunning && title === current) state = "current";
		else if (reached.has(title) || (!workflowRunning && title === current)) state = "completed";
		else if (!workflowRunning || index < currentIndex) state = "unreached";
		else state = "upcoming";
		return { ...phase, title, state };
	});
}

export function formatWorkflowPhase(
	meta: WorkflowMeta | undefined,
	runtimeIndex: number | undefined,
	title: string | undefined,
): string | undefined {
	if (!title) return undefined;
	const canonicalTitle = canonicalWorkflowPhaseTitle(title);
	const declaredIndex =
		meta?.phases.findIndex((phase) => canonicalWorkflowPhaseTitle(phase.title) === canonicalTitle) ?? -1;
	if (meta && declaredIndex >= 0) return `Phase ${declaredIndex + 1}/${meta.phases.length}: ${canonicalTitle}`;
	return runtimeIndex === undefined ? canonicalTitle : `Phase ${runtimeIndex}: ${canonicalTitle}`;
}
