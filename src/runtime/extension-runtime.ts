/**
 * Subagent Tool
 *
 * Full-featured subagent with sync and async modes.
 * - Sync (default): Streams output, renders markdown, tracks usage
 * - Async: Background execution, emits events when done
 *
 * Modes: run[] or management via action/id.
 * Toggle: async parameter (default: false, configurable via config.json)
 *
 * Config file: ~/.pi/agent/subagent.json
 *   { "asyncByDefault": true, "forceTopLevelAsync": true, "maxSubagentDepth": 1, "intercomBridge": { "mode": "always", "instructionFile": "./intercom-bridge.md" }, "worktreeSetupHook": "./scripts/setup-worktree.mjs" }
 * Legacy config is still read from ~/.pi/agent/extensions/subagent/config.json when the primary file is absent.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type AgentConfig, discoverAgents } from "../shared/agents.ts";
import { setCurrentPi } from "../shared/current-pi.ts";
import { loadConfig, expandTilde } from "../shared/config.ts";
import { createHostSubagentApi, registerChildSessionApi } from "../api/exposed-subagent-api.ts";
import { createIdleTracker } from "../surfaces/idle-tracker.ts";
import { logger } from "../shared/logger.ts";
import { isInsideChildSession } from "../shared/child-session-context.ts";
import { resolveAgentToolPatterns } from "../dispatch/resolve-tool-patterns.ts";
import { leafConcurrencyLimit } from "../dispatch/leaf-concurrency.ts";
import { cleanupAllArtifactDirs, cleanupOldArtifacts, getArtifactsDir } from "../shared/artifacts.ts";
import { renderWidget, stopWidgetAnimation } from "../surfaces/render-widget.ts";
import { stopResultAnimations } from "../surfaces/render-result.ts";
import { createSubagentExecutor } from "../dispatch/subagent-executor.ts";
import { createSubagentToolDefinitions } from "../dispatch/subagent-tool.ts";
import { createPersonaDirRegistry } from "../shared/persona-registry.ts";
import { ChildAgentRegistry } from "../dispatch/in-process-executor.ts";
import { createAsyncJobTracker } from "../surfaces/async-job-tracker.ts";
import { createRootRoleManager } from "../runtime/root-role-manager.ts";
import { registerSlashCommands } from "../surfaces/slash-commands.ts";
import { registerPromptTemplateDelegationBridge } from "../dispatch/prompt-template-bridge.ts";
import { registerSlashSubagentBridge } from "../surfaces/slash-bridge.ts";
import { connect, type UtilsClient } from "pi-extension-utils";
import {
	clearSlashSnapshots,
	resolveSlashMessageDetails,
	restoreSlashFinalSnapshots,
	type SlashMessageDetails,
} from "../state/slash-live-state.ts";
import registerSubagentNotify, {
	type SubagentBatchNotifyDetails,
	type SubagentNotifyDetails,
} from "../surfaces/notify.ts";
import {
	createSlashResultComponent,
	parseSubagentNotifyContent,
	SubagentNotifyNoticeComponent,
} from "../surfaces/message-renderers.ts";
import { registerControlNotices } from "../surfaces/control-notices.ts";
import {
	type RegisterPersonaDirPayload,
	type SubagentState,
	type UnregisterPersonaDirPayload,
	DEFAULT_ARTIFACT_CONFIG,
	SLASH_RESULT_TYPE,
	SUBAGENT_ASYNC_COMPLETE_EVENT,
	SUBAGENT_ASYNC_RUN_COMPLETE_EVENT,
	SUBAGENT_COMPLETED_EVENT,
	SUBAGENT_FAILED_EVENT,
	SUBAGENT_NOTIFY_DELIVERED_EVENT,
	SUBAGENT_REGISTER_PERSONA_DIR_EVENT,
	SUBAGENT_UNREGISTER_PERSONA_DIR_EVENT,
	SUBAGENT_ASYNC_STARTED_EVENT,
	SUBAGENT_CONTROL_EVENT,
	WIDGET_KEY,
} from "../protocol/types.ts";
import { configureXmlStripping } from "../shared/utils.ts";

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
	else if (level !== "info") logger.warn(message, { level });
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
	const isChildSession = isInsideChildSession();
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

	const config = loadConfig();
	configureXmlStripping(config.stripXmlTags);
	// Size the one per-process leaf-concurrency pool from config before any
	// dispatch can run. Sizing is first-win for the process lifetime.
	leafConcurrencyLimit(config.maxConcurrentAgents);
	const asyncByDefault = config.asyncByDefault === true;
	const tempArtifactsDir = getArtifactsDir(null);
	cleanupAllArtifactDirs(DEFAULT_ARTIFACT_CONFIG.cleanupDays);

	const state: SubagentState = {
		baseCwd: process.cwd(),
		currentSessionId: null,
		asyncJobs: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		usageByRun: new Map(),
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
	};

	const runtimeCleanup = () => {
		widgetClient?.dispose();
		widgetClient = undefined;
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
	let widgetClient: UtilsClient | undefined;
	const getWidgetClient = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return undefined;
		widgetClient ??= connect(pi, { ctx, clientId: "pi-subagents" });
		return widgetClient;
	};
	const { controlEventHandler, controlRunTerminalHandler } = registerControlNotices({
		pi,
		isChildSession,
		globalStore,
	});
	const { ensurePoller, handleStarted, handleComplete, resetJobs, rehydrateFromRegistry, handleDelivered } =
		createAsyncJobTracker(pi, state, { idleTracker, getWidgetClient, onRunTerminal: controlRunTerminalHandler });
	const childRegistry = new ChildAgentRegistry();
	const resolveAgentTools = (agents: AgentConfig[]): AgentConfig[] => {
		const available = pi.getAllTools().map((t) => t.name);
		return agents.map((a) => resolveAgentToolPatterns(a, available));
	};
	const { getRegisteredPersonaDirs, handleRegisterPersonaDir, handleUnregisterPersonaDir } =
		createPersonaDirRegistry(pi);
	const executor = createSubagentExecutor({
		pi,
		state,
		config,
		asyncByDefault,
		tempArtifactsDir,
		childRegistry,
		expandTilde,
		discoverAgents: (cwd, scope, options) => {
			const result = discoverAgents(cwd, scope, {
				...options,
				config,
				registeredPersonaDirs: getRegisteredPersonaDirs(),
			});
			return { ...result, agents: resolveAgentTools(result.agents) };
		},
		getActiveRootRoleName: () => roleManager.getActiveRootRoleName(),
	});
	const hostApi = isChildSession
		? undefined
		: createHostSubagentApi({ pi, executor, config, state, getRegisteredPersonaDirs, discoverAgents });
	const roleManager = createRootRoleManager({
		pi,
		config,
		state,
		setHostCurrentAgent: hostApi?.setCurrentAgent ?? (() => {}),
		notify,
		normalizeName,
		getLatestCustomStateName,
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

	pi.registerMessageRenderer<SubagentNotifyDetails | SubagentBatchNotifyDetails>(
		"subagent-notify",
		(message, options, theme) => {
			const content = typeof message.content === "string" ? message.content : "";
			const details =
				(message.details as SubagentNotifyDetails | SubagentBatchNotifyDetails | undefined) ??
				parseSubagentNotifyContent(content);
			if (!details) return new Text(content, 0, 0);
			return new SubagentNotifyNoticeComponent(details, options, theme);
		},
	);

	const slashBridge = registerSlashSubagentBridge({
		events: pi.events,
		getContext: () => state.lastUiContext,
		execute: (id, params, signal, onUpdate, ctx) => executor.execute(id, params, signal, onUpdate, ctx),
	});

	const promptTemplateBridge = registerPromptTemplateDelegationBridge({
		events: pi.events,
		getContext: () => state.lastUiContext,
		execute: async (requestId, request, signal, ctx, onUpdate) => {
			if (request.tasks && request.tasks.length > 0) {
				return executor.executeInternal(
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
			return executor.executeInternal(
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

	const { tool, workflowTool } = createSubagentToolDefinitions({ executor });

	pi.registerTool(tool);
	pi.registerTool(workflowTool);
	registerSlashCommands(pi, state, getWidgetClient, childRegistry);
	roleManager.registerRoleCommand();

	// Host-only cross-activate state. Children don't need to tear down a
	// previous activate (they don't reload), and they must NEVER unhook the
	// host's listeners.
	const eventUnsubscribeStoreKey = "__piSubagentEventUnsubscribes";
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

	const eventUnsubscribes = [
		pi.events.on(SUBAGENT_ASYNC_STARTED_EVENT, handleStarted),
		pi.events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, handleComplete),
		pi.events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, controlRunTerminalHandler),
		pi.events.on(SUBAGENT_ASYNC_RUN_COMPLETE_EVENT, controlRunTerminalHandler),
		pi.events.on(SUBAGENT_COMPLETED_EVENT, controlRunTerminalHandler),
		pi.events.on(SUBAGENT_FAILED_EVENT, controlRunTerminalHandler),
		pi.events.on(SUBAGENT_NOTIFY_DELIVERED_EVENT, handleDelivered),
		pi.events.on(SUBAGENT_CONTROL_EVENT, controlEventHandler),
		pi.events.on(SUBAGENT_REGISTER_PERSONA_DIR_EVENT, (payload: unknown) =>
			handleRegisterPersonaDir(payload as RegisterPersonaDirPayload),
		),
		pi.events.on(SUBAGENT_UNREGISTER_PERSONA_DIR_EVENT, (payload: unknown) =>
			handleUnregisterPersonaDir(payload as UnregisterPersonaDirPayload),
		),
	];
	if (!isChildSession) globalStore[eventUnsubscribeStoreKey] = eventUnsubscribes;

	pi.on("tool_result", (event, ctx) => {
		if (event.toolName !== "subagent") return;
		if (!ctx.hasUI) return;
		state.lastUiContext = ctx;
		if (state.asyncJobs.size > 0) {
			renderWidget(ctx, Array.from(state.asyncJobs.values()), getWidgetClient(ctx));
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
		state.currentSessionId =
			ctx.sessionManager.getSessionId() ?? `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		state.lastUiContext = ctx;
		getWidgetClient(ctx);
		cleanupSessionArtifacts(ctx);
		resetJobs(ctx);
		rehydrateFromRegistry(ctx);
		restoreSlashFinalSnapshots(ctx.sessionManager.getEntries());
	};

	pi.on("before_agent_start", async (event) => {
		if (isChildSession || roleManager.isDelegatedSubagentSession()) return;
		const prompt = roleManager.getActiveRootRoleSystemPrompt();
		if (!prompt) return;
		return {
			systemPrompt: `${event.systemPrompt}\n\n${prompt}`,
		};
	});

	pi.on("session_start", async (_event, ctx) => {
		resetSessionState(ctx);
		hostApi?.republish();
		if (isChildSession || roleManager.isDelegatedSubagentSession()) return;
		await roleManager.initializeRootRole(ctx);
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
		roleManager.resetRoleState();
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
		widgetClient?.widgets.remove("aboveEditor", WIDGET_KEY);
		widgetClient?.dispose();
		widgetClient = undefined;
	});
}
