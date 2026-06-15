import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type AgentConfig, discoverAgents } from "../shared/agents.ts";
import { resolveToolPatterns } from "../dispatch/resolve-tool-patterns.ts";
import { selectRootRole } from "../shared/root-role-selection.ts";
import type { ExtensionConfig, SubagentState } from "../protocol/types.ts";

export interface RootRoleManager {
	initializeRootRole(ctx: ExtensionContext): Promise<void>;
	getActiveRootRoleName(): string | undefined;
	getActiveRootRoleSystemPrompt(): string | undefined;
	isDelegatedSubagentSession(): boolean;
	resetRoleState(): void;
	registerRoleCommand(): void;
}

export function createRootRoleManager(deps: {
	pi: ExtensionAPI;
	config: ExtensionConfig;
	state: SubagentState;
	setHostCurrentAgent: (name: string) => void;
	notify: (ctx: ExtensionContext, message: string, level?: "info" | "warning" | "error") => void;
	normalizeName: (value: unknown) => string | undefined;
	getLatestCustomStateName: (ctx: ExtensionContext, ...customTypes: string[]) => string | undefined;
}): RootRoleManager {
	const { pi, config, state, setHostCurrentAgent, notify, normalizeName, getLatestCustomStateName } = deps;

	let activeWorkflowName: string | undefined;
	let activeRootRoleName: string | undefined;
	let activeRootRole: AgentConfig | undefined;

	const settingsPath = path.join(os.homedir(), ".pi", "agent", "settings.json");
	const runtimePresetSettingKeys = ["defaultProvider", "defaultModel", "defaultThinkingLevel"] as const;

	function readSettingsFile(): Record<string, unknown> | undefined {
		try {
			return JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
		} catch {
			return undefined;
		}
	}

	function restoreRuntimePresetSettings(before: Record<string, unknown> | undefined): void {
		if (!before) return;
		const after = readSettingsFile();
		if (!after) return;

		let changed = false;
		for (const key of runtimePresetSettingKeys) {
			if (before[key] === undefined) {
				if (key in after) {
					delete after[key];
					changed = true;
				}
				continue;
			}
			if (after[key] !== before[key]) {
				after[key] = before[key];
				changed = true;
			}
		}

		if (changed) fs.writeFileSync(settingsPath, `${JSON.stringify(after, null, 2)}\n`);
	}

	async function withRuntimePresetSettingsPreserved<T>(action: () => Promise<T> | T): Promise<T> {
		const before = readSettingsFile();
		try {
			return await action();
		} finally {
			restoreRuntimePresetSettings(before);
		}
	}

	function isDelegatedSubagentSession(): boolean {
		const runtimeMode = normalizeName(process.env.PI_SUBAGENT_RUNTIME_MODE);
		if (runtimeMode === "delegated") return true;
		if (runtimeMode === "root") return false;
		return Boolean(normalizeName(process.env.PI_SUBAGENT_CURRENT_AGENT));
	}

	function resolveRequestedWorkflow(): string | undefined {
		return (
			normalizeName(pi.getFlag("preset")) ??
			normalizeName(process.env.PI_PRESET) ??
			normalizeName(process.env.OH_MY_OPENCODE_SLIM_PRESET) ??
			normalizeName(config.defaultPreset)
		);
	}

	function resolveRootRoleCandidatesForCwd(
		cwd: string,
		preset: string | undefined,
	): { availableRoles: AgentConfig[]; warnings: string[]; defaultRole?: string; appliedWorkflow?: string } {
		const discovery = discoverAgents(cwd, "both", { preset, config, surface: "main" });
		return {
			availableRoles: discovery.agents,
			warnings: discovery.preset.warnings,
			defaultRole: discovery.preset.defaultRole,
			appliedWorkflow: discovery.preset.applied,
		};
	}

	function resolveRootRoleCandidates(
		ctx: ExtensionContext,
		preset: string | undefined,
	): { availableRoles: AgentConfig[]; warnings: string[]; defaultRole?: string; appliedWorkflow?: string } {
		return resolveRootRoleCandidatesForCwd(ctx.cwd, preset);
	}

	function getRootRoleCompletions(prefix: string): Array<{ value: string; label: string }> | null {
		if (isDelegatedSubagentSession()) return null;
		if (prefix.includes(" ")) return null;
		const workflowName = activeWorkflowName ?? resolveRequestedWorkflow();
		const cwd = state.lastUiContext?.cwd ?? state.baseCwd;
		const { availableRoles } = resolveRootRoleCandidatesForCwd(cwd, workflowName);
		const normalizedPrefix = prefix.trim();
		const matches = normalizedPrefix
			? availableRoles.filter((role) => role.name.startsWith(normalizedPrefix))
			: availableRoles;
		return matches.map((role) => ({
			value: role.name,
			label: role.name === activeRootRoleName ? `${role.name} (current)` : role.name,
		}));
	}

	async function applyRootModel(ctx: ExtensionContext, modelRef: string | undefined): Promise<void> {
		const normalizedModel = normalizeName(modelRef);
		if (!normalizedModel) return;
		const slashIdx = normalizedModel.indexOf("/");
		const model =
			slashIdx === -1
				? ctx.modelRegistry.getAvailable().find((candidate) => candidate.id === normalizedModel)
				: ctx.modelRegistry.find(
						normalizedModel.substring(0, slashIdx),
						normalizedModel.substring(slashIdx + 1),
					);
		if (!model) {
			notify(
				ctx,
				`Role '${activeRootRoleName ?? "unknown"}': model '${normalizedModel}' was not found`,
				"warning",
			);
			return;
		}
		const success = await withRuntimePresetSettingsPreserved(() => pi.setModel(model));
		if (!success) {
			notify(
				ctx,
				`Role '${activeRootRoleName ?? "unknown"}': no API key for ${model.provider}/${model.id}`,
				"warning",
			);
		}
	}

	function applyRootThinking(role: AgentConfig): void {
		if (!role.thinking) return;
		if (["off", "minimal", "low", "medium", "high", "xhigh"].includes(role.thinking)) {
			void withRuntimePresetSettingsPreserved(() =>
				pi.setThinkingLevel(role.thinking as "off" | "minimal" | "low" | "medium" | "high" | "xhigh"),
			);
		}
	}

	function applyRootTools(ctx: ExtensionContext, role: AgentConfig): void {
		const requestedTools = [...new Set([...(role.tools ?? []), ...(role.mcpDirectTools ?? [])])];
		if (requestedTools.length === 0) return;
		const availableNames = pi.getAllTools().map((t) => t.name);
		const resolved = resolveToolPatterns(requestedTools, availableNames);
		const availableSet = new Set(availableNames);
		const unknown = resolved.filter((t) => !availableSet.has(t));
		if (unknown.length > 0) {
			notify(ctx, `Role '${role.name}': unknown tools: ${unknown.join(", ")}`, "warning");
		}
		if (resolved.length > 0) {
			pi.setActiveTools(resolved);
		}
	}

	function updateRootStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(
			"preset",
			activeWorkflowName ? ctx.ui.theme.fg("accent", `preset:${activeWorkflowName}`) : undefined,
		);
		ctx.ui.setStatus(
			"role",
			activeRootRoleName ? ctx.ui.theme.fg("accent", `role:${activeRootRoleName}`) : undefined,
		);
	}

	async function activateRootRole(
		ctx: ExtensionContext,
		role: AgentConfig,
		workflowName: string | undefined,
	): Promise<void> {
		const previousWorkflowName = activeWorkflowName;
		const previousRootRoleName = activeRootRoleName;
		activeWorkflowName = workflowName;
		activeRootRoleName = role.name;
		activeRootRole = role;
		setHostCurrentAgent(role.name);
		if (previousRootRoleName !== role.name || previousWorkflowName !== workflowName) {
			pi.appendEntry("role-state", { name: role.name, workflow: workflowName });
		}
		await applyRootModel(ctx, role.model);
		applyRootThinking(role);
		applyRootTools(ctx, role);
		updateRootStatus(ctx);
	}

	async function initializeRootRole(ctx: ExtensionContext): Promise<void> {
		const requestedWorkflow = resolveRequestedWorkflow();
		const { availableRoles, warnings, defaultRole, appliedWorkflow } = resolveRootRoleCandidates(
			ctx,
			requestedWorkflow,
		);
		for (const warning of warnings) notify(ctx, warning, "warning");
		if (availableRoles.length === 0) {
			notify(ctx, "No main roles are available for the current workflow.", "warning");
			activeWorkflowName = undefined;
			activeRootRoleName = undefined;
			activeRootRole = undefined;
			updateRootStatus(ctx);
			return;
		}

		const roleFlag = normalizeName(pi.getFlag("role"));
		const envRole = normalizeName(process.env.PI_ROLE);
		const restoredRole = getLatestCustomStateName(ctx, "role-state");
		const requestedRole = roleFlag ?? envRole ?? restoredRole ?? defaultRole;
		const selectedRole = selectRootRole(availableRoles, { roleFlag, envRole, restoredRole, defaultRole });

		if (!selectedRole) {
			notify(
				ctx,
				`Unable to resolve a main role. Available: ${availableRoles.map((role) => role.name).join(", ")}`,
				"warning",
			);
			return;
		}
		if (requestedRole && selectedRole.name !== requestedRole) {
			notify(
				ctx,
				`Role '${requestedRole}' is not available in this workflow. Using '${selectedRole.name}' instead.`,
				"warning",
			);
		}
		await activateRootRole(ctx, selectedRole, appliedWorkflow ?? requestedWorkflow);
	}

	async function switchRootRole(ctx: ExtensionContext, requestedRole: string): Promise<boolean> {
		const normalizedRole = normalizeName(requestedRole);
		if (!normalizedRole) return false;
		const workflowName = activeWorkflowName ?? resolveRequestedWorkflow();
		const { availableRoles, warnings, appliedWorkflow } = resolveRootRoleCandidates(ctx, workflowName);
		for (const warning of warnings) notify(ctx, warning, "warning");
		const role = availableRoles.find((candidate) => candidate.name === normalizedRole);
		if (!role) {
			notify(
				ctx,
				`Unknown main role '${requestedRole}'. Available: ${availableRoles.map((candidate) => candidate.name).join(", ") || "(none)"}`,
				"error",
			);
			return false;
		}
		await activateRootRole(ctx, role, appliedWorkflow ?? workflowName);
		return true;
	}

	return {
		initializeRootRole,
		getActiveRootRoleName: () => activeRootRoleName,
		getActiveRootRoleSystemPrompt: () => activeRootRole?.systemPrompt?.trim(),
		isDelegatedSubagentSession,
		resetRoleState: () => {
			activeWorkflowName = undefined;
			activeRootRoleName = undefined;
			activeRootRole = undefined;
		},
		registerRoleCommand: () => {
			pi.registerCommand("role", {
				description: "Show or switch the active root role",
				getArgumentCompletions: getRootRoleCompletions,
				handler: async (args, ctx) => {
					if (isDelegatedSubagentSession()) {
						notify(ctx, "'/role' is only available in the main/root session.", "warning");
						return;
					}
					const requested = normalizeName(args);
					if (!requested) {
						const workflowName = activeWorkflowName ?? resolveRequestedWorkflow();
						const { availableRoles, warnings, appliedWorkflow } = resolveRootRoleCandidates(
							ctx,
							workflowName,
						);
						for (const warning of warnings) notify(ctx, warning, "warning");
						if (availableRoles.length === 0) {
							notify(ctx, "No main roles are available for the current workflow.", "warning");
							return;
						}
						if (!ctx.hasUI) {
							notify(
								ctx,
								`Root role: ${activeRootRoleName ?? "(none)"}. Workflow: ${appliedWorkflow ?? workflowName ?? "(default)"}. Available: ${availableRoles.map((role) => role.name).join(", ") || "(none)"}`,
								"info",
							);
							return;
						}
						const selectedRole = await ctx.ui.select(
							`Root role (${appliedWorkflow ?? workflowName ?? "default"}; current: ${activeRootRoleName ?? "none"})`,
							availableRoles.map((role) => role.name),
						);
						if (!selectedRole) return;
						const changed = await switchRootRole(ctx, selectedRole);
						if (changed) notify(ctx, `Root role '${selectedRole}' activated`, "info");
						return;
					}
					const changed = await switchRootRole(ctx, requested);
					if (changed) notify(ctx, `Root role '${requested}' activated`, "info");
				},
			});
		},
	};
}
