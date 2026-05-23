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
 * Config file: ~/.pi/agent/subagent.json
 *   { "asyncByDefault": true, "forceTopLevelAsync": true, "maxSubagentDepth": 1, "intercomBridge": { "mode": "always", "instructionFile": "./intercom-bridge.md" }, "worktreeSetupHook": "./scripts/setup-worktree.mjs" }
 * Legacy config is still read from ~/.pi/agent/extensions/subagent/config.json when the primary file is absent.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { type ExtensionAPI, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Box, Container, Spacer, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { type AgentConfig, type RegisteredPersonaDir, discoverAgents, loadInternalPersonaDir } from "./agents.ts";
import { setCurrentPi } from "./current-pi.ts";
import { claimPendingChildLineage, setHostLineage } from "./lineage.ts";
import { createIdleTracker } from "./idle-tracker.ts";
import { logger } from "./logger.ts";
import { resolveAgentToolPatterns, resolveToolPatterns } from "./resolve-tool-patterns.ts";
import { cleanupAllArtifactDirs, cleanupOldArtifacts, getArtifactsDir } from "./artifacts.ts";
import { cleanupOldChainDirs } from "./settings.ts";
import { renderWidget, renderSubagentResult, stopResultAnimations, stopWidgetAnimation, syncResultAnimation } from "./render.ts";
import { SubagentParams } from "./schemas.ts";
import { createSubagentExecutor } from "./subagent-executor.ts";
import { ChildAgentRegistry } from "./in-process-executor.ts";
import { createAsyncJobTracker } from "./async-job-tracker.ts";
import { controlNotificationKey, formatControlNoticeMessage } from "./subagent-control.ts";
import { registerSlashCommands } from "./slash-commands.ts";
import { registerPromptTemplateDelegationBridge } from "./prompt-template-bridge.ts";
import { registerSlashSubagentBridge } from "./slash-bridge.ts";
import { clearSlashSnapshots, getSlashRenderableSnapshot, resolveSlashMessageDetails, restoreSlashFinalSnapshots, type SlashMessageDetails } from "./slash-live-state.ts";
import { inspectSubagentStatus } from "./run-status.ts";
import registerSubagentNotify, { type SubagentNotifyDetails } from "./notify.ts";
import { formatDuration, shortenPath } from "./formatters.ts";
import {
	type ControlEvent,
	type Details,
	type ExtensionConfig,
	type PersonaDirErrorPayload,
	type RegisterPersonaDirPayload,
	type SpawnRawInput,
	type SpawnResult,
	type SubagentExposedAPI,
	type SubagentLineage,
	type SubagentState,
	type UnregisterPersonaDirPayload,
	DEFAULT_ARTIFACT_CONFIG,
	SLASH_RESULT_TYPE,
	SUBAGENT_ASYNC_COMPLETE_EVENT,
	SUBAGENT_EXPOSE_API_EVENT,
	SUBAGENT_LINEAGE_EVENT,
	SUBAGENT_REGISTER_PERSONA_DIR_ERROR_EVENT,
	SUBAGENT_REGISTER_PERSONA_DIR_EVENT,
	SUBAGENT_UNREGISTER_PERSONA_DIR_EVENT,
	SUBAGENT_ASYNC_STARTED_EVENT,
	SUBAGENT_CONTROL_EVENT,
	WIDGET_KEY,
} from "./types.ts";
import { configureXmlStripping } from "./utils.ts";

const SUBAGENT_CONFIG_PRIMARY = path.join(os.homedir(), ".pi", "agent", "subagent.json");
const SUBAGENT_CONFIG_LEGACY = path.join(os.homedir(), ".pi", "agent", "extensions", "subagent", "config.json");

function resolveConfigPath(): string {
	if (fs.existsSync(SUBAGENT_CONFIG_PRIMARY)) return SUBAGENT_CONFIG_PRIMARY;
	if (fs.existsSync(SUBAGENT_CONFIG_LEGACY)) return SUBAGENT_CONFIG_LEGACY;
	return SUBAGENT_CONFIG_PRIMARY;
}

function loadConfig(): ExtensionConfig {
	const configPath = resolveConfigPath();
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
	private readonly details: SubagentControlMessageDetails;
	private readonly theme: ExtensionContext["ui"]["theme"];

	constructor(
		details: SubagentControlMessageDetails,
		theme: ExtensionContext["ui"]["theme"],
	) {
		this.details = details;
		this.theme = theme;
	}

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

/**
 * Publish a session-scoped SubagentExposedAPI on the child's pi.events with
 * the child's lineage. Other extensions loaded inside this child session
 * (e.g. pi-charter) can listen on SUBAGENT_EXPOSE_API_EVENT and call
 * api.lineage() to learn who they are.
 *
 * Children deliberately get a STUB spawnRaw/list: spawning nested subagents
 * from inside a child session is not supported on the in-process executor.
 */
function registerChildSessionApi(pi: ExtensionAPI): void {
	let lineage: SubagentLineage | null = null;
	const publish = () => {
		const api: SubagentExposedAPI = {
			spawnRaw: async () => ({
				content: [{ type: "text", text: "spawnRaw is not available inside a child session" }],
				details: { type: "error", message: "spawnRaw unsupported in child" } as unknown as Details,
				isError: true,
			}),
			list: () => [],
			lineage: () => lineage,
		};
		pi.events.emit(SUBAGENT_EXPOSE_API_EVENT, api);
		pi.events.emit(SUBAGENT_LINEAGE_EVENT, lineage);
	};
	// Publish immediately with a null lineage so eager listeners see something;
	// re-publish once session_start gives us the session id and lets us claim
	// the lineage that the in-process executor pushed onto the pending queue.
	publish();
	pi.on("session_start", (_event, ctx) => {
		const sid = ctx.sessionManager?.getSessionId?.();
		if (typeof sid !== "string" || sid.length === 0) return;
		// Fallback: claim from the pending queue if the in-process executor's
		// pre-registered-by-sid lineage didn't land for this session. Normally
		// lineage is already in the store keyed by sid before activate runs.
		lineage = claimPendingChildLineage(sid, { runId: null, agentName: null });
		publish();
	});
}

export default function registerSubagentExtension(pi: ExtensionAPI): void {
	// In-process subagents call createAgentSession() which spins up a fresh
	// ExtensionRunner that loads every discovered extension (including this
	// one) with the child's pi. Each child must get its own complete subagent
	// runtime: own subagent tool, own executor + state, own async-job-tracker,
	// own notify, own slash registrations. That way nested sync delegation
	// works AND a child can dispatch its own async subagents tracked
	// independently of the host.
	//
	// The ONLY things the child must NOT do are process-global side effects
	// that would clobber the host: the currentPi pin (host owns it for SDK
	// action calls across activate boundaries) and the singleton runtime
	// cleanup hook. Per-session globalStore keys are scoped by piId so the
	// child's listeners don't tear down the host's.
	const CHILD_SESSION_FLAG_KEY = "__piSubagentInsideChildSession";
	const isChildSession = (globalThis as Record<string, unknown>)[CHILD_SESSION_FLAG_KEY] === true;
	if (isChildSession) {
		logger.info("activate: child session - registering scoped subagent runtime");
		registerChildSessionApi(pi);
	} else {
		logger.info("activate: host session - registering subagent runtime");
	}

	// Each activate hands a fresh `pi` with a fresh session-scoped EventBus.
	// All cross-extension events (subagent lifecycle, control, persona-dir) ride
	// on `pi.events`. Listeners are torn down + re-attached on every host
	// activate via eventUnsubscribeStoreKey so they always bind to the latest
	// live bus. Emitters resolve the current pi at emit time (safeEmit in
	// subagent-executor.ts) to avoid emitting into a disposed bus during the
	// brief reload window.
	//
	// Pin the live pi for handlers that must call SDK action methods
	// (sendMessage, etc.) across an activate boundary. See current-pi.ts for
	// the rationale.
	//
	// ONLY pin when this activate is for the host (UI-bearing) session.
	// In-process subagents call createAgentSession() which spins up a fresh
	// ExtensionRunner that ALSO invokes this factory with the child's pi.
	// When the child session disposes (a few seconds later) that pi goes stale.
	// If we pinned the child pi we'd clobber the host pi and every later
	// sendMessage would throw "ctx is stale after session replacement".
	//
	// Host-only: pin the live pi for handlers that must call SDK action methods
	// (sendMessage, etc.) across an activate boundary. Children must NOT pin
	// because their pi disposes after their session ends.
	if (!isChildSession) setCurrentPi(pi);

	const globalStore = globalThis as Record<string, unknown>;
	const runtimeCleanupStoreKey = "__piSubagentRuntimeCleanup";
	if (!isChildSession) {
		const previousRuntimeCleanup = globalStore[runtimeCleanupStoreKey];
		if (typeof previousRuntimeCleanup === "function") {
			try {
				previousRuntimeCleanup();
			} catch {
				// Best effort cleanup for stale timers from an older reload.
			}
		}
	}

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
	};

	const runtimeCleanup = () => {
		stopWidgetAnimation();
		stopResultAnimations();
		if (state.poller) {
			clearInterval(state.poller);
			state.poller = null;
		}
		for (const timer of state.cleanupTimers.values()) {
			clearTimeout(timer);
		}
		state.cleanupTimers.clear();
		state.asyncJobs.clear();
	};
	// Host-only: install the runtime cleanup hook. Children don't outlive
	// their session and their state goes with them.
	if (!isChildSession) globalStore[runtimeCleanupStoreKey] = runtimeCleanup;

	const idleTracker = createIdleTracker(pi);
	const { ensurePoller, handleStarted, handleComplete, resetJobs } = createAsyncJobTracker(pi, state, { idleTracker });
	const childRegistry = new ChildAgentRegistry();
	const resolveAgentTools = (agents: AgentConfig[]): AgentConfig[] => {
		const available = pi.getAllTools().map((t) => t.name);
		return agents.map((a) => resolveAgentToolPatterns(a, available));
	};
	const personaDirs = new Map<string, RegisterPersonaDirPayload>();
	const getRegisteredPersonaDirs = (): RegisteredPersonaDir[] => Array.from(personaDirs.values()).map((dir) => ({
		extensionId: dir.extensionId,
		path: dir.path,
	}));
	const executor = createSubagentExecutor({
		pi,
		state,
		config,
		asyncByDefault,
		tempArtifactsDir,
		childRegistry,
		expandTilde,
		discoverAgents: (cwd, scope, options) => {
			const result = discoverAgents(cwd, scope, { ...options, config, registeredPersonaDirs: getRegisteredPersonaDirs() });
			return { ...result, agents: resolveAgentTools(result.agents) };
		},
		getActiveRootRoleName: () => activeRootRoleName,
	});
	const buildSpawnRawContext = (): ExtensionContext => state.lastUiContext ?? ({
		cwd: state.baseCwd,
		hasUI: false,
		ui: {} as ExtensionContext["ui"],
		sessionManager: {
			getSessionId: () => state.currentSessionId ?? "spawn-raw",
			getSessionFile: () => null,
		} as unknown as ExtensionContext["sessionManager"],
		modelRegistry: { getAvailable: () => [] } as unknown as ExtensionContext["modelRegistry"],
		model: undefined,
		isIdle: () => true,
		signal: undefined,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: () => {},
		getSystemPrompt: () => "",
	} as ExtensionContext);
	const spawnRaw = async (input: SpawnRawInput): Promise<SpawnResult> => executor.execute(
		"subagent-spawn-raw",
		{
			agent: "__raw__",
			task: input.prompt,
			async: input.async,
			cwd: input.cwd,
			metadata: input.metadata,
			rawAgentConfig: {
				name: "__raw__",
				description: "Raw extension subagent",
				tools: input.tools ?? ["read", "grep", "find", "ls"],
				model: input.model,
				thinking: input.thinking,
				systemPromptMode: input.systemPromptMode ?? "replace",
				inheritProjectContext: input.inheritProjectContext ?? false,
				inheritSkills: input.inheritSkills === true,
				systemPrompt: input.systemPrompt,
				source: "builtin",
				filePath: "<spawnRaw>",
				skills: Array.isArray(input.inheritSkills) ? input.inheritSkills : undefined,
				defaultReads: input.defaultReads,
				defaultProgress: input.defaultProgress,
				surface: "internal",
			},
		},
		new AbortController().signal,
		undefined,
		buildSpawnRawContext(),
	) as unknown as SpawnResult;
	// Host lineage is recorded on session_start once we know the host session
	// id. Until then, lineage() returns a best-effort host shape with a null
	// rootSessionId so callers never see undefined.
	let hostLineage: SubagentLineage = {
		role: "host",
		currentAgent: "main",
		parentAgent: null,
		parentSessionId: null,
		rootSessionId: null,
		depth: 0,
		runId: null,
	};
	const subagentApi: SubagentExposedAPI = {
		spawnRaw,
		list: (options) => discoverAgents(state.lastUiContext?.cwd ?? state.baseCwd, "both", {
			config,
			includeInternal: options?.includeInternal,
			registeredPersonaDirs: getRegisteredPersonaDirs(),
		})
			.agents.map((agent) => ({
				name: agent.name,
				description: agent.description,
				source: agent.source,
				surface: agent.surface,
			})),
		lineage: () => hostLineage,
	};
	const exposeSubagentApi = () => {
		pi.events.emit(SUBAGENT_EXPOSE_API_EVENT, subagentApi);
		pi.events.emit(SUBAGENT_LINEAGE_EVENT, hostLineage);
	};
	exposeSubagentApi();

	// Refine host lineage once session_start fires with the host session id.
	pi.on("session_start", (_event, ctx) => {
		const sid = ctx.sessionManager?.getSessionId?.();
		if (typeof sid === "string" && sid.length > 0) {
			hostLineage = { ...hostLineage, rootSessionId: sid };
			setHostLineage(sid);
			// Re-emit so any listener that subscribed before session_start gets the
			// updated rootSessionId.
			exposeSubagentApi();
		}
	});

	pi.registerMessageRenderer<SlashMessageDetails>(SLASH_RESULT_TYPE, (message, options, theme) => {
		const details = resolveSlashMessageDetails(message.details);
		if (!details) return undefined;
		return createSlashResultComponent(details, options, theme, () => {
			// TODO(sdk-0.75-shape): message renderers do not receive TUI; keep the old
			// optional runtime hook when present without typing it into the SDK surface.
			(state.lastUiContext?.ui as unknown as { requestRender?: () => void }).requestRender?.();
		});
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
			text += `\n  ${theme.fg("dim", `└─ ${line}`)}`;
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
						tasks: request.tasks as unknown as Array<Partial<{ agent: string; task: string }> & Record<string, unknown>>,
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
		const success = await withRuntimePresetSettingsPreserved(() => pi.setModel(model));
		if (!success) {
			notify(ctx, `Role '${activeRootRoleName ?? "unknown"}': no API key for ${model.provider}/${model.id}`, "warning");
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
		ctx.ui.setStatus("preset", activeWorkflowName ? ctx.ui.theme.fg("accent", `preset:${activeWorkflowName}`) : undefined);
		ctx.ui.setStatus("role", activeRootRoleName ? ctx.ui.theme.fg("accent", `role:${activeRootRoleName}`) : undefined);
	}

	async function activateRootRole(ctx: ExtensionContext, role: AgentConfig, workflowName: string | undefined): Promise<void> {
		const previousWorkflowName = activeWorkflowName;
		const previousRootRoleName = activeRootRoleName;
		activeWorkflowName = workflowName;
		activeRootRoleName = role.name;
		activeRootRole = role;
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
		promptSnippet: "Delegate to subagents or control runs",
		description: `Delegate to subagents or control runs.

Dispatch:
• run:[{agent,task}] starts one task.
• run:[{agent,task},{agent,task}] runs tasks in parallel by default.
• chain:true runs run[] sequentially; inside chain:true a run item may be Task[] for a parallel sub-step.
• message adds shared framing for dispatch, or the next turn for action:"resume".

Control:
• action is one of "list", "status", "interrupt", "resume"; id targets status/interrupt/resume.
• Use { action: "list" } when available agents/chains are unknown or may have changed; execute only agents known to be executable/non-disabled.

Task fields: agent, task, label, context, worktree, output.
Gotchas: context defaults to "fresh"; "fork" is main-only same-role self-branching, not role switching. Nested delegation is depth-limited.`,
		parameters: SubagentParams,

		execute(id, params, signal, onUpdate, ctx) {
			return executor.execute(id, params as unknown as Parameters<typeof executor.execute>[1], signal as AbortSignal, onUpdate, ctx);
		},

		renderCall(args, theme) {
			if (args.action) {
				const target = args.id || "";
				return new Text(
					`${theme.fg("toolTitle", theme.bold("subagent "))}${args.action}${target ? ` ${theme.fg("accent", target)}` : ""}`,
					0, 0,
				);
			}
			const run = args.run ?? [];
			const asyncLabel = args.async === true ? theme.fg("warning", " [async]") : "";
			if (args.chain === true)
				return new Text(
					`${theme.fg("toolTitle", theme.bold("subagent "))}chain (${run.length})${asyncLabel}`,
					0,
					0,
				);
			if (run.length > 1)
				return new Text(
					`${theme.fg("toolTitle", theme.bold("subagent "))}parallel (${run.length})${asyncLabel}`,
					0,
					0,
				);
			const first = run[0];
			const agent = first && !Array.isArray(first) ? first.agent : "?";
			return new Text(
				`${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", agent)}${asyncLabel}`,
				0,
				0,
			);
		},

		renderResult(result, options, theme, context) {
			syncResultAnimation(result, context);
			return renderSubagentResult(result, options, theme);
		},

	};

	pi.registerTool(tool);
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

	// Host-only cross-activate state. Children don't need to tear down a
	// previous activate (they don't reload), and they must NEVER unhook the
	// host's listeners.
	const eventUnsubscribeStoreKey = "__piSubagentEventUnsubscribes";
	const controlNoticeSeenStoreKey = "__piSubagentVisibleControlNotices";
	if (!isChildSession) {
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
	}
	registerSubagentNotify(pi);

	const existingVisibleControlNotices = isChildSession ? undefined : globalStore[controlNoticeSeenStoreKey];
	const visibleControlNotices = existingVisibleControlNotices instanceof Set ? existingVisibleControlNotices as Set<string> : new Set<string>();
	if (!isChildSession) globalStore[controlNoticeSeenStoreKey] = visibleControlNotices;
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
	const emitPersonaDirError = (payload: PersonaDirErrorPayload) => {
		pi.events.emit(SUBAGENT_REGISTER_PERSONA_DIR_ERROR_EVENT, payload);
	};
	const handleRegisterPersonaDir = (data: unknown) => {
		const payload = data as RegisterPersonaDirPayload;
		if (!payload || !payload.extensionId || payload.scope !== "internal" || !path.isAbsolute(payload.path)) {
			emitPersonaDirError({
				extensionId: payload?.extensionId ?? "",
				conflictingExtensionId: "",
				personaName: "",
				message: "Invalid subagent persona directory registration",
			});
			return;
		}
		const newAgents = loadInternalPersonaDir(payload.path);
		const newNames = new Set(newAgents.map((agent) => agent.name));
		for (const existing of personaDirs.values()) {
			if (existing.extensionId === payload.extensionId) continue;
			for (const agent of loadInternalPersonaDir(existing.path)) {
				if (!newNames.has(agent.name)) continue;
				emitPersonaDirError({
					extensionId: payload.extensionId,
					conflictingExtensionId: existing.extensionId,
					personaName: agent.name,
					message: `Subagent persona name '${agent.name}' is already registered by extension '${existing.extensionId}'`,
				});
				return;
			}
		}
		personaDirs.set(payload.extensionId, payload);
	};
	const handleUnregisterPersonaDir = (data: unknown) => {
		const payload = data as UnregisterPersonaDirPayload;
		if (payload?.extensionId) personaDirs.delete(payload.extensionId);
	};
	const eventUnsubscribes = [
		pi.events.on(SUBAGENT_ASYNC_STARTED_EVENT, handleStarted),
		pi.events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, handleComplete),
		pi.events.on(SUBAGENT_CONTROL_EVENT, controlEventHandler),
		pi.events.on(SUBAGENT_REGISTER_PERSONA_DIR_EVENT, (payload: unknown) => handleRegisterPersonaDir(payload as RegisterPersonaDirPayload)),
		pi.events.on(SUBAGENT_UNREGISTER_PERSONA_DIR_EVENT, (payload: unknown) => handleUnregisterPersonaDir(payload as UnregisterPersonaDirPayload)),
	];
	if (!isChildSession) globalStore[eventUnsubscribeStoreKey] = eventUnsubscribes;

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
		state.currentSessionId = ctx.sessionManager.getSessionId() ?? `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
		exposeSubagentApi();
		if (isDelegatedSubagentSession()) return;
		await initializeRootRole(ctx);
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
