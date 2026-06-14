/**
 * Run-source adapter for the subagent dashboard. Turns the two raw data
 * sources — the on-disk overlay (async/registry runs) and the in-memory
 * foreground runs — into the single sorted, session-scoped `LiveRun[]` the
 * dashboard renders. Pure derivation: the component owns fetching, refresh
 * scheduling, error handling, and selection reconciliation.
 */

import type { AsyncRunOverlayData } from "../state/async-status.ts";
import { filterRunsToSessionTree, sortLiveRuns } from "./dashboard-row-model.ts";
import type { ForegroundRunSummary, LiveRun } from "./subagents-status.ts";

export interface RunSourceScope {
	showAllSessions: boolean;
	sessionId?: string;
	sessionCwd?: string;
	branchAnchorIds?: Set<string>;
	/** Run ids this process owns in memory (registry mirror); owned async runs
	 * resolve as ownership:'live'. Empty/absent after a reload => all foreign. */
	ownedIds?: ReadonlySet<string>;
}

export function deriveLiveRuns(overlay: AsyncRunOverlayData, sync: ForegroundRunSummary[], scope: RunSourceScope): LiveRun[] {
	const syncIds = new Set(sync.map((run) => run.id));
	// charter nested-subagent-display: prefer in-memory sync rows while disk mirrors exist.
	const combined = [...overlay.active, ...overlay.recent].filter((run) => !syncIds.has(run.id));
	let runs = sortLiveRuns(sync, combined, scope.ownedIds);
	if (!scope.showAllSessions && (scope.sessionId || scope.sessionCwd)) {
		runs = filterRunsToSessionTree(runs, { sessionId: scope.sessionId, sessionCwd: scope.sessionCwd }, scope.branchAnchorIds);
	}
	return runs;
}
