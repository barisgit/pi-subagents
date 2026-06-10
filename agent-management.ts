import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
	type AgentConfig,
	type AgentScope,
	type AgentSource,
	defaultInheritProjectContext,
	defaultInheritSkills,
	defaultSystemPromptMode,
	discoverAgents,
	discoverAgentsAll,
} from "./agents.ts";
import { serializeAgent } from "./agent-serializer.ts";
import { discoverAvailableSkills } from "./skills.ts";
import type { Details } from "./types.ts";

type ManagementAction = "list";
type ManagementScope = "user" | "project";
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

function parseCsv(value: string): string[] {
	return [...new Set(value.split(",").map((v) => v.trim()).filter(Boolean))];
}

function configObject(config: unknown): { value?: Record<string, unknown>; error?: string } {
	let val = config;
	if (typeof val === "string") {
		try { val = JSON.parse(val); }
		catch (error) { return { error: `config must be valid JSON: ${error instanceof Error ? error.message : String(error)}` }; }
	}
	if (!val || typeof val !== "object" || Array.isArray(val)) return {};
	return { value: val as Record<string, unknown> };
}

function hasKey(obj: Record<string, unknown>, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(obj, key);
}

function asDisambiguationScope(scope: unknown): ManagementScope | undefined {
	if (scope === "user" || scope === "project") return scope;
	return undefined;
}

function normalizeListScope(scope: unknown): AgentScope | undefined {
	if (scope === undefined) return "both";
	if (scope === "user" || scope === "project" || scope === "both") return scope;
	return undefined;
}

function toManagementScope(source: AgentSource): ManagementScope {
	return source === "builtin" ? "user" : source;
}

export function sanitizeName(name: string): string {
	return name.toLowerCase().trim().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
}

function allAgents(d: { builtin: AgentConfig[]; user: AgentConfig[]; project: AgentConfig[] }): AgentConfig[] {
	return [...d.builtin, ...d.user, ...d.project];
}

function availableNames(cwd: string, preset?: string): string[] {
	const d = discoverAgentsAll(cwd, { preset });
	return [...new Set(allAgents(d).map((x) => x.name))].sort((a, b) => a.localeCompare(b));
}

export function findAgents(name: string, cwd: string, scope: AgentScope = "both", preset?: string): AgentConfig[] {
	const d = discoverAgentsAll(cwd, { preset });
	const raw = name.trim();
	const sanitized = sanitizeName(raw);
	return allAgents(d)
		.filter((a) => (scope === "both" || a.source === scope) && (a.name === raw || a.name === sanitized))
		.sort((a, b) => a.source.localeCompare(b.source));
}

function nameExistsInScope(cwd: string, scope: ManagementScope, name: string, excludePath?: string): boolean {
	const d = discoverAgentsAll(cwd);
	for (const a of scope === "user" ? d.user : d.project) {
		if (a.name === name && a.filePath !== excludePath) return true;
	}
	return false;
}

function modelWarning(ctx: ManagementContext, model: string | undefined): string | undefined {
	if (!model) return undefined;
	const found = ctx.modelRegistry.getAvailable().some((m) => `${m.provider}/${m.id}` === model || m.id === model);
	return found ? undefined : `Warning: model '${model}' is not in the current model registry.`;
}

function fallbackModelsWarning(ctx: ManagementContext, fallbackModels: string[] | undefined): string | undefined {
	if (!fallbackModels?.length) return undefined;
	const available = new Set(ctx.modelRegistry.getAvailable().flatMap((m) => [`${m.provider}/${m.id}`, m.id]));
	const missing = fallbackModels.filter((model) => !available.has(model));
	return missing.length ? `Warning: fallback models not in the current model registry: ${missing.join(", ")}.` : undefined;
}

function skillsWarning(cwd: string, skills: string[] | undefined): string | undefined {
	if (!skills?.length) return undefined;
	const available = new Set(discoverAvailableSkills(cwd).map((s) => s.name));
	const missing = skills.filter((s) => !available.has(s));
	return missing.length ? `Warning: skills not found: ${missing.join(", ")}.` : undefined;
}

function parseTools(raw: string): { tools?: string[]; mcpDirectTools?: string[] } {
	const tools: string[] = [];
	const mcpDirectTools: string[] = [];
	for (const item of parseCsv(raw)) {
		if (item.startsWith("mcp:")) {
			const direct = item.slice(4).trim();
			if (direct) mcpDirectTools.push(direct);
		} else tools.push(item);
	}
	return { tools: tools.length ? tools : undefined, mcpDirectTools: mcpDirectTools.length ? mcpDirectTools : undefined };
}

function applyAgentConfig(target: AgentConfig, cfg: Record<string, unknown>): string | undefined {
	if (hasKey(cfg, "systemPrompt")) {
		if (cfg.systemPrompt === false || cfg.systemPrompt === "") target.systemPrompt = "";
		else if (typeof cfg.systemPrompt === "string") target.systemPrompt = cfg.systemPrompt;
		else return "config.systemPrompt must be a string or false when provided.";
	}
	if (hasKey(cfg, "model")) {
		if (cfg.model === false || cfg.model === "") target.model = undefined;
		else if (typeof cfg.model === "string") target.model = cfg.model.trim() || undefined;
		else return "config.model must be a string or false when provided.";
	}
	if (hasKey(cfg, "fallbackModels")) {
		if (cfg.fallbackModels === false || cfg.fallbackModels === "") target.fallbackModels = undefined;
		else if (typeof cfg.fallbackModels === "string") target.fallbackModels = parseCsv(cfg.fallbackModels);
		else if (Array.isArray(cfg.fallbackModels)) target.fallbackModels = [...new Set(cfg.fallbackModels.filter((value): value is string => typeof value === "string").map((value) => value.trim()).filter(Boolean))];
		else return "config.fallbackModels must be a comma-separated string, string array, or false when provided.";
	}
	if (hasKey(cfg, "tools")) {
		if (cfg.tools === false || cfg.tools === "") { target.tools = undefined; target.mcpDirectTools = undefined; }
		else if (typeof cfg.tools === "string") { const parsed = parseTools(cfg.tools); target.tools = parsed.tools; target.mcpDirectTools = parsed.mcpDirectTools; }
		else return "config.tools must be a comma-separated string or false when provided.";
	}
	if (hasKey(cfg, "skills")) {
		if (cfg.skills === false || cfg.skills === "") target.skills = undefined;
		else if (typeof cfg.skills === "string") target.skills = parseCsv(cfg.skills);
		else return "config.skills must be a comma-separated string or false when provided.";
	}
	if (hasKey(cfg, "extensions")) {
		if (cfg.extensions === false) target.extensions = undefined;
		else if (cfg.extensions === "") target.extensions = [];
		else if (typeof cfg.extensions === "string") target.extensions = parseCsv(cfg.extensions);
		else return "config.extensions must be a comma-separated string, empty string, or false when provided.";
	}
	if (hasKey(cfg, "thinking")) {
		if (cfg.thinking === false || cfg.thinking === "") target.thinking = undefined;
		else if (typeof cfg.thinking === "string") target.thinking = cfg.thinking.trim() || undefined;
		else return "config.thinking must be a string or false when provided.";
	}
	if (hasKey(cfg, "systemPromptMode")) {
		if (cfg.systemPromptMode === "append" || cfg.systemPromptMode === "replace") target.systemPromptMode = cfg.systemPromptMode;
		else return "config.systemPromptMode must be 'append' or 'replace' when provided.";
	}
	if (hasKey(cfg, "inheritProjectContext")) {
		if (typeof cfg.inheritProjectContext !== "boolean") return "config.inheritProjectContext must be a boolean when provided.";
		target.inheritProjectContext = cfg.inheritProjectContext;
	}
	if (hasKey(cfg, "inheritSkills")) {
		if (typeof cfg.inheritSkills !== "boolean") return "config.inheritSkills must be a boolean when provided.";
		target.inheritSkills = cfg.inheritSkills;
	}
	if (hasKey(cfg, "output")) {
		if (cfg.output === false || cfg.output === "") target.output = undefined;
		else if (typeof cfg.output === "string") target.output = cfg.output;
		else return "config.output must be a string or false when provided.";
	}
	if (hasKey(cfg, "reads")) {
		if (cfg.reads === false || cfg.reads === "") target.defaultReads = undefined;
		else if (typeof cfg.reads === "string") target.defaultReads = parseCsv(cfg.reads);
		else return "config.reads must be a comma-separated string or false when provided.";
	}
	if (hasKey(cfg, "progress")) {
		if (typeof cfg.progress !== "boolean") return "config.progress must be a boolean when provided.";
		target.defaultProgress = cfg.progress;
	}
	if (hasKey(cfg, "maxSubagentDepth")) {
		if (cfg.maxSubagentDepth === false || cfg.maxSubagentDepth === "") target.maxSubagentDepth = undefined;
		else if (typeof cfg.maxSubagentDepth === "number" && Number.isInteger(cfg.maxSubagentDepth) && cfg.maxSubagentDepth >= 0) target.maxSubagentDepth = cfg.maxSubagentDepth;
		else return "config.maxSubagentDepth must be an integer >= 0 or false when provided.";
	}
	return undefined;
}

function resolveTarget(name: string, matches: AgentConfig[], cwd: string, scopeHint?: string): AgentConfig | AgentToolResult<Details> {
	const mutable = matches.filter((m) => m.source !== "builtin");
	if (mutable.length === 0) {
		if (matches.length > 0) return result(`Agent '${name}' is builtin and cannot be modified. Create a same-named agent in user or project scope to override it.`, true);
		return result(`Agent '${name}' not found. Available: ${availableNames(cwd).join(", ") || "none"}.`, true);
	}
	if (mutable.length === 1) return mutable[0]!;
	const scope = asDisambiguationScope(scopeHint);
	if (!scope) return result(`Agent '${name}' exists in both scopes. Specify agentScope: 'user' or 'project'.\n${mutable.map((m) => `${m.source}: ${m.filePath}`).join("\n")}`, true);
	const scoped = mutable.filter((m) => m.source === scope);
	if (scoped.length === 0) return result(`Agent '${name}' not found in scope '${scope}'.`, true);
	if (scoped.length > 1) return result(`Multiple agents named '${name}' found in scope '${scope}': ${scoped.map((m) => m.filePath).join(", ")}`, true);
	return scoped[0]!;
}

function renamePath(currentPath: string, newName: string, scope: ManagementScope, cwd: string): { filePath?: string; error?: string } {
	if (nameExistsInScope(cwd, scope, newName, currentPath)) return { error: `Name '${newName}' already exists in ${scope} scope.` };
	const filePath = path.join(path.dirname(currentPath), `${newName}.md`);
	if (fs.existsSync(filePath) && filePath !== currentPath) return { error: `File already exists at ${filePath} but is not a valid agent definition. Remove or rename it first.` };
	fs.renameSync(currentPath, filePath);
	return { filePath };
}

export function formatAgentDetail(agent: AgentConfig): string {
	const tools = [...(agent.tools ?? []), ...(agent.mcpDirectTools ?? []).map((t) => `mcp:${t}`)];
	const lines: string[] = [`Agent: ${agent.name} (${agent.source})`, `Path: ${agent.filePath}`, `Description: ${agent.description}`];
	if (agent.model) lines.push(`Model: ${agent.model}`);
	if (agent.fallbackModels?.length) lines.push(`Fallback models: ${agent.fallbackModels.join(", ")}`);
	if (tools.length) lines.push(`Tools: ${tools.join(", ")}`);
	if (agent.skills?.length) lines.push(`Skills: ${agent.skills.join(", ")}`);
	lines.push(`System prompt mode: ${agent.systemPromptMode}`);
	lines.push(`Inherit project context: ${agent.inheritProjectContext ? "true" : "false"}`);
	lines.push(`Inherit skills: ${agent.inheritSkills ? "true" : "false"}`);
	if (agent.source === "builtin") lines.push(`Disabled: ${agent.disabled ? "true" : "false"}`);
	if (agent.extensions !== undefined) lines.push(`Extensions: ${agent.extensions.length ? agent.extensions.join(", ") : "(none)"}`);
	if (agent.thinking) lines.push(`Thinking: ${agent.thinking}`);
	if (agent.output) lines.push(`Output: ${agent.output}`);
	if (agent.defaultReads?.length) lines.push(`Reads: ${agent.defaultReads.join(", ")}`);
	if (agent.defaultProgress) lines.push("Progress: true");
	if (agent.maxSubagentDepth !== undefined) lines.push(`Max subagent depth: ${agent.maxSubagentDepth}`);
	if (agent.systemPrompt.trim()) lines.push("", "System Prompt:", agent.systemPrompt);
	return lines.join("\n");
}

export function handleList(params: ManagementParams, ctx: ManagementContext): AgentToolResult<Details> {
	const scope = normalizeListScope(params.agentScope) ?? "both";
	const agentDiscovery = discoverAgents(ctx.cwd, "both", { preset: params.preset, surface: "subagent", includeInternal: params.includeInternal === true });
	const agents = agentDiscovery.agents
		.filter((a) => scope === "both" || a.source === "builtin" || a.source === scope)
		.sort((a, b) => a.name.localeCompare(b.name));
	return result(["Executable agents:", ...(agents.length ? agents.map((a) => `- ${a.name} (${a.source}): ${a.description}`) : ["- (none)"])].join("\n"));
}

export function handleGet(params: ManagementParams, ctx: ManagementContext): AgentToolResult<Details> {
	if (!params.agent) return result("Specify 'agent' for get.", true);
	const matches = findAgents(params.agent, ctx.cwd, "both", params.preset);
	if (!matches.length) return result(`Agent '${params.agent}' not found. Available: ${availableNames(ctx.cwd, params.preset).join(", ") || "none"}.`, true);
	return result(matches.map(formatAgentDetail).join("\n\n"));
}

export function handleCreate(params: ManagementParams, ctx: ManagementContext): AgentToolResult<Details> {
	const parsedConfig = configObject(params.config);
	if (parsedConfig.error) return result(parsedConfig.error, true);
	const cfg = parsedConfig.value;
	if (!cfg) return result("config required for create.", true);
	if (hasKey(cfg, "steps")) return result("Saved orchestration configs are no longer supported; use the workflow tool.", true);
	if (typeof cfg.name !== "string" || !cfg.name.trim()) return result("config.name is required and must be a non-empty string.", true);
	if (typeof cfg.description !== "string" || !cfg.description.trim()) return result("config.description is required and must be a non-empty string.", true);
	const name = sanitizeName(cfg.name);
	if (!name) return result("config.name is invalid after sanitization. Use letters, numbers, spaces, or hyphens.", true);
	const scopeRaw = cfg.scope ?? "user";
	if (scopeRaw !== "user" && scopeRaw !== "project") return result("config.scope must be 'user' or 'project'.", true);
	const scope = scopeRaw as ManagementScope;
	const d = discoverAgentsAll(ctx.cwd);
	const targetDir = scope === "user" ? d.userDir : d.projectDir ?? path.join(ctx.cwd, ".pi", "agents");
	fs.mkdirSync(targetDir, { recursive: true });
	if (nameExistsInScope(ctx.cwd, scope, name)) return result(`Name '${name}' already exists in ${scope} scope. Use update instead.`, true);
	const targetPath = path.join(targetDir, `${name}.md`);
	if (fs.existsSync(targetPath)) return result(`File already exists at ${targetPath} but is not a valid agent definition. Remove or rename it first.`, true);
	const warnings: string[] = [];
	if (d.builtin.some((a) => a.name === name)) warnings.push(`Note: this shadows the builtin agent '${name}'.`);
	const agent: AgentConfig = { name, description: cfg.description.trim(), source: scope, filePath: targetPath, systemPrompt: "", systemPromptMode: defaultSystemPromptMode(name), inheritProjectContext: defaultInheritProjectContext(name), inheritSkills: defaultInheritSkills() };
	const applyError = applyAgentConfig(agent, cfg);
	if (applyError) return result(applyError, true);
	for (const warning of [modelWarning(ctx, agent.model), fallbackModelsWarning(ctx, agent.fallbackModels), skillsWarning(ctx.cwd, agent.skills)]) if (warning) warnings.push(warning);
	fs.writeFileSync(targetPath, serializeAgent(agent), "utf-8");
	return result([`Created agent '${name}' at ${targetPath}.`, ...warnings].join("\n"));
}

export function handleUpdate(params: ManagementParams, ctx: ManagementContext): AgentToolResult<Details> {
	if (!params.agent) return result("Specify 'agent' for update.", true);
	const parsedConfig = configObject(params.config);
	if (parsedConfig.error) return result(parsedConfig.error, true);
	const cfg = parsedConfig.value;
	if (!cfg) return result("config required for update.", true);
	if (hasKey(cfg, "steps")) return result("Saved orchestration configs are no longer supported; use the workflow tool.", true);
	const scopeHint = asDisambiguationScope(params.agentScope);
	const targetOrError = resolveTarget(params.agent, findAgents(params.agent, ctx.cwd, scopeHint ?? "both"), ctx.cwd, params.agentScope);
	if ("content" in targetOrError) return targetOrError;
	const updated: AgentConfig = { ...targetOrError };
	const oldName = targetOrError.name;
	if (hasKey(cfg, "name") && (typeof cfg.name !== "string" || !cfg.name.trim())) return result("config.name must be a non-empty string when provided.", true);
	if (hasKey(cfg, "description") && (typeof cfg.description !== "string" || !cfg.description.trim())) return result("config.description must be a non-empty string when provided.", true);
	if (hasKey(cfg, "name")) {
		updated.name = sanitizeName(cfg.name as string);
		if (!updated.name) return result("config.name is invalid after sanitization.", true);
	}
	const applyError = applyAgentConfig(updated, cfg);
	if (applyError) return result(applyError, true);
	if (hasKey(cfg, "description")) updated.description = (cfg.description as string).trim();
	const warnings: string[] = [];
	for (const warning of [modelWarning(ctx, updated.model), fallbackModelsWarning(ctx, updated.fallbackModels), skillsWarning(ctx.cwd, updated.skills)]) if (warning) warnings.push(warning);
	if (updated.name !== oldName) {
		const renamed = renamePath(targetOrError.filePath, updated.name, toManagementScope(targetOrError.source), ctx.cwd);
		if (renamed.error) return result(renamed.error, true);
		updated.filePath = renamed.filePath!;
	}
	fs.writeFileSync(updated.filePath, serializeAgent(updated), "utf-8");
	const headline = updated.name === oldName ? `Updated agent '${updated.name}' at ${updated.filePath}.` : `Updated agent '${oldName}' to '${updated.name}' at ${updated.filePath}.`;
	return result([headline, ...warnings].join("\n"));
}

export function handleDelete(params: ManagementParams, ctx: ManagementContext): AgentToolResult<Details> {
	if (!params.agent) return result("Specify 'agent' for delete.", true);
	const scopeHint = asDisambiguationScope(params.agentScope);
	const targetOrError = resolveTarget(params.agent, findAgents(params.agent, ctx.cwd, scopeHint ?? "both"), ctx.cwd, params.agentScope);
	if ("content" in targetOrError) return targetOrError;
	fs.unlinkSync(targetOrError.filePath);
	return result(`Deleted agent '${targetOrError.name}' at ${targetOrError.filePath}.`);
}

export function handleManagementAction(action: string, params: ManagementParams, ctx: ManagementContext): AgentToolResult<Details> {
	switch (action as ManagementAction) {
		case "list": return handleList(params, ctx);
		default: return result(`Unknown action: ${action}`, true);
	}
}
