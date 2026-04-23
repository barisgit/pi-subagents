/**
 * Subagent Tool
 *
 * Full-featured subagent with sync and async modes.
 * - Sync (default): Streams output, renders markdown, tracks usage
 * - Async: Background execution, emits events when done
 *
 * Modes: single (agent + task), parallel (tasks[]), chain (chain[] with {previous})
 * Toggle: async parameter (default: false, configurable via config.json)
 *
 * Config file: ~/.pi/agent/extensions/subagent/config.json
 *   { "asyncByDefault": true, "forceTopLevelAsync": true, "maxSubagentDepth": 1, "intercomBridge": { "mode": "always", "instructionFile": "./intercom-bridge.md" }, "worktreeSetupHook": "./scripts/setup-worktree.mjs" }
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { type ExtensionAPI, type ExtensionContext, type ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Box, Container, Spacer, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@mariozechner/pi-tui";
import { type AgentConfig, discoverAgents } from "./agents.ts";
import { cleanupAllArtifactDirs, cleanupOldArtifacts, getArtifactsDir } from "./artifacts.ts";
import { cleanupOldChainDirs } from "./settings.ts";
import { renderWidget, renderSubagentResult, stopResultAnimations, stopWidgetAnimation, syncResultAnimation } from "./render.ts";
import { StatusParams, SubagentParams } from "./schemas.ts";
import { createSubagentExecutor } from "./subagent-executor.ts";
import { createAsyncJobTracker } from "./async-job-tracker.ts";
import { controlNotificationKey, formatControlNoticeMessage } from "./subagent-control.ts";
import { createResultWatcher } from "./result-watcher.ts";
import { registerSlashCommands } from "./slash-commands.ts";
import { registerPromptTemplateDelegationBridge } from "./prompt-template-bridge.ts";
import { registerSlashSubagentBridge } from "./slash-bridge.ts";
import { clearSlashSnapshots, getSlashRenderableSnapshot, resolveSlashMessageDetails, restoreSlashFinalSnapshots, type SlashMessageDetails } from "./slash-live-state.ts";
import { inspectSubagentStatus } from "./run-status.ts";
import { formatAsyncRunList, listAsyncRuns } from "./async-status.ts";
import registerSubagentNotify, { type SubagentNotifyDetails } from "./notify.ts";
import { formatDuration, shortenPath } from "./formatters.ts";
import { findByPrefix, readStatus } from "./utils.ts";
import {
	type ControlEvent,
	type Details,
	type ExtensionConfig,
	type SubagentState,
	ASYNC_DIR,
	DEFAULT_ARTIFACT_CONFIG,
	RESULTS_DIR,
	SLASH_RESULT_TYPE,
	SUBAGENT_ASYNC_COMPLETE_EVENT,
	SUBAGENT_ASYNC_STARTED_EVENT,
	SUBAGENT_CONTROL_EVENT,
	WIDGET_KEY,
} from "./types.ts";
import { configureXmlStripping } from "./utils.ts";

/**
 * Derive subagent session base directory from parent session file.
 * If parent session is ~/.pi/agent/sessions/abc123.jsonl,
 * returns ~/.pi/agent/sessions/abc123/ as the base.
 * Callers add runId to create the actual session root: abc123/{runId}/
 * Falls back to a unique temp directory if no parent session.
 */
function getSubagentSessionRoot(parentSessionFile: string | null): string {
	if (parentSessionFile) {
		const baseName = path.basename(parentSessionFile, ".jsonl");
		const sessionsDir = path.dirname(parentSessionFile);
		return path.join(sessionsDir, baseName);
	}
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-session-"));
}

function loadConfig(): ExtensionConfig {
	const configPath = path.join(os.homedir(), ".pi", "agent", "extensions", "subagent", "config.json");
	try {
		if (fs.existsSync(configPath)) {
			return JSON.parse(fs.readFileSync(configPath, "utf-8")) as ExtensionConfig;
		}
	} catch (error) {
		console.error(`Failed to load subagent config from '${configPath}':`, error);
	}
	return {};
}

function expandTilde(p: string): string {
	return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

/**
 * Create a directory and verify it is actually accessible.
 * On Windows with Azure AD/Entra ID, directories created shortly after
 * wake-from-sleep can end up with broken NTFS ACLs (null DACL) when the
 * cloud SID cannot be resolved without network connectivity. This leaves
 * the directory completely inaccessible to the creating user.
 */
function ensureAccessibleDir(dirPath: string): void {
	fs.mkdirSync(dirPath, { recursive: true });
	try {
		fs.accessSync(dirPath, fs.constants.R_OK | fs.constants.W_OK);
	} catch {
		try {
			fs.rmSync(dirPath, { recursive: true, force: true });
		} catch {
			// Best effort: retry mkdir/access even if cleanup fails.
		}
		fs.mkdirSync(dirPath, { recursive: true });
		fs.accessSync(dirPath, fs.constants.R_OK | fs.constants.W_OK);
	}
}

function isSlashResultRunning(result: { details?: Details }): boolean {
	return result.details?.progress?.some((entry) => entry.status === "running")
		|| result.details?.results.some((entry) => entry.progress?.status === "running")
		|| false;
}

function isSlashResultError(result: { details?: Details }): boolean {
	return result.details?.results.some((entry) => entry.exitCode !== 0 && entry.progress?.status !== "running") || false;
}

function normalizeName(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed || undefined;
}

function getLatestCustomStateName(ctx: ExtensionContext, ...customTypes: string[]): string | undefined {
	let latest: string | undefined;
	for (const entry of ctx.sessionManager.getEntries()) {
		if (!entry || typeof entry !== "object") continue;
		const candidate = entry as { type?: string; customType?: string; data?: { name?: unknown } };
		if (candidate.type !== "custom" || !customTypes.includes(candidate.customType ?? "")) continue;
		if (typeof candidate.data?.name === "string" && candidate.data.name.trim()) {
			latest = candidate.data.name.trim();
		}
	}
	return latest;
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(message, level);
	else if (level !== "info") console.warn(message);
}

function rebuildSlashResultContainer(
	container: Container,
	result: AgentToolResult<Details>,
	options: { expanded: boolean },
	theme: ExtensionContext["ui"]["theme"],
): void {
	container.clear();
	container.addChild(new Spacer(1));
	const boxTheme = isSlashResultRunning(result) ? "toolPendingBg" : isSlashResultError(result) ? "toolErrorBg" : "toolSuccessBg";
	const box = new Box(1, 1, (text: string) => theme.bg(boxTheme, text));
	box.addChild(renderSubagentResult(result, options, theme));
	container.addChild(box);
}

function createSlashResultComponent(
	details: SlashMessageDetails,
	options: { expanded: boolean },
	theme: ExtensionContext["ui"]["theme"],
	requestRender: () => void,
): Container {
	const container = new Container();
	const animationState: { subagentResultAnimationTimer?: ReturnType<typeof setInterval> } = {};
	let lastVersion = -1;
	container.render = (width: number): string[] => {
		const snapshot = getSlashRenderableSnapshot(details);
		syncResultAnimation(snapshot.result, { state: animationState, invalidate: requestRender });
		if (snapshot.version !== lastVersion || isSlashResultRunning(snapshot.result)) {
			lastVersion = snapshot.version;
			rebuildSlashResultContainer(container, snapshot.result, options, theme);
		}
		return Container.prototype.render.call(container, width);
	};
	return container;
}

const SUBAGENT_CONTROL_MESSAGE_TYPE = "subagent_control_notice";

interface SubagentControlMessageDetails {
	event: ControlEvent;
	source?: "foreground" | "async";
	asyncDir?: string;
	childIntercomTarget?: string;
	noticeText?: string;
}

function controlNoticeTarget(details: SubagentControlMessageDetails): string | undefined {
	return details.childIntercomTarget;
}

function formatSubagentControlNotice(details: SubagentControlMessageDetails, content?: string): string {
	return details.noticeText ?? content ?? formatControlNoticeMessage(details.event, controlNoticeTarget(details));
}

function parseSubagentNotifyContent(content: string): SubagentNotifyDetails | undefined {
	const lines = content.split("\n");
	const header = lines[0] ?? "";
	const match = header.match(/^Background task (completed|failed|paused): \*\*(.+?)\*\*(?:\s+(\([^)]*\)))?$/);
	if (!match) return undefined;
	const body = lines.slice(2);
	let sessionIndex = -1;
	for (let i = body.length - 1; i >= 1; i--) {
		if (body[i - 1]?.trim() === "" && /^(Session|Session file|Session share error):\s+/.test(body[i]!)) {
			sessionIndex = i;
			break;
		}
	}
	const sessionLine = sessionIndex >= 0 ? body[sessionIndex] : undefined;
	const resultLines = sessionIndex >= 0 ? body.slice(0, sessionIndex) : body;
	const resultPreview = resultLines.join("\n").trim() || "(no output)";
	let sessionLabel: string | undefined;
	let sessionValue: string | undefined;
	if (sessionLine) {
		const separator = sessionLine.indexOf(":");
		sessionLabel = sessionLine.slice(0, separator).toLowerCase();
		sessionValue = sessionLine.slice(separator + 1).trim();
	}
	return {
		agent: match[2]!,
		status: match[1] as SubagentNotifyDetails["status"],
		...(match[3] ? { taskInfo: match[3] } : {}),
		resultPreview,
		...(sessionLabel && sessionValue ? { sessionLabel, sessionValue } : {}),
	};
}

class SubagentControlNoticeComponent implements Component {
	constructor(
		private readonly details: SubagentControlMessageDetails,
		private readonly theme: ExtensionContext["ui"]["theme"],
	) {}

	invalidate(): void {}

	render(width: number): string[] {
		const eventLabel = this.details.event.type.replaceAll("_", " ");
		if (width < 3) return [truncateToWidth(`Subagent ${eventLabel}`, width)];
		const bodyWidth = Math.max(1, Math.min(width - 2, 68));
		const borderChar = "─";
		const header = ` ⚠ Subagent ${eventLabel}: ${this.details.event.agent} `;
		const headerText = truncateToWidth(header, bodyWidth, "");
		const headerPadding = Math.max(0, bodyWidth - visibleWidth(headerText));
		const lines = [this.theme.fg("accent", `╭${headerText}${borderChar.repeat(headerPadding)}╮`)];

		for (const line of wrapTextWithAnsi(formatSubagentControlNotice(this.details), bodyWidth)) {
			const text = truncateToWidth(line, bodyWidth, "");
			const padding = Math.max(0, bodyWidth - visibleWidth(text));
			lines.push(this.theme.fg("accent", `│${text}${" ".repeat(padding)}│`));
		}
		lines.push(this.theme.fg("accent", `╰${borderChar.repeat(bodyWidth)}╯`));
		return lines;
	}
}

export default function registerSubagentExtension(pi: ExtensionAPI): void {
	const globalStore = globalThis as Record<string, unknown>;
	const runtimeCleanupStoreKey = "__piSubagentRuntimeCleanup";
	const previousRuntimeCleanup = globalStore[runtimeCleanupStoreKey];
	if (typeof previousRuntimeCleanup === "function") {
		try {
			previousRuntimeCleanup();
		} catch {
			// Best effort cleanup for stale timers from an older reload.
		}
	}

	ensureAccessibleDir(RESULTS_DIR);
	ensureAccessibleDir(ASYNC_DIR);
	cleanupOldChainDirs();

	const config = loadConfig();
	configureXmlStripping(config.stripXmlTags);
	const asyncByDefault = config.asyncByDefault === true;
	const tempArtifactsDir = getArtifactsDir(null);
	cleanupAllArtifactDirs(DEFAULT_ARTIFACT_CONFIG.cleanupDays);

	const state: SubagentState = {
		baseCwd: process.cwd(),
		currentSessionId: null,
		asyncJobs: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: {
			schedule: () => false,
			clear: () => {},
		},
	};

	const { startResultWatcher, primeExistingResults, stopResultWatcher } = createResultWatcher(
		pi,
		state,
		RESULTS_DIR,
		10 * 60 * 1000,
	);
	startResultWatcher();
	primeExistingResults();

	const runtimeCleanup = () => {
		stopWidgetAnimation();
		stopResultAnimations();
		if (state.poller) {
			clearInterval(state.poller);
			state.poller = null;
		}
	};
	globalStore[runtimeCleanupStoreKey] = runtimeCleanup;

	const { ensurePoller, handleStarted, handleComplete, resetJobs } = createAsyncJobTracker(pi, state, ASYNC_DIR);
	const executor = createSubagentExecutor({
		pi,
		state,
		config,
		asyncByDefault,
		tempArtifactsDir,
		getSubagentSessionRoot,
		expandTilde,
		discoverAgents: (cwd, scope, options) => discoverAgents(cwd, scope, { ...options, config }),
		getActiveRootRoleName: () => activeRootRoleName,
	});

	pi.registerMessageRenderer<SlashMessageDetails>(SLASH_RESULT_TYPE, (message, options, theme) => {
		const details = resolveSlashMessageDetails(message.details);
		if (!details) return undefined;
		return createSlashResultComponent(details, options, theme, () => state.lastUiContext?.ui.requestRender?.());
	});

	pi.registerMessageRenderer<SubagentNotifyDetails>("subagent-notify", (message, options, theme) => {
		const content = typeof message.content === "string" ? message.content : "";
		const details = (message.details as SubagentNotifyDetails | undefined) ?? parseSubagentNotifyContent(content);
		if (!details) return new Text(content, 0, 0);
		const icon = details.status === "completed"
			? theme.fg("success", "✓")
			: details.status === "paused"
				? theme.fg("warning", "■")
				: theme.fg("error", "✗");
		const parts: string[] = [];
		if (details.taskInfo) parts.push(details.taskInfo);
		if (details.durationMs !== undefined) parts.push(formatDuration(details.durationMs));
		let text = `${icon} ${theme.bold(details.agent)} ${theme.fg("dim", details.status)}`;
		if (parts.length > 0) text += ` ${theme.fg("dim", "·")} ${parts.map((part) => theme.fg("dim", part)).join(` ${theme.fg("dim", "·")} `)}`;
		const trimmedPreview = details.resultPreview.trim();
		const previewLines = options.expanded
			? trimmedPreview.split("\n").filter((line) => line.trim())
			: [trimmedPreview.split("\n", 1)[0] ?? ""].filter((line) => line.trim());
		for (const line of previewLines.length > 0 ? previewLines : ["(no output)"]) {
			text += `\n  ${theme.fg("dim", `⎿  ${line}`)}`;
		}
		if (!options.expanded && trimmedPreview.includes("\n")) {
			text += `\n  ${theme.fg("dim", "Ctrl+O full notification")}`;
		}
		if (details.sessionLabel && details.sessionValue) {
			text += `\n  ${theme.fg("muted", `${details.sessionLabel}: ${shortenPath(details.sessionValue)}`)}`;
		}
		return new Text(text, 0, 0);
	});

	pi.registerMessageRenderer<SubagentControlMessageDetails>(SUBAGENT_CONTROL_MESSAGE_TYPE, (message, _options, theme) => {
		const details = message.details as SubagentControlMessageDetails | undefined;
		if (!details?.event) return undefined;
		const content = typeof message.content === "string" ? message.content : undefined;
		return new SubagentControlNoticeComponent({ ...details, noticeText: formatSubagentControlNotice(details, content) }, theme);
	});

	const slashBridge = registerSlashSubagentBridge({
		events: pi.events,
		getContext: () => state.lastUiContext,
		execute: (id, params, signal, onUpdate, ctx) =>
			executor.execute(id, params, signal, onUpdate, ctx),
	});

	const promptTemplateBridge = registerPromptTemplateDelegationBridge({
		events: pi.events,
		getContext: () => state.lastUiContext,
		execute: async (requestId, request, signal, ctx, onUpdate) => {
			if (request.tasks && request.tasks.length > 0) {
				return executor.execute(
					requestId,
					{
						tasks: request.tasks,
						context: request.context,
						cwd: request.cwd,
						worktree: request.worktree,
						async: false,
						clarify: false,
					},
					signal,
					onUpdate,
					ctx,
				);
			}
			return executor.execute(
				requestId,
				{
					agent: request.agent,
					task: request.task,
					context: request.context,
					cwd: request.cwd,
					model: request.model,
					async: false,
					clarify: false,
				},
				signal,
				onUpdate,
				ctx,
			);
		},
	});

	let activeWorkflowName: string | undefined;
	let activeRootRoleName: string | undefined;
	let activeRootRole: AgentConfig | undefined;

	function isDelegatedSubagentSession(): boolean {
		const runtimeMode = normalizeName(process.env.PI_SUBAGENT_RUNTIME_MODE);
		if (runtimeMode === "delegated") return true;
		if (runtimeMode === "root") return false;
		return Boolean(normalizeName(process.env.PI_SUBAGENT_CURRENT_AGENT));
	}

	function resolveRequestedWorkflow(): string | undefined {
		return normalizeName(pi.getFlag("preset"))
			?? normalizeName(process.env.PI_PRESET)
			?? normalizeName(process.env.OH_MY_OPENCODE_SLIM_PRESET)
			?? normalizeName(config.defaultPreset);
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
		const model = ctx.modelRegistry.getAvailable().find((candidate) =>
			`${candidate.provider}/${candidate.id}` === normalizedModel || candidate.id === normalizedModel
		);
		if (!model) {
			notify(ctx, `Role '${activeRootRoleName ?? "unknown"}': model '${normalizedModel}' was not found`, "warning");
			return;
		}
		const success = await pi.setModel(model);
		if (!success) {
			notify(ctx, `Role '${activeRootRoleName ?? "unknown"}': no API key for ${model.provider}/${model.id}`, "warning");
		}
	}

	function applyRootThinking(role: AgentConfig): void {
		if (!role.thinking) return;
		if (["off", "minimal", "low", "medium", "high", "xhigh"].includes(role.thinking)) {
			pi.setThinkingLevel(role.thinking as "off" | "minimal" | "low" | "medium" | "high" | "xhigh");
		}
	}

	function applyRootTools(ctx: ExtensionContext, role: AgentConfig): void {
		const requestedTools = [...new Set([...(role.tools ?? []), ...(role.mcpDirectTools ?? [])])];
		if (requestedTools.length === 0) return;
		const availableTools = new Set(pi.getAllTools().map((tool) => tool.name));
		const validTools = requestedTools.filter((tool) => availableTools.has(tool));
		const invalidTools = requestedTools.filter((tool) => !availableTools.has(tool));
		if (invalidTools.length > 0) {
			notify(ctx, `Role '${role.name}': unknown tools: ${invalidTools.join(", ")}`, "warning");
		}
		if (validTools.length > 0) {
			pi.setActiveTools(validTools);
		}
	}

	function updateRootStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus("preset", activeWorkflowName ? ctx.ui.theme.fg("accent", `preset:${activeWorkflowName}`) : undefined);
		ctx.ui.setStatus("role", activeRootRoleName ? ctx.ui.theme.fg("accent", `role:${activeRootRoleName}`) : undefined);
	}

	async function activateRootRole(ctx: ExtensionContext, role: AgentConfig, workflowName: string | undefined): Promise<void> {
		activeWorkflowName = workflowName;
		activeRootRoleName = role.name;
		activeRootRole = role;
		await applyRootModel(ctx, role.model);
		applyRootThinking(role);
		applyRootTools(ctx, role);
		updateRootStatus(ctx);
	}

	async function initializeRootRole(ctx: ExtensionContext): Promise<void> {
		const requestedWorkflow = resolveRequestedWorkflow();
		const { availableRoles, warnings, defaultRole, appliedWorkflow } = resolveRootRoleCandidates(ctx, requestedWorkflow);
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
		const requestedRole = roleFlag ?? envRole ?? restoredRole ?? defaultRole ?? "orchestrator";
		const candidates = [requestedRole, defaultRole, "orchestrator", availableRoles[0]?.name].filter((value): value is string => Boolean(value));
		const selectedRole = candidates
			.map((candidate) => availableRoles.find((role) => role.name === candidate))
			.find((role): role is AgentConfig => Boolean(role));

		if (!selectedRole) {
			notify(ctx, `Unable to resolve a main role. Available: ${availableRoles.map((role) => role.name).join(", ")}`, "warning");
			return;
		}
		if (requestedRole && selectedRole.name !== requestedRole) {
			notify(ctx, `Role '${requestedRole}' is not available in this workflow. Using '${selectedRole.name}' instead.`, "warning");
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
			notify(ctx, `Unknown main role '${requestedRole}'. Available: ${availableRoles.map((candidate) => candidate.name).join(", ") || "(none)"}`, "error");
			return false;
		}
		await activateRootRole(ctx, role, appliedWorkflow ?? workflowName);
		return true;
	}

	function effectiveParallelTaskCount(tasks: Array<{ count?: unknown }> | undefined): number {
		if (!tasks || tasks.length === 0) return 0;
		return tasks.reduce((total, task) => {
			const count = typeof task.count === "number" && Number.isInteger(task.count) && task.count >= 1 ? task.count : 1;
			return total + count;
		}, 0);
	}

	const tool: ToolDefinition<typeof SubagentParams, Details> = {
		name: "subagent",
		label: "Subagent",
		promptSnippet: "Delegate to subagents or manage agent definitions",
		description: `Delegate to subagents or manage agent definitions.

EXECUTION (use exactly ONE mode):
• Before executing, use { action: "list" } to inspect configured agents/chains. Only execute agents listed as executable/non-disabled.
• SINGLE: { agent, task? } - one task; omit task for self-contained agents
• CHAIN: { chain: [{agent:"agent-a"}, {parallel:[{agent:"agent-b",count:3}]}] } - sequential pipeline with optional parallel fan-out
• PARALLEL: { tasks: [{agent,task,count?}, ...], concurrency?: number, worktree?: true } - concurrent execution (worktree: isolate each task in a git worktree)
• Optional context: { context: "fresh" | "fork" } (default: "fresh")
• Optional preset: { preset: "name" } - preset-aware discovery/routing (explicit param > PI_PRESET > OH_MY_OPENCODE_SLIM_PRESET > config default)

CHAIN TEMPLATE VARIABLES (use in task strings):
• {task} - The original task/request from the user
• {previous} - Text response from the previous step (empty for first step)
• {chain_dir} - Shared directory for chain files (e.g., <tmpdir>/pi-subagents-<scope>/chain-runs/abc123/)

Nested guardrails:
• Root calls remain allowed
• Nested calls are only allowed from agents marked canDelegate
• Allowed nested child agents come from the current agent's allowedDelegateAgents capability when set
• Legacy orchestrator/delegate behavior remains the fallback when no explicit capability env is present

Example: { chain: [{agent:"scout", task:"Analyze {task}"}, {agent:"planner", task:"Plan based on {previous}"}] }

MANAGEMENT (use action field, omit agent/task/chain/tasks):
• { action: "list" } - discover executable agents/chains and any disabled builtins
• { action: "get", agent: "name" } - full detail
• { action: "create", config: { name, systemPrompt, systemPromptMode, inheritProjectContext, inheritSkills, ... } }
• { action: "update", agent: "name", config: { ... } } - merge
• { action: "delete", agent: "name" }
• Use chainName for chain operations

CONTROL:
• { action: "status", id: "..." } - inspect an async/background run by id or prefix
• { action: "interrupt", id?: "..." } - soft-interrupt the current child turn and leave the run paused`,
		parameters: SubagentParams,

		execute(id, params, signal, onUpdate, ctx) {
			return executor.execute(id, params, signal, onUpdate, ctx);
		},

		renderCall(args, theme) {
			if (args.action) {
				const target = args.agent || args.chainName || "";
				return new Text(
					`${theme.fg("toolTitle", theme.bold("subagent "))}${args.action}${target ? ` ${theme.fg("accent", target)}` : ""}`,
					0, 0,
				);
			}
			const isParallel = (args.tasks?.length ?? 0) > 0;
			const parallelCount = effectiveParallelTaskCount(args.tasks as Array<{ count?: unknown }> | undefined);
			const asyncLabel = args.async === true && !isParallel ? theme.fg("warning", " [async]") : "";
			if (args.chain?.length)
				return new Text(
					`${theme.fg("toolTitle", theme.bold("subagent "))}chain (${args.chain.length})${asyncLabel}`,
					0,
					0,
				);
			if (isParallel)
				return new Text(
					`${theme.fg("toolTitle", theme.bold("subagent "))}parallel (${parallelCount})`,
					0,
					0,
				);
			return new Text(
				`${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", args.agent || "?")}${asyncLabel}`,
				0,
				0,
			);
		},

		renderResult(result, options, theme, context) {
			syncResultAnimation(result, context);
			return renderSubagentResult(result, options, theme);
		},

	};

	const statusTool: ToolDefinition<typeof StatusParams, Details> = {
		name: "subagent_status",
		label: "Subagent Status",
		description: "Inspect async subagent run status and artifacts",
		parameters: StatusParams,

		async execute(_id, params, _signal, _onUpdate, _ctx) {
			if (params.action === "list") {
				try {
					const runs = listAsyncRuns(ASYNC_DIR, { states: ["queued", "running"] });
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
			let resolvedId = params.id;

			if (params.dir) {
				asyncDir = path.resolve(params.dir);
			} else if (params.id) {
				const direct = path.join(ASYNC_DIR, params.id);
				if (fs.existsSync(direct)) {
					asyncDir = direct;
				} else {
					const match = findByPrefix(ASYNC_DIR, params.id);
					if (match) {
						asyncDir = match;
						resolvedId = path.basename(match);
					}
				}
			}

			const resultPath =
				params.id && !asyncDir ? findByPrefix(RESULTS_DIR, params.id, ".json") : null;

			if (!asyncDir && !resultPath) {
				return {
					content: [{ type: "text", text: "Async run not found. Provide id or dir." }],
					isError: true,
					details: { mode: "single" as const, results: [] },
				};
			}

			if (asyncDir) {
				let status;
				try {
					status = readStatus(asyncDir);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					return {
						content: [{ type: "text", text: message }],
						isError: true,
						details: { mode: "single" as const, results: [] },
					};
				}
				const logPath = path.join(asyncDir, `subagent-log-${resolvedId ?? "unknown"}.md`);
				const eventsPath = path.join(asyncDir, "events.jsonl");
				if (status) {
					const stepsTotal = status.steps?.length ?? 1;
					const current = status.currentStep !== undefined ? status.currentStep + 1 : undefined;
					const stepLine =
						current !== undefined ? `Step: ${current}/${stepsTotal}` : `Steps: ${stepsTotal}`;
					const started = new Date(status.startedAt).toISOString();
					const updated = status.lastUpdate ? new Date(status.lastUpdate).toISOString() : "n/a";

					const lines = [
						`Run: ${status.runId}`,
						`State: ${status.state}`,
						`Mode: ${status.mode}`,
						stepLine,
						`Started: ${started}`,
						`Updated: ${updated}`,
						`Dir: ${asyncDir}`,
					];
					if (status.sessionFile) lines.push(`Session: ${status.sessionFile}`);
					if (fs.existsSync(logPath)) lines.push(`Log: ${logPath}`);
					if (fs.existsSync(eventsPath)) lines.push(`Events: ${eventsPath}`);

					return { content: [{ type: "text", text: lines.join("\n") }], details: { mode: "single", results: [] } };
				}
			}

			if (resultPath) {
				try {
					const raw = fs.readFileSync(resultPath, "utf-8");
					const data = JSON.parse(raw) as { id?: string; success?: boolean; summary?: string };
					const status = data.success ? "complete" : "failed";
					const lines = [`Run: ${data.id ?? params.id}`, `State: ${status}`, `Result: ${resultPath}`];
					if (data.summary) lines.push("", data.summary);
					return { content: [{ type: "text", text: lines.join("\n") }], details: { mode: "single", results: [] } };
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					return {
						content: [{ type: "text", text: `Failed to read async result file: ${message}` }],
						isError: true,
						details: { mode: "single" as const, results: [] },
					};
				}
			}

			return {
				content: [{ type: "text", text: "Status file not found." }],
				isError: true,
				details: { mode: "single" as const, results: [] },
			};
		},
	};

	pi.registerFlag("preset", {
		description: "Workflow/model preset to use for the main session",
		type: "string",
	});
	pi.registerFlag("role", {
		description: "Root role to use for the main session",
		type: "string",
	});

	pi.registerTool(tool);
	pi.registerTool(statusTool);
	registerSlashCommands(pi, state);
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
				const { availableRoles, warnings, appliedWorkflow } = resolveRootRoleCandidates(ctx, workflowName);
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

	const eventUnsubscribeStoreKey = "__piSubagentEventUnsubscribes";
	const controlNoticeSeenStoreKey = "__piSubagentVisibleControlNotices";
	const previousEventUnsubscribes = globalStore[eventUnsubscribeStoreKey];
	if (Array.isArray(previousEventUnsubscribes)) {
		for (const unsubscribe of previousEventUnsubscribes) {
			if (typeof unsubscribe !== "function") continue;
			try {
				unsubscribe();
			} catch {
				// Best effort cleanup for stale handlers from an older reload.
			}
		}
	}
	registerSubagentNotify(pi);

	const existingVisibleControlNotices = globalStore[controlNoticeSeenStoreKey];
	const visibleControlNotices = existingVisibleControlNotices instanceof Set ? existingVisibleControlNotices as Set<string> : new Set<string>();
	globalStore[controlNoticeSeenStoreKey] = visibleControlNotices;
	const controlEventHandler = (payload: unknown) => {
		const details = payload as SubagentControlMessageDetails;
		if (!details?.event) return;
		const childIntercomTarget = controlNoticeTarget(details);
		const key = controlNotificationKey(details.event, childIntercomTarget);
		if (visibleControlNotices.has(key)) return;
		visibleControlNotices.add(key);
		const noticeText = details.noticeText ?? formatControlNoticeMessage(details.event, childIntercomTarget);
		pi.sendMessage(
			{
				customType: SUBAGENT_CONTROL_MESSAGE_TYPE,
				content: noticeText,
				display: true,
				details: { ...details, childIntercomTarget, noticeText },
			},
			{ triggerTurn: true },
		);
	};
	const eventUnsubscribes = [
		pi.events.on(SUBAGENT_ASYNC_STARTED_EVENT, handleStarted),
		pi.events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, handleComplete),
		pi.events.on(SUBAGENT_CONTROL_EVENT, controlEventHandler),
	];
	globalStore[eventUnsubscribeStoreKey] = eventUnsubscribes;

	pi.on("tool_result", (event, ctx) => {
		if (event.toolName !== "subagent") return;
		if (!ctx.hasUI) return;
		state.lastUiContext = ctx;
		if (state.asyncJobs.size > 0) {
			renderWidget(ctx, Array.from(state.asyncJobs.values()));
			ensurePoller();
		}
	});

	const cleanupSessionArtifacts = (ctx: ExtensionContext) => {
		try {
			const sessionFile = ctx.sessionManager.getSessionFile();
			if (sessionFile) {
				cleanupOldArtifacts(getArtifactsDir(sessionFile), DEFAULT_ARTIFACT_CONFIG.cleanupDays);
			}
		} catch {
			// Cleanup failures should not block session lifecycle events.
		}
	};

	const resetSessionState = (ctx: ExtensionContext) => {
		state.baseCwd = ctx.cwd;
		state.currentSessionId = ctx.sessionManager.getSessionFile() ?? `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		state.lastUiContext = ctx;
		cleanupSessionArtifacts(ctx);
		resetJobs(ctx);
		restoreSlashFinalSnapshots(ctx.sessionManager.getEntries());
	};

	pi.on("before_agent_start", async (event) => {
		if (isDelegatedSubagentSession()) return;
		const prompt = activeRootRole?.systemPrompt?.trim();
		if (!prompt) return;
		return {
			systemPrompt: `${event.systemPrompt}\n\n${prompt}`,
		};
	});

	pi.on("session_start", async (_event, ctx) => {
		resetSessionState(ctx);
		if (isDelegatedSubagentSession()) return;
		await initializeRootRole(ctx);
	});
	pi.on("turn_start", () => {
		if (isDelegatedSubagentSession()) return;
		if (activeWorkflowName) {
			pi.appendEntry("workflow-state", { name: activeWorkflowName });
			pi.appendEntry("preset-state", { name: activeWorkflowName });
		}
		if (activeRootRoleName) {
			pi.appendEntry("role-state", { name: activeRootRoleName, workflow: activeWorkflowName });
		}
	});

	pi.on("session_shutdown", () => {
		for (const unsubscribe of eventUnsubscribes) {
			try {
				unsubscribe();
			} catch {
				// Best effort cleanup during shutdown.
			}
		}
		if (globalStore[eventUnsubscribeStoreKey] === eventUnsubscribes) {
			delete globalStore[eventUnsubscribeStoreKey];
		}
		activeWorkflowName = undefined;
		activeRootRoleName = undefined;
		activeRootRole = undefined;
		stopResultWatcher();
		if (state.poller) clearInterval(state.poller);
		state.poller = null;
		for (const timer of state.cleanupTimers.values()) {
			clearTimeout(timer);
		}
		state.cleanupTimers.clear();
		state.asyncJobs.clear();
		clearSlashSnapshots();
		slashBridge.cancelAll();
		slashBridge.dispose();
		promptTemplateBridge.cancelAll();
		promptTemplateBridge.dispose();
		stopWidgetAnimation();
		stopResultAnimations();
		if (globalStore[runtimeCleanupStoreKey] === runtimeCleanup) {
			delete globalStore[runtimeCleanupStoreKey];
		}
		if (state.lastUiContext?.hasUI) {
			state.lastUiContext.ui.setWidget(WIDGET_KEY, undefined);
		}
	});
}
