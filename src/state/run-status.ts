import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { ASYNC_NO_POLL_GUIDANCE } from "../shared/formatting.ts";
import { formatAsyncRunList, listRunsFromRegistry, readRunViewForEntry } from "./async-status.ts";
import { readAllEntries, type RunsRegistryEntry } from "./runs-registry.ts";
import type { Details } from "../protocol/types.ts";
import { readStatus } from "../shared/utils.ts";

export interface RunStatusParams {
	action?: string;
	id?: string;
	runId?: string;
	dir?: string;
	// Scope for the no-id list mode. When set, the returned list is filtered to
	// runs belonging to the current session's tree (rootSessionId/parentSessionId)
	// or, as a fallback, the current cwd. Without these, every entry in
	// runs-index.jsonl across every project ever spawned would be returned —
	// including thousands of long-dead test temp-dir runs that synthesize a
	// fake `queued` summary because their status.json no longer exists.
	sessionId?: string;
	sessionCwd?: string;
	includeCompleted?: boolean;
}

// Default cap on the no-id list. Even after scoping, the registry can carry
// hundreds of entries from one long-running session; the agent rarely needs
// more than the freshest handful to understand what's still running.
const DEFAULT_LIST_LIMIT = 30;

function activityText(activityState: unknown, lastActivityAt: unknown): string | undefined {
	if (typeof lastActivityAt !== "number") return undefined;
	const seconds = Math.floor(Math.max(0, Date.now() - lastActivityAt) / 1000);
	return activityState === "needs_attention" ? `no activity for ${seconds}s` : `active ${seconds}s ago`;
}

// Mirrors the scoping rule used by listRunsFromRegistryForOverlay: sessionId
// is the strict match (rootSessionId/parentSessionId), sessionCwd is the looser
// project fallback. Entries with unknown lineage are kept permissively so
// legacy/in-flight rows don't silently vanish.
function scopeRunsForSession<T extends { rootSessionId?: string; parentSessionId?: string; cwd?: string }>(
	runs: T[],
	scope: { sessionId?: string; sessionCwd?: string },
): T[] {
	if (scope.sessionId) {
		const sid = scope.sessionId;
		return runs.filter((run) => {
			const tag = run.rootSessionId ?? run.parentSessionId;
			return !tag || tag === sid;
		});
	}
	if (scope.sessionCwd) {
		const cwd = scope.sessionCwd;
		return runs.filter((run) => !run.cwd || run.cwd === cwd);
	}
	return runs;
}

export function inspectSubagentStatus(params: RunStatusParams): AgentToolResult<Details> {
	if (!params.id && !params.runId && !params.dir) {
		try {
			const states =
				params.includeCompleted === false
					? (["queued", "running", "lost"] as const)
					: (["queued", "running", "lost", "complete", "failed", "paused"] as const);
			const all = listRunsFromRegistry({ states: [...states] });
			const scoped = scopeRunsForSession(all, { sessionId: params.sessionId, sessionCwd: params.sessionCwd });
			const runs = scoped
				.sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt))
				.slice(0, DEFAULT_LIST_LIMIT);
			return {
				content: [{ type: "text", text: formatAsyncRunList(runs) }],
				details: { mode: "single", results: [] },
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				content: [{ type: "text", text: message }],
				isError: true,
				details: { mode: "single", results: [] },
			};
		}
	}

	let asyncDir: string | null = null;
	let resolvedId = params.id ?? params.runId;
	let registryMatch: RunsRegistryEntry | undefined;
	let registryEntries: RunsRegistryEntry[] | undefined;

	if (params.dir) {
		asyncDir = path.resolve(params.dir);
	} else if (resolvedId) {
		registryEntries = readAllEntries();
		registryMatch = registryEntries.find((entry) => entry.runId.startsWith(resolvedId!));
		if (registryMatch) {
			asyncDir = registryMatch.runRecordDir;
			resolvedId = registryMatch.runId;
		}
	}

	if (!asyncDir) {
		return {
			content: [{ type: "text", text: "Run not found. Provide id or dir." }],
			isError: true,
			details: { mode: "single", results: [] },
		};
	}

	if (asyncDir) {
		let status: ReturnType<typeof readStatus>;
		try {
			status = readStatus(asyncDir);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				content: [{ type: "text", text: message }],
				isError: true,
				details: { mode: "single", results: [] },
			};
		}
		const logPath = path.join(asyncDir, `subagent-log-${resolvedId ?? "unknown"}.md`);
		const sessionPath = path.join(asyncDir, "run-0", "session.jsonl");
		if (status) {
			const stepsTotal = status.steps?.length ?? 1;
			const completedParallelSteps =
				status.steps?.filter(
					(step) => step.status === "complete" || step.status === "failed" || step.status === "skipped",
				).length ?? 0;
			const current = status.currentStep !== undefined ? status.currentStep + 1 : undefined;
			const stepLine =
				status.mode === "parallel"
					? `Progress: ${completedParallelSteps}/${stepsTotal} tasks complete`
					: current !== undefined
						? `Step: ${current}/${stepsTotal}`
						: `Steps: ${stepsTotal}`;
			const started = new Date(status.startedAt).toISOString();
			const updated = status.lastUpdate ? new Date(status.lastUpdate).toISOString() : "n/a";
			const statusActivityText =
				status.state === "running" ? activityText(status.activityState, status.lastActivityAt) : undefined;

			const lines = [
				`Run: ${status.runId}`,
				`State: ${status.state}`,
				statusActivityText ? `Activity: ${statusActivityText}` : undefined,
				`Mode: ${status.mode}`,
				stepLine,
				`Started: ${started}`,
				`Updated: ${updated}`,
				`Dir: ${asyncDir}`,
			].filter((line): line is string => Boolean(line));
			for (const [index, step] of (status.steps ?? []).entries()) {
				const stepActivityText =
					step.status === "running" ? activityText(step.activityState, step.lastActivityAt) : undefined;
				lines.push(
					`Step ${index + 1}: ${step.agent} ${step.status}${stepActivityText ? `, ${stepActivityText}` : ""}`,
				);
			}
			if (status.sessionFile) lines.push(`Session: ${status.sessionFile}`);
			else if (fs.existsSync(sessionPath)) lines.push(`Session: ${sessionPath}`);
			if (fs.existsSync(logPath)) lines.push(`Log: ${logPath}`);
			if (status.state === "running" || status.state === "queued" || status.state === "lost")
				lines.push("", ASYNC_NO_POLL_GUIDANCE);

			return { content: [{ type: "text", text: lines.join("\n") }], details: { mode: "single", results: [] } };
		}
	}

	// Group containers (parallel groups, workflows) have no status.json of their
	// own; their state is synthesized from children. Fall back to the registry
	// summary so `status id=<group>` works instead of "Status file not found."
	if (registryMatch && registryEntries) {
		const summary = readRunViewForEntry(registryMatch, registryEntries);
		if (summary) {
			const children = registryEntries.filter((entry) => entry.parentRunId === registryMatch!.runId);
			const lines = [
				`Run: ${summary.id}`,
				`State: ${summary.state}`,
				`Mode: ${summary.mode}${registryMatch.kind === "workflow" ? " (workflow)" : ""}`,
				summary.label ? `Label: ${summary.label}` : undefined,
				`Started: ${new Date(summary.startedAt).toISOString()}`,
				summary.endedAt !== undefined ? `Ended: ${new Date(summary.endedAt).toISOString()}` : undefined,
				`Dir: ${asyncDir ?? registryMatch.runRecordDir}`,
			].filter((line): line is string => Boolean(line));
			for (const child of children) {
				const childSummary = readRunViewForEntry(child, registryEntries);
				const agent = child.agentName ?? child.agentNames?.join("+") ?? "(group)";
				lines.push(
					`Child: ${child.runId.slice(0, 8)} | ${agent} | ${childSummary?.state ?? "unknown"}${child.label ? ` | ${child.label}` : ""}`,
				);
			}
			if (summary.state === "running" || summary.state === "queued" || summary.state === "lost")
				lines.push("", ASYNC_NO_POLL_GUIDANCE);
			return { content: [{ type: "text", text: lines.join("\n") }], details: { mode: "single", results: [] } };
		}
	}

	return {
		content: [{ type: "text", text: "Status file not found." }],
		isError: true,
		details: { mode: "single", results: [] },
	};
}
