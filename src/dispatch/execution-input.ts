import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../shared/agents.ts";
import type { ExecutorDeps, InternalSubagentParams } from "./executor-types.ts";
import { getRequestedModeLabel } from "./executor-helpers.ts";
import { getLineageForSession } from "../state/lineage.ts";
import type { ForkReuseConfig, SubagentToolResult } from "../protocol/types.ts";

export function validateExecutionInput(
	params: InternalSubagentParams,
	agents: AgentConfig[],
	hasTasks: boolean,
	hasSingle: boolean,
): SubagentToolResult | null {
	if (Number(hasTasks) + Number(hasSingle) !== 1) {
		return {
			content: [
				{
					type: "text",
					text: `Provide exactly one mode. Agents: ${agents.map((a) => a.name).join(", ") || "none"}`,
				},
			],
			isError: true,
			details: { mode: "single" as const, results: [] },
		};
	}
	return null;
}
export function buildRequestedModeError(params: InternalSubagentParams, message: string): SubagentToolResult {
	return withForkContext(
		{
			content: [{ type: "text", text: message }],
			isError: true,
			details: { mode: getRequestedModeLabel(params), results: [] },
		},
		params.context,
	);
}
export function collectRequestedAgentNames(params: InternalSubagentParams): string[] {
	if ((params.tasks?.length ?? 0) > 0) {
		return params
			.tasks!.map((task) =>
				typeof task === "object" && task && !Array.isArray(task) ? normalizeName(task.agent) : undefined,
			)
			.filter((agent): agent is string => Boolean(agent));
	}
	if (params.agent) return [params.agent];
	return [];
}
export function normalizeName(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed || undefined;
}
function collectForkOverridePaths(params: InternalSubagentParams): string[] {
	const paths: string[] = [];
	if (params.clarify === true) paths.push("clarify");
	if (params.model !== undefined) paths.push("model");
	if (params.skill !== undefined) paths.push("skill");
	for (let i = 0; i < (params.tasks?.length ?? 0); i++) {
		const task = params.tasks![i]!;
		if (typeof task !== "object" || !task || Array.isArray(task)) continue;
		if (task.model !== undefined) paths.push(`tasks[${i}].model`);
		if (task.skill !== undefined) paths.push(`tasks[${i}].skill`);
	}
	return paths;
}
export function resolveForkReuse(
	params: InternalSubagentParams,
	ctx: ExtensionContext,
	deps: ExecutorDeps,
): ForkReuseConfig | undefined {
	if (params.context !== "fork") return undefined;
	const requestedAgents = collectRequestedAgentNames(params);
	const currentSessionId = ctx.sessionManager.getSessionId() ?? deps.state.currentSessionId ?? undefined;
	const currentLineage = currentSessionId ? getLineageForSession(currentSessionId) : null;
	// Identity resolution order (fallbacks are unavailable to authoritative child lineage):
	//   1. Non-blank current session lineage
	//   2. Legacy environment identity when lineage is unavailable or host identity is blank
	//   3. Active root role / preset stored by the extension
	//   4. Single requested agent for a root self-fork
	const uniqueRequested = [...new Set(requestedAgents)];
	const currentAgentName =
		normalizeName(currentLineage?.currentAgent) ??
		(currentLineage?.role === "child"
			? undefined
			: (normalizeName(process.env.PI_SUBAGENT_CURRENT_AGENT) ??
				normalizeName(deps.getActiveRootRoleName?.()) ??
				(uniqueRequested.length === 1 ? normalizeName(uniqueRequested[0]) : undefined)));
	if (!currentAgentName) {
		throw new Error("Fork context requires a known current agent identity.");
	}
	const mismatchedAgents = uniqueRequested.filter((name) => name !== currentAgentName);
	if (mismatchedAgents.length > 0) {
		throw new Error("Fork context requires same-agent execution; the requested agent does not match this session.");
	}
	const overridePaths = collectForkOverridePaths(params);
	if (overridePaths.length > 0) {
		throw new Error(
			`Fork context requires same-agent execution without prompt/model/skill overrides. Unsupported overrides: ${overridePaths.join(", ")}`,
		);
	}
	if (!currentSessionId) {
		throw new Error("Fork context requires a known current session id.");
	}
	return {
		agentName: currentAgentName,
		sessionId: currentSessionId,
	};
}
export function withForkContext(
	result: SubagentToolResult,
	context: InternalSubagentParams["context"],
): SubagentToolResult {
	if (context !== "fork" || !result.details) return result;
	return {
		...result,
		details: {
			...result.details,
			context: "fork",
		},
	};
}
export function toExecutionErrorResult(params: InternalSubagentParams, error: unknown): SubagentToolResult {
	const message = error instanceof Error ? error.message : String(error);
	return withForkContext(
		{
			content: [{ type: "text", text: message }],
			isError: true,
			details: { mode: getRequestedModeLabel(params), results: [] },
		},
		params.context,
	);
}
