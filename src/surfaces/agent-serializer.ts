import { type AgentConfig, KNOWN_FIELDS } from "../shared/agents.ts";

function joinComma(values: string[] | undefined): string | undefined {
	if (!values || values.length === 0) return undefined;
	return values.join(", ");
}

export function serializeAgent(config: AgentConfig): string {
	const lines: string[] = [];
	lines.push("---");
	lines.push(`name: ${config.name}`);
	lines.push(`description: ${config.description}`);

	const tools = [...(config.tools ?? []), ...(config.mcpDirectTools ?? []).map((tool) => `mcp:${tool}`)];
	const toolsValue = joinComma(tools);
	if (toolsValue) lines.push(`tools: ${toolsValue}`);

	if (config.model) lines.push(`model: ${config.model}`);
	const fallbackModelsValue = joinComma(config.fallbackModels);
	if (fallbackModelsValue) lines.push(`fallbackModels: ${fallbackModelsValue}`);
	if (config.thinking && config.thinking !== "off") lines.push(`thinking: ${config.thinking}`);
	lines.push(`systemPromptMode: ${config.systemPromptMode}`);
	lines.push(`inheritProjectContext: ${config.inheritProjectContext ? "true" : "false"}`);
	lines.push(`inheritSkills: ${config.inheritSkills ? "true" : "false"}`);

	const skillsValue = joinComma(config.skills);
	if (skillsValue) lines.push(`skills: ${skillsValue}`);

	if (config.extensions !== undefined) {
		const extensionsValue = joinComma(config.extensions);
		lines.push(`extensions: ${extensionsValue ?? ""}`);
	}

	if (config.output) lines.push(`output: ${config.output}`);

	const readsValue = joinComma(config.defaultReads);
	if (readsValue) lines.push(`defaultReads: ${readsValue}`);

	if (config.defaultProgress) lines.push("defaultProgress: true");
	if (config.interactive) lines.push("interactive: true");
	if (
		config.maxSubagentDepth !== undefined &&
		Number.isInteger(config.maxSubagentDepth) &&
		config.maxSubagentDepth >= 0
	) {
		lines.push(`maxSubagentDepth: ${config.maxSubagentDepth}`);
	}
	if (config.disabled !== undefined) lines.push(`disabled: ${config.disabled ? "true" : "false"}`);
	if (config.surface) lines.push(`surface: ${config.surface}`);
	if (config.canDelegate !== undefined) lines.push(`canDelegate: ${config.canDelegate ? "true" : "false"}`);
	const allowedDelegateAgentsValue = joinComma(config.allowedDelegateAgents);
	if (allowedDelegateAgentsValue) lines.push(`allowedDelegateAgents: ${allowedDelegateAgentsValue}`);

	if (config.extraFields) {
		for (const [key, value] of Object.entries(config.extraFields)) {
			if (KNOWN_FIELDS.has(key)) continue;
			lines.push(`${key}: ${value}`);
		}
	}

	lines.push("---");

	const body = config.systemPrompt ?? "";
	return `${lines.join("\n")}\n\n${body}\n`;
}
