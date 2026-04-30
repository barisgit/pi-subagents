import type { AgentConfig } from "./agents.ts";

/**
 * Convert a simple glob pattern (with only `*` wildcards) to a RegExp.
 * `*` matches one or more characters (not empty). Escapes all other regex chars.
 */
function globToRegex(pattern: string): RegExp {
	const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
	const regexStr = escaped.replace(/\*/g, ".+");
	return new RegExp(`^${regexStr}$`);
}

function isGlob(pattern: string): boolean {
	return pattern.includes("*");
}

function matches(toolName: string, pattern: string): boolean {
	if (!isGlob(pattern)) return toolName === pattern;
	return globToRegex(pattern).test(toolName);
}

/**
 * Resolve a raw tool list that may contain:
 * - Exact tool names: `"read"`, `"bash"`
 * - Glob patterns: `"task_*"` (matches `task_manage`, `task_next`, etc.)
 * - Negations: `"!edit"`, `"!auggie_*"`
 *
 * Walks the list in order. Positive entries add matching tools from `availableTools`.
 * Negation entries remove previously matched tools.
 *
 * Returns a deduped list of resolved tool names.
 */
export function resolveToolPatterns(rawTools: string[], availableTools: string[]): string[] {
	if (rawTools.length === 0) return [];

	const result: string[] = [];
	const seen = new Set<string>();

	for (const entry of rawTools) {
		const isNegation = entry.startsWith("!");
		const pattern = isNegation ? entry.slice(1) : entry;

		if (isNegation) {
			// Remove matching tools from result
			for (let i = result.length - 1; i >= 0; i--) {
				if (matches(result[i]!, pattern)) {
					seen.delete(result[i]!);
					result.splice(i, 1);
				}
			}
		} else if (isGlob(pattern)) {
			// Expand glob against available tools
			for (const tool of availableTools) {
				if (!seen.has(tool) && matches(tool, pattern)) {
					seen.add(tool);
					result.push(tool);
				}
			}
		} else {
			// Exact match — include regardless of availability
			// (pi silently ignores unknown tool names)
			if (!seen.has(pattern)) {
				seen.add(pattern);
				result.push(pattern);
			}
		}
	}

	return result;
}

/**
 * Resolve tool patterns in an AgentConfig, returning a new config
 * with `tools` expanded. `mcpDirectTools` is left untouched
 * (those are resolved separately via the `mcp:` prefix convention).
 */
export function resolveAgentToolPatterns(agent: AgentConfig, availableTools: string[]): AgentConfig {
	if (!agent.tools || agent.tools.length === 0) return agent;
	const hasPattern = agent.tools.some((t) => t.startsWith("!") || t.includes("*"));
	if (!hasPattern) return agent;
	return { ...agent, tools: resolveToolPatterns(agent.tools, availableTools) };
}
