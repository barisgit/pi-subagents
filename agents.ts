/**
 * Agent discovery and configuration
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { KNOWN_FIELDS } from "./agent-serializer.ts";
import { parseChain } from "./chain-serializer.ts";
import { mergeAgentsForScope } from "./agent-selection.ts";
import { parseFrontmatter } from "./frontmatter.ts";
import type {
	AgentPresetOverlay,
	AgentSurface,
	DiscoveryPresetInfo,
	ExtensionConfig,
	PresetConfig,
	PresetSource,
} from "./types.ts";

export type AgentScope = "user" | "project" | "both";

export type AgentSource = "builtin" | "user" | "project";
export type SystemPromptMode = "append" | "replace";

export function defaultSystemPromptMode(name: string): SystemPromptMode {
	return name === "delegate" ? "append" : "replace";
}

export function defaultInheritProjectContext(name: string): boolean {
	return name === "delegate";
}

export function defaultInheritSkills(): boolean {
	return false;
}

export function defaultSurface(): AgentSurface {
	return "both";
}

export function defaultCanDelegate(name: string): boolean {
	return name === "orchestrator" || name === "delegate";
}

export function defaultAllowedDelegateAgents(name: string): string[] | undefined {
	return defaultCanDelegate(name) ? ["explorer", "librarian", "oracle", "designer", "fixer"] : undefined;
}

export interface BuiltinAgentOverrideBase {
	model?: string;
	fallbackModels?: string[];
	thinking?: string;
	systemPromptMode: SystemPromptMode;
	inheritProjectContext: boolean;
	inheritSkills: boolean;
	disabled?: boolean;
	systemPrompt: string;
	skills?: string[];
	tools?: string[];
	mcpDirectTools?: string[];
}

export interface BuiltinAgentOverrideConfig {
	model?: string | false;
	fallbackModels?: string[] | false;
	thinking?: string | false;
	systemPromptMode?: SystemPromptMode;
	inheritProjectContext?: boolean;
	inheritSkills?: boolean;
	disabled?: boolean;
	systemPrompt?: string;
	skills?: string[] | false;
	tools?: string[] | false;
}

export interface BuiltinAgentOverrideInfo {
	scope: "user" | "project";
	path: string;
	base: BuiltinAgentOverrideBase;
}

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	mcpDirectTools?: string[];
	model?: string;
	fallbackModels?: string[];
	thinking?: string;
	systemPromptMode: SystemPromptMode;
	inheritProjectContext: boolean;
	inheritSkills: boolean;
	systemPrompt: string;
	source: AgentSource;
	filePath: string;
	skills?: string[];
	extensions?: string[];
	output?: string;
	defaultReads?: string[];
	defaultProgress?: boolean;
	interactive?: boolean;
	maxSubagentDepth?: number;
	disabled?: boolean;
	surface?: AgentSurface;
	canDelegate?: boolean;
	allowedDelegateAgents?: string[];
	extraFields?: Record<string, string>;
	override?: BuiltinAgentOverrideInfo;
}

interface SubagentSettings {
	overrides: Record<string, BuiltinAgentOverrideConfig>;
	disableBuiltins?: boolean;
}

const EMPTY_SUBAGENT_SETTINGS: SubagentSettings = { overrides: {} };

export interface ChainStepConfig {
	agent: string;
	task: string;
	output?: string | false;
	reads?: string[] | false;
	model?: string;
	skills?: string[] | false;
	progress?: boolean;
}

export interface ChainConfig {
	name: string;
	description: string;
	source: AgentSource;
	filePath: string;
	steps: ChainStepConfig[];
	extraFields?: Record<string, string>;
}

export interface AgentDiscoveryOptions {
	preset?: string;
	config?: ExtensionConfig;
	surface?: Exclude<AgentSurface, "both">;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
	preset: DiscoveryPresetInfo;
}

export interface AgentDiscoveryAllResult {
	builtin: AgentConfig[];
	user: AgentConfig[];
	project: AgentConfig[];
	chains: ChainConfig[];
	userDir: string;
	projectDir: string | null;
	userSettingsPath: string;
	projectSettingsPath: string | null;
	preset: DiscoveryPresetInfo;
}

const SUBAGENT_CONFIG_PRIMARY = path.join(os.homedir(), ".pi", "agent", "subagent.json");
const SUBAGENT_CONFIG_LEGACY = path.join(os.homedir(), ".pi", "agent", "extensions", "subagent", "config.json");

function getExtensionConfigPath(): string {
	if (fs.existsSync(SUBAGENT_CONFIG_PRIMARY)) return SUBAGENT_CONFIG_PRIMARY;
	if (fs.existsSync(SUBAGENT_CONFIG_LEGACY)) return SUBAGENT_CONFIG_LEGACY;
	return SUBAGENT_CONFIG_PRIMARY;
}

function loadExtensionConfig(config?: ExtensionConfig): ExtensionConfig {
	if (config) return config;
	const configPath = getExtensionConfigPath();
	try {
		if (fs.existsSync(configPath)) {
			const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8"));
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				return parsed as ExtensionConfig;
			}
		}
	} catch {
		// Discovery should stay resilient; invalid preset config falls back to base discovery.
	}
	return {};
}

function normalizePresetName(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed || undefined;
}

function normalizePresetStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const items = value
		.filter((item): item is string => typeof item === "string")
		.map((item) => item.trim())
		.filter(Boolean);
	return items.length > 0 ? items : undefined;
}

function normalizePresetAgentSurface(value: unknown): AgentSurface | undefined {
	return value === "main" || value === "subagent" || value === "both" ? value : undefined;
}

function isVisibleOnSurface(agent: AgentConfig, surface: Exclude<AgentSurface, "both"> | undefined): boolean {
	if (!surface) return true;
	const agentSurface = agent.surface ?? defaultSurface();
	return agentSurface === "both" || agentSurface === surface;
}

function normalizePresetSource(
	explicitPreset: string | undefined,
	config: ExtensionConfig,
): { requested?: string; source?: PresetSource } {
	if (explicitPreset) return { requested: explicitPreset, source: "param" };
	const envPreset = normalizePresetName(process.env.PI_PRESET);
	if (envPreset) return { requested: envPreset, source: "PI_PRESET" };
	const legacyEnvPreset = normalizePresetName(process.env.OH_MY_OPENCODE_SLIM_PRESET);
	if (legacyEnvPreset) return { requested: legacyEnvPreset, source: "OH_MY_OPENCODE_SLIM_PRESET" };
	const configPreset = normalizePresetName(config.defaultPreset);
	if (configPreset) return { requested: configPreset, source: "config.defaultPreset" };
	return {};
}

function getPresetAgentOverlays(preset: PresetConfig | undefined): Record<string, AgentPresetOverlay> {
	if (!preset) return {};
	const overlays: Record<string, AgentPresetOverlay> = {};
	for (const source of [preset.agents, preset.agentOverrides]) {
		if (!source || typeof source !== "object" || Array.isArray(source)) continue;
		for (const [name, overlay] of Object.entries(source)) {
			if (!overlay || typeof overlay !== "object" || Array.isArray(overlay)) continue;
			overlays[name] = overlay as AgentPresetOverlay;
		}
	}
	return overlays;
}

function applyPresetOverlay(agent: AgentConfig, overlay: AgentPresetOverlay): AgentConfig {
	const next: AgentConfig = { ...agent };
	if (overlay.model !== undefined) next.model = overlay.model === false ? undefined : normalizePresetName(overlay.model);
	if (overlay.fallbackModels !== undefined) next.fallbackModels = overlay.fallbackModels === false ? undefined : normalizePresetStringArray(overlay.fallbackModels);
	if (overlay.thinking !== undefined) next.thinking = overlay.thinking === false ? undefined : normalizePresetName(overlay.thinking);
	if (overlay.tools !== undefined) next.tools = overlay.tools === false ? undefined : normalizePresetStringArray(overlay.tools);
	if (overlay.mcpDirectTools !== undefined) next.mcpDirectTools = overlay.mcpDirectTools === false ? undefined : normalizePresetStringArray(overlay.mcpDirectTools);
	if (overlay.extensions !== undefined) next.extensions = overlay.extensions === false ? undefined : normalizePresetStringArray(overlay.extensions);
	if (overlay.skills !== undefined) next.skills = overlay.skills === false ? undefined : normalizePresetStringArray(overlay.skills);
	if (overlay.output !== undefined) next.output = overlay.output === false ? undefined : normalizePresetName(overlay.output);
	if (overlay.defaultReads !== undefined) next.defaultReads = overlay.defaultReads === false ? undefined : normalizePresetStringArray(overlay.defaultReads);
	if (overlay.defaultProgress !== undefined) next.defaultProgress = overlay.defaultProgress;
	if (overlay.interactive !== undefined) next.interactive = overlay.interactive;
	if (overlay.maxSubagentDepth !== undefined) {
		next.maxSubagentDepth = typeof overlay.maxSubagentDepth === "number" && Number.isInteger(overlay.maxSubagentDepth) && overlay.maxSubagentDepth >= 0
			? overlay.maxSubagentDepth
			: undefined;
	}
	if (overlay.systemPromptMode === "append" || overlay.systemPromptMode === "replace") next.systemPromptMode = overlay.systemPromptMode;
	if (overlay.inheritProjectContext !== undefined) next.inheritProjectContext = overlay.inheritProjectContext;
	if (overlay.inheritSkills !== undefined) next.inheritSkills = overlay.inheritSkills;
	if (overlay.systemPrompt !== undefined) next.systemPrompt = overlay.systemPrompt === false ? "" : overlay.systemPrompt;
	if (overlay.disabled !== undefined) next.disabled = overlay.disabled;
	if (overlay.surface !== undefined) next.surface = normalizePresetAgentSurface(overlay.surface);
	if (overlay.canDelegate !== undefined) next.canDelegate = overlay.canDelegate;
	if (overlay.allowedDelegateAgents !== undefined) {
		next.allowedDelegateAgents = overlay.allowedDelegateAgents === false ? undefined : normalizePresetStringArray(overlay.allowedDelegateAgents);
	}
	return next;
}

function applyPresetOverlays(
	agents: AgentConfig[],
	options?: AgentDiscoveryOptions,
): { agents: AgentConfig[]; preset: DiscoveryPresetInfo } {
	const config = loadExtensionConfig(options?.config);
	const { requested, source } = normalizePresetSource(normalizePresetName(options?.preset), config);
	const presetInfo: DiscoveryPresetInfo = {
		...(requested ? { requested } : {}),
		...(source ? { source } : {}),
		warnings: [],
	};
	if (!requested) return { agents, preset: presetInfo };
	const preset = config.presets && typeof config.presets === "object" && !Array.isArray(config.presets)
		? config.presets[requested]
		: undefined;
	if (!preset) {
		presetInfo.warnings.push(`Requested preset '${requested}' was not found in ${getExtensionConfigPath()}.`);
		return { agents, preset: presetInfo };
	}
	const overlays = getPresetAgentOverlays(preset);
	const overlayNames = new Set(Object.keys(overlays));
	const baseAgents = preset.strictAgents ? agents.filter((agent) => overlayNames.has(agent.name)) : agents;
	const defaultRole = normalizePresetName(preset.defaultRole);
	presetInfo.applied = requested;
	if (defaultRole) presetInfo.defaultRole = defaultRole;
	return {
		agents: baseAgents.map((agent) => {
			const overlay = overlays[agent.name];
			return overlay ? applyPresetOverlay(agent, overlay) : agent;
		}),
		preset: presetInfo,
	};
}

function splitToolList(rawTools: string[] | undefined): { tools?: string[]; mcpDirectTools?: string[] } {
	const mcpDirectTools: string[] = [];
	const tools: string[] = [];
	for (const tool of rawTools ?? []) {
		if (tool.startsWith("mcp:")) {
			mcpDirectTools.push(tool.slice(4));
		} else {
			tools.push(tool);
		}
	}
	return {
		...(tools.length > 0 ? { tools } : {}),
		...(mcpDirectTools.length > 0 ? { mcpDirectTools } : {}),
	};
}

function joinToolList(config: Pick<AgentConfig, "tools" | "mcpDirectTools">): string[] | undefined {
	const joined = [
		...(config.tools ?? []),
		...(config.mcpDirectTools ?? []).map((tool) => `mcp:${tool}`),
	];
	return joined.length > 0 ? joined : undefined;
}

function arraysEqual(a: string[] | undefined, b: string[] | undefined): boolean {
	if (!a && !b) return true;
	if (!a || !b) return false;
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

function cloneOverrideBase(agent: AgentConfig): BuiltinAgentOverrideBase {
	return {
		model: agent.model,
		fallbackModels: agent.fallbackModels ? [...agent.fallbackModels] : undefined,
		thinking: agent.thinking,
		systemPromptMode: agent.systemPromptMode,
		inheritProjectContext: agent.inheritProjectContext,
		inheritSkills: agent.inheritSkills,
		disabled: agent.disabled,
		systemPrompt: agent.systemPrompt,
		skills: agent.skills ? [...agent.skills] : undefined,
		tools: agent.tools ? [...agent.tools] : undefined,
		mcpDirectTools: agent.mcpDirectTools ? [...agent.mcpDirectTools] : undefined,
	};
}

function cloneOverrideValue(override: BuiltinAgentOverrideConfig): BuiltinAgentOverrideConfig {
	return {
		...(override.model !== undefined ? { model: override.model } : {}),
		...(override.fallbackModels !== undefined
			? { fallbackModels: override.fallbackModels === false ? false : [...override.fallbackModels] }
			: {}),
		...(override.thinking !== undefined ? { thinking: override.thinking } : {}),
		...(override.systemPromptMode !== undefined ? { systemPromptMode: override.systemPromptMode } : {}),
		...(override.inheritProjectContext !== undefined ? { inheritProjectContext: override.inheritProjectContext } : {}),
		...(override.inheritSkills !== undefined ? { inheritSkills: override.inheritSkills } : {}),
		...(override.disabled !== undefined ? { disabled: override.disabled } : {}),
		...(override.systemPrompt !== undefined ? { systemPrompt: override.systemPrompt } : {}),
		...(override.skills !== undefined ? { skills: override.skills === false ? false : [...override.skills] } : {}),
		...(override.tools !== undefined ? { tools: override.tools === false ? false : [...override.tools] } : {}),
	};
}

function findNearestProjectRoot(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		if (isDirectory(path.join(currentDir, ".pi")) || isDirectory(path.join(currentDir, ".agents"))) {
			return currentDir;
		}

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

export function getUserAgentSettingsPath(): string {
	return path.join(os.homedir(), ".pi", "agent", "settings.json");
}

export function getProjectAgentSettingsPath(cwd: string): string | null {
	const projectRoot = findNearestProjectRoot(cwd);
	return projectRoot ? path.join(projectRoot, ".pi", "settings.json") : null;
}

function readSettingsFileStrict(filePath: string): Record<string, unknown> {
	if (!fs.existsSync(filePath)) return {};
	let raw: string;
	try {
		raw = fs.readFileSync(filePath, "utf-8");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to read settings file '${filePath}': ${message}`, { cause: error });
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to parse settings file '${filePath}': ${message}`, { cause: error });
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`Settings file '${filePath}' must contain a JSON object.`);
	}
	return parsed as Record<string, unknown>;
}

function writeSettingsFile(filePath: string, settings: Record<string, unknown>): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
}

function parseOverrideStringArrayOrFalse(
	value: unknown,
	meta: { filePath: string; name: string; field: string },
): string[] | false | undefined {
	if (value === undefined) return undefined;
	if (value === false) return false;
	if (!Array.isArray(value)) {
		throw new Error(`Builtin override '${meta.name}' in '${meta.filePath}' has invalid '${meta.field}'; expected an array of strings or false.`);
	}

	const items: string[] = [];
	for (const item of value) {
		if (typeof item !== "string") {
			throw new Error(`Builtin override '${meta.name}' in '${meta.filePath}' has invalid '${meta.field}'; expected an array of strings or false.`);
		}
		const trimmed = item.trim();
		if (trimmed) items.push(trimmed);
	}
	return items;
}

function parseBuiltinOverrideEntry(
	name: string,
	value: unknown,
	filePath: string,
): BuiltinAgentOverrideConfig | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`Builtin override '${name}' in '${filePath}' must be an object.`);
	}

	const input = value as Record<string, unknown>;
	const override: BuiltinAgentOverrideConfig = {};

	if ("model" in input) {
		if (typeof input.model === "string" || input.model === false) override.model = input.model;
		else throw new Error(`Builtin override '${name}' in '${filePath}' has invalid 'model'; expected a string or false.`);
	}

	if ("thinking" in input) {
		if (typeof input.thinking === "string" || input.thinking === false) override.thinking = input.thinking;
		else throw new Error(`Builtin override '${name}' in '${filePath}' has invalid 'thinking'; expected a string or false.`);
	}

	if ("systemPromptMode" in input) {
		if (input.systemPromptMode === "append" || input.systemPromptMode === "replace") {
			override.systemPromptMode = input.systemPromptMode;
		} else {
			throw new Error(`Builtin override '${name}' in '${filePath}' has invalid 'systemPromptMode'; expected 'append' or 'replace'.`);
		}
	}

	if ("inheritProjectContext" in input) {
		if (typeof input.inheritProjectContext === "boolean") {
			override.inheritProjectContext = input.inheritProjectContext;
		} else {
			throw new Error(`Builtin override '${name}' in '${filePath}' has invalid 'inheritProjectContext'; expected a boolean.`);
		}
	}

	if ("inheritSkills" in input) {
		if (typeof input.inheritSkills === "boolean") {
			override.inheritSkills = input.inheritSkills;
		} else {
			throw new Error(`Builtin override '${name}' in '${filePath}' has invalid 'inheritSkills'; expected a boolean.`);
		}
	}

	if ("disabled" in input) {
		if (typeof input.disabled === "boolean") {
			override.disabled = input.disabled;
		} else {
			throw new Error(`Builtin override '${name}' in '${filePath}' has invalid 'disabled'; expected a boolean.`);
		}
	}

	if ("systemPrompt" in input) {
		if (typeof input.systemPrompt === "string") override.systemPrompt = input.systemPrompt;
		else throw new Error(`Builtin override '${name}' in '${filePath}' has invalid 'systemPrompt'; expected a string.`);
	}

	const fallbackModels = parseOverrideStringArrayOrFalse(input.fallbackModels, { filePath, name, field: "fallbackModels" });
	if (fallbackModels !== undefined) override.fallbackModels = fallbackModels;

	const skills = parseOverrideStringArrayOrFalse(input.skills, { filePath, name, field: "skills" });
	if (skills !== undefined) override.skills = skills;

	const tools = parseOverrideStringArrayOrFalse(input.tools, { filePath, name, field: "tools" });
	if (tools !== undefined) override.tools = tools;

	return Object.keys(override).length > 0 ? override : undefined;
}

function readSubagentSettings(filePath: string | null): SubagentSettings {
	if (!filePath) return EMPTY_SUBAGENT_SETTINGS;
	const settings = readSettingsFileStrict(filePath);
	const subagents = settings.subagents;
	if (!subagents || typeof subagents !== "object" || Array.isArray(subagents)) return EMPTY_SUBAGENT_SETTINGS;

	const subagentsObject = subagents as Record<string, unknown>;
	let disableBuiltins: boolean | undefined;
	if ("disableBuiltins" in subagentsObject) {
		if (typeof subagentsObject.disableBuiltins === "boolean") {
			disableBuiltins = subagentsObject.disableBuiltins;
		} else {
			throw new Error(`Subagent settings in '${filePath}' have invalid 'disableBuiltins'; expected a boolean.`);
		}
	}

	const parsed: Record<string, BuiltinAgentOverrideConfig> = {};
	const agentOverrides = subagentsObject.agentOverrides;
	if (!agentOverrides || typeof agentOverrides !== "object" || Array.isArray(agentOverrides)) {
		return { overrides: parsed, disableBuiltins };
	}
	for (const [name, value] of Object.entries(agentOverrides)) {
		const override = parseBuiltinOverrideEntry(name, value, filePath);
		if (override) parsed[name] = override;
	}
	return { overrides: parsed, disableBuiltins };
}

function applyBuiltinOverride(
	agent: AgentConfig,
	override: BuiltinAgentOverrideConfig,
	meta: { scope: "user" | "project"; path: string },
): AgentConfig {
	const next: AgentConfig = {
		...agent,
		override: { ...meta, base: cloneOverrideBase(agent) },
	};

	if (override.model !== undefined) next.model = override.model === false ? undefined : override.model;
	if (override.fallbackModels !== undefined) {
		next.fallbackModels = override.fallbackModels === false ? undefined : [...override.fallbackModels];
	}
	if (override.thinking !== undefined) next.thinking = override.thinking === false ? undefined : override.thinking;
	if (override.systemPromptMode !== undefined) next.systemPromptMode = override.systemPromptMode;
	if (override.inheritProjectContext !== undefined) next.inheritProjectContext = override.inheritProjectContext;
	if (override.inheritSkills !== undefined) next.inheritSkills = override.inheritSkills;
	if (override.disabled !== undefined) next.disabled = override.disabled;
	if (override.systemPrompt !== undefined) next.systemPrompt = override.systemPrompt;
	if (override.skills !== undefined) next.skills = override.skills === false ? undefined : [...override.skills];
	if (override.tools !== undefined) {
		const { tools, mcpDirectTools } = splitToolList(override.tools === false ? [] : override.tools);
		next.tools = tools;
		next.mcpDirectTools = mcpDirectTools;
	}

	return next;
}

function applyBuiltinOverrides(
	builtinAgents: AgentConfig[],
	userSettings: SubagentSettings,
	projectSettings: SubagentSettings,
	userSettingsPath: string,
	projectSettingsPath: string | null,
): AgentConfig[] {
	const projectBulkDisabled = projectSettings.disableBuiltins === true && projectSettingsPath !== null;
	const userBulkDisabled = projectSettings.disableBuiltins === undefined && userSettings.disableBuiltins === true;

	return builtinAgents.map((agent) => {
		const projectOverride = projectSettings.overrides[agent.name];
		if (projectOverride && projectSettingsPath) {
			return applyBuiltinOverride(agent, projectOverride, { scope: "project", path: projectSettingsPath });
		}

		if (projectBulkDisabled && projectSettingsPath) {
			return applyBuiltinOverride(agent, { disabled: true }, { scope: "project", path: projectSettingsPath });
		}

		const userOverride = userSettings.overrides[agent.name];
		if (userOverride) {
			return applyBuiltinOverride(agent, userOverride, { scope: "user", path: userSettingsPath });
		}

		if (userBulkDisabled) {
			return applyBuiltinOverride(agent, { disabled: true }, { scope: "user", path: userSettingsPath });
		}

		return agent;
	});
}

export function buildBuiltinOverrideConfig(
	base: BuiltinAgentOverrideBase,
	draft: Pick<AgentConfig, "model" | "fallbackModels" | "thinking" | "systemPromptMode" | "inheritProjectContext" | "inheritSkills" | "disabled" | "systemPrompt" | "skills" | "tools" | "mcpDirectTools">,
): BuiltinAgentOverrideConfig | undefined {
	const override: BuiltinAgentOverrideConfig = {};

	if (draft.model !== base.model) override.model = draft.model ?? false;
	if (!arraysEqual(draft.fallbackModels, base.fallbackModels)) override.fallbackModels = draft.fallbackModels ? [...draft.fallbackModels] : false;
	if (draft.thinking !== base.thinking) override.thinking = draft.thinking ?? false;
	if (draft.systemPromptMode !== base.systemPromptMode) override.systemPromptMode = draft.systemPromptMode;
	if (draft.inheritProjectContext !== base.inheritProjectContext) override.inheritProjectContext = draft.inheritProjectContext;
	if (draft.inheritSkills !== base.inheritSkills) override.inheritSkills = draft.inheritSkills;
	if (draft.disabled !== base.disabled) override.disabled = draft.disabled ?? false;
	if (draft.systemPrompt !== base.systemPrompt) override.systemPrompt = draft.systemPrompt;
	if (!arraysEqual(draft.skills, base.skills)) override.skills = draft.skills ? [...draft.skills] : false;

	const baseTools = joinToolList(base);
	const draftTools = joinToolList(draft);
	if (!arraysEqual(draftTools, baseTools)) override.tools = draftTools ? [...draftTools] : false;

	return Object.keys(override).length > 0 ? override : undefined;
}

export function saveBuiltinAgentOverride(
	cwd: string,
	name: string,
	scope: "user" | "project",
	override: BuiltinAgentOverrideConfig,
): string {
	const filePath = scope === "project" ? getProjectAgentSettingsPath(cwd) : getUserAgentSettingsPath();
	if (!filePath) throw new Error("Project override is not available here. No project config root was found.");

	const settings = readSettingsFileStrict(filePath);
	const subagents = settings.subagents && typeof settings.subagents === "object" && !Array.isArray(settings.subagents)
		? { ...(settings.subagents as Record<string, unknown>) }
		: {};
	const agentOverrides = subagents.agentOverrides && typeof subagents.agentOverrides === "object" && !Array.isArray(subagents.agentOverrides)
		? { ...(subagents.agentOverrides as Record<string, unknown>) }
		: {};

	agentOverrides[name] = cloneOverrideValue(override);
	subagents.agentOverrides = agentOverrides;
	settings.subagents = subagents;
	writeSettingsFile(filePath, settings);
	return filePath;
}

export function removeBuiltinAgentOverride(cwd: string, name: string, scope: "user" | "project"): string {
	const filePath = scope === "project" ? getProjectAgentSettingsPath(cwd) : getUserAgentSettingsPath();
	if (!filePath) throw new Error("Project override is not available here. No project config root was found.");
	if (!fs.existsSync(filePath)) return filePath;

	const settings = readSettingsFileStrict(filePath);
	const subagents = settings.subagents;
	if (!subagents || typeof subagents !== "object" || Array.isArray(subagents)) return filePath;
	const nextSubagents = { ...(subagents as Record<string, unknown>) };
	const agentOverrides = nextSubagents.agentOverrides;
	if (!agentOverrides || typeof agentOverrides !== "object" || Array.isArray(agentOverrides)) return filePath;

	const nextOverrides = { ...(agentOverrides as Record<string, unknown>) };
	delete nextOverrides[name];
	if (Object.keys(nextOverrides).length > 0) nextSubagents.agentOverrides = nextOverrides;
	else delete nextSubagents.agentOverrides;

	if (Object.keys(nextSubagents).length > 0) settings.subagents = nextSubagents;
	else delete settings.subagents;

	writeSettingsFile(filePath, settings);
	return filePath;
}

function loadAgentsFromDir(dir: string, source: AgentSource): AgentConfig[] {
	const agents: AgentConfig[] = [];

	if (!fs.existsSync(dir)) {
		return agents;
	}

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (entry.name.endsWith(".chain.md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter(content);

		if (!frontmatter.name || !frontmatter.description) {
			continue;
		}

		const rawTools = frontmatter.tools
			?.split(",")
			.map((t) => t.trim())
			.filter(Boolean);

		const mcpDirectTools: string[] = [];
		const tools: string[] = [];
		if (rawTools) {
			for (const tool of rawTools) {
				if (tool.startsWith("mcp:")) {
					mcpDirectTools.push(tool.slice(4));
				} else {
					tools.push(tool);
				}
			}
		}

		const defaultReads = frontmatter.defaultReads
			?.split(",")
			.map((f) => f.trim())
			.filter(Boolean);

		const skillStr = frontmatter.skill || frontmatter.skills;
		const skills = skillStr
			?.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
		const fallbackModels = frontmatter.fallbackModels
			?.split(",")
			.map((model) => model.trim())
			.filter(Boolean);
		const systemPromptMode = frontmatter.systemPromptMode === "replace"
			? "replace"
			: frontmatter.systemPromptMode === "append"
				? "append"
				: defaultSystemPromptMode(frontmatter.name);
		const inheritProjectContext = frontmatter.inheritProjectContext === "true"
			? true
			: frontmatter.inheritProjectContext === "false"
				? false
				: defaultInheritProjectContext(frontmatter.name);
		const inheritSkills = frontmatter.inheritSkills === "true"
			? true
			: frontmatter.inheritSkills === "false"
				? false
				: defaultInheritSkills();

		let extensions: string[] | undefined;
		if (frontmatter.extensions !== undefined) {
			extensions = frontmatter.extensions
				.split(",")
				.map((e) => e.trim())
				.filter(Boolean);
		}

		const extraFields: Record<string, string> = {};
		for (const [key, value] of Object.entries(frontmatter)) {
			if (!KNOWN_FIELDS.has(key)) extraFields[key] = value;
		}

		const parsedMaxSubagentDepth = Number(frontmatter.maxSubagentDepth);

		const surface = normalizePresetAgentSurface(frontmatter.surface) ?? defaultSurface();
		const canDelegate = frontmatter.canDelegate === "true"
			? true
			: frontmatter.canDelegate === "false"
				? false
				: defaultCanDelegate(frontmatter.name);
		const allowedDelegateAgents = frontmatter.allowedDelegateAgents !== undefined
			? frontmatter.allowedDelegateAgents
				.split(",")
				.map((agent) => agent.trim())
				.filter(Boolean)
			: defaultAllowedDelegateAgents(frontmatter.name);
		const disabled = frontmatter.disabled === "true"
			? true
			: frontmatter.disabled === "false"
				? false
				: undefined;

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: tools.length > 0 ? tools : undefined,
			mcpDirectTools: mcpDirectTools.length > 0 ? mcpDirectTools : undefined,
			model: frontmatter.model,
			fallbackModels: fallbackModels && fallbackModels.length > 0 ? fallbackModels : undefined,
			thinking: frontmatter.thinking,
			systemPromptMode,
			inheritProjectContext,
			inheritSkills,
			systemPrompt: body,
			source,
			filePath,
			skills: skills && skills.length > 0 ? skills : undefined,
			extensions,
			output: frontmatter.output,
			defaultReads: defaultReads && defaultReads.length > 0 ? defaultReads : undefined,
			defaultProgress: frontmatter.defaultProgress === "true",
			interactive: frontmatter.interactive === "true",
			maxSubagentDepth:
				Number.isInteger(parsedMaxSubagentDepth) && parsedMaxSubagentDepth >= 0
					? parsedMaxSubagentDepth
					: undefined,
			disabled,
			surface,
			canDelegate,
			allowedDelegateAgents: allowedDelegateAgents && allowedDelegateAgents.length > 0 ? allowedDelegateAgents : undefined,
			extraFields: Object.keys(extraFields).length > 0 ? extraFields : undefined,
		});
	}

	return agents;
}

function loadChainsFromDir(dir: string, source: AgentSource): ChainConfig[] {
	const chains: ChainConfig[] = [];

	if (!fs.existsSync(dir)) {
		return chains;
	}

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return chains;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".chain.md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		try {
			chains.push(parseChain(content, source, filePath));
		} catch {
			continue;
		}
	}

	return chains;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function resolveNearestProjectAgentDirs(cwd: string): { readDirs: string[]; preferredDir: string | null } {
	const projectRoot = findNearestProjectRoot(cwd);
	if (!projectRoot) return { readDirs: [], preferredDir: null };

	const legacyDir = path.join(projectRoot, ".agents");
	const preferredDir = path.join(projectRoot, ".pi", "agents");
	const readDirs: string[] = [];
	if (isDirectory(legacyDir)) readDirs.push(legacyDir);
	if (isDirectory(preferredDir)) readDirs.push(preferredDir);

	return {
		readDirs,
		preferredDir,
	};
}
const BUILTIN_AGENTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "agents");

export function discoverAgents(cwd: string, scope: AgentScope, options?: AgentDiscoveryOptions): AgentDiscoveryResult {
	const userDirOld = path.join(os.homedir(), ".pi", "agent", "agents");
	const userDirNew = path.join(os.homedir(), ".agents");
	const { readDirs: projectAgentDirs, preferredDir: projectAgentsDir } = resolveNearestProjectAgentDirs(cwd);
	const userSettingsPath = getUserAgentSettingsPath();
	const projectSettingsPath = getProjectAgentSettingsPath(cwd);
	const userSettings = scope === "project" ? EMPTY_SUBAGENT_SETTINGS : readSubagentSettings(userSettingsPath);
	const projectSettings = scope === "user" ? EMPTY_SUBAGENT_SETTINGS : readSubagentSettings(projectSettingsPath);

	const builtinAgents = applyBuiltinOverrides(
		loadAgentsFromDir(BUILTIN_AGENTS_DIR, "builtin"),
		userSettings,
		projectSettings,
		userSettingsPath,
		projectSettingsPath,
	);

	const userAgentsOld = scope === "project" ? [] : loadAgentsFromDir(userDirOld, "user");
	const userAgentsNew = scope === "project" ? [] : loadAgentsFromDir(userDirNew, "user");
	const userAgents = [...userAgentsOld, ...userAgentsNew];

	const projectAgents = scope === "user" ? [] : projectAgentDirs.flatMap((dir) => loadAgentsFromDir(dir, "project"));
	const mergedAgents = mergeAgentsForScope(scope, userAgents, projectAgents, builtinAgents);
	const presetApplied = applyPresetOverlays(mergedAgents, options);
	const visibleAgents = presetApplied.agents
		.filter((agent) => agent.disabled !== true)
		.filter((agent) => isVisibleOnSurface(agent, options?.surface));

	return { agents: visibleAgents, projectAgentsDir, preset: presetApplied.preset };
}

export function discoverAgentsAll(cwd: string, options?: AgentDiscoveryOptions): AgentDiscoveryAllResult {
	const userDirOld = path.join(os.homedir(), ".pi", "agent", "agents");
	const userDirNew = path.join(os.homedir(), ".agents");
	const { readDirs: projectDirs, preferredDir: projectDir } = resolveNearestProjectAgentDirs(cwd);
	const userSettingsPath = getUserAgentSettingsPath();
	const projectSettingsPath = getProjectAgentSettingsPath(cwd);
	const userSettings = readSubagentSettings(userSettingsPath);
	const projectSettings = readSubagentSettings(projectSettingsPath);

	const builtinBase = applyBuiltinOverrides(
		loadAgentsFromDir(BUILTIN_AGENTS_DIR, "builtin"),
		userSettings,
		projectSettings,
		userSettingsPath,
		projectSettingsPath,
	);
	const userBase = [
		...loadAgentsFromDir(userDirOld, "user"),
		...loadAgentsFromDir(userDirNew, "user"),
	];
	const projectMap = new Map<string, AgentConfig>();
	for (const dir of projectDirs) {
		for (const agent of loadAgentsFromDir(dir, "project")) {
			projectMap.set(agent.name, agent);
		}
	}
	const projectBase = Array.from(projectMap.values());

	const chainMap = new Map<string, ChainConfig>();
	for (const dir of projectDirs) {
		for (const chain of loadChainsFromDir(dir, "project")) {
			chainMap.set(chain.name, chain);
		}
	}
	const chains = [
		...loadChainsFromDir(userDirOld, "user"),
		...loadChainsFromDir(userDirNew, "user"),
		...Array.from(chainMap.values()),
	];

	const presetBuiltin = applyPresetOverlays(builtinBase, options);
	const presetUser = applyPresetOverlays(userBase, options);
	const presetProject = applyPresetOverlays(projectBase, options);
	// Prefer ~/.pi/agent/agents/ as primary; fall back to ~/.agents/ if only that exists
	const userDir = fs.existsSync(userDirOld) ? userDirOld : fs.existsSync(userDirNew) ? userDirNew : userDirOld;
	const filterBySurface = (agents: AgentConfig[]) => agents
		.filter((agent) => isVisibleOnSurface(agent, options?.surface));

	return {
		builtin: filterBySurface(presetBuiltin.agents),
		user: filterBySurface(presetUser.agents),
		project: filterBySurface(presetProject.agents),
		chains,
		userDir,
		projectDir,
		userSettingsPath,
		projectSettingsPath,
		preset: presetBuiltin.preset,
	};
}
