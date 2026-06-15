import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { type AgentScope, discoverAgents } from "../shared/agents.ts";
import type { Details } from "../protocol/types.ts";

type ManagementAction = "list";
type ManagementContext = { cwd: string; modelRegistry: { getAvailable(): Array<{ provider?: string; id?: string }> } };

interface ManagementParams {
	action?: string;
	agent?: string;
	agentScope?: string;
	includeInternal?: boolean;
	config?: unknown;
	preset?: string;
}

function result(text: string, isError = false): AgentToolResult<Details> {
	return { content: [{ type: "text", text }], isError, details: { mode: "management", results: [] } };
}

function normalizeListScope(scope: unknown): AgentScope | undefined {
	if (scope === undefined) return "both";
	if (scope === "user" || scope === "project" || scope === "both") return scope;
	return undefined;
}

export function handleList(params: ManagementParams, ctx: ManagementContext): AgentToolResult<Details> {
	const scope = normalizeListScope(params.agentScope) ?? "both";
	const agentDiscovery = discoverAgents(ctx.cwd, "both", {
		preset: params.preset,
		surface: "subagent",
		includeInternal: params.includeInternal === true,
	});
	const agents = agentDiscovery.agents
		.filter((a) => scope === "both" || a.source === "builtin" || a.source === scope)
		.sort((a, b) => a.name.localeCompare(b.name));
	return result(
		[
			"Executable agents:",
			...(agents.length ? agents.map((a) => `- ${a.name} (${a.source}): ${a.description}`) : ["- (none)"]),
		].join("\n"),
	);
}

export function handleManagementAction(
	action: string,
	params: ManagementParams,
	ctx: ManagementContext,
): AgentToolResult<Details> {
	switch (action as ManagementAction) {
		case "list":
			return handleList(params, ctx);
		default:
			return result(`Unknown action: ${action}`, true);
	}
}
