import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { discoverAgents } from "../shared/agents.ts";
import { foregroundRunsFromState, SubagentsStatusComponent } from "./subagents-status.ts";
import { logger } from "../shared/logger.ts";
import type { SubagentToolInput as SubagentParamsLike } from "../protocol/schemas.ts";
import type { UtilsClient } from "pi-extension-utils";
import type { SlashSubagentResponse, SlashSubagentUpdate } from "./slash-bridge.ts";
import {
	applySlashUpdate,
	buildSlashInitialResult,
	failSlashResult,
	finalizeSlashResult,
} from "../state/slash-live-state.ts";
import {
	SLASH_RESULT_TYPE,
	SLASH_SUBAGENT_CANCEL_EVENT,
	SLASH_SUBAGENT_REQUEST_EVENT,
	SLASH_SUBAGENT_RESPONSE_EVENT,
	SLASH_SUBAGENT_STARTED_EVENT,
	SLASH_SUBAGENT_UPDATE_EVENT,
	type SingleResult,
	type SubagentState,
} from "../protocol/types.ts";

interface InlineConfig {
	output?: string | false;
	reads?: string[] | false;
	model?: string;
	skill?: string[] | false;
	progress?: boolean;
	preset?: string;
}

const parseInlineConfig = (raw: string): InlineConfig => {
	const config: InlineConfig = {};
	for (const part of raw.split(",")) {
		const trimmed = part.trim();
		if (!trimmed) continue;
		const eq = trimmed.indexOf("=");
		if (eq === -1) {
			if (trimmed === "progress") config.progress = true;
			continue;
		}
		const key = trimmed.slice(0, eq).trim();
		const val = trimmed.slice(eq + 1).trim();
		switch (key) {
			case "output": config.output = val === "false" ? false : val; break;
			case "reads": config.reads = val === "false" ? false : val.split("+").filter(Boolean); break;
			case "model": config.model = val || undefined; break;
			case "skill": case "skills": config.skill = val === "false" ? false : val.split("+").filter(Boolean); break;
			case "progress": config.progress = val !== "false"; break;
			case "preset": config.preset = val || undefined; break;
		}
	}
	return config;
};

const parseAgentToken = (token: string): { name: string; config: InlineConfig } => {
	const bracket = token.indexOf("[");
	if (bracket === -1) return { name: token, config: {} };
	const end = token.lastIndexOf("]");
	return { name: token.slice(0, bracket), config: parseInlineConfig(token.slice(bracket + 1, end !== -1 ? end : undefined)) };
};

const extractExecutionFlags = (rawArgs: string): { args: string; bg: boolean; fork: boolean } => {
	let args = rawArgs.trim();
	let bg = false;
	let fork = false;

	while (true) {
		if (args.endsWith(" --bg") || args === "--bg") {
			bg = true;
			args = args === "--bg" ? "" : args.slice(0, -5).trim();
			continue;
		}
		if (args.endsWith(" --fork") || args === "--fork") {
			fork = true;
			args = args === "--fork" ? "" : args.slice(0, -7).trim();
			continue;
		}
		break;
	}

	return { args, bg, fork };
};

const extractTopLevelInlineConfig = (rawArgs: string): { args: string; config: InlineConfig } => {
	const args = rawArgs.trim();
	if (!args.startsWith("[")) return { args, config: {} };
	const end = args.indexOf("]");
	if (end === -1) return { args, config: {} };
	return {
		args: args.slice(end + 1).trim(),
		config: parseInlineConfig(args.slice(1, end)),
	};
};

const resolveSlashPreset = (...values: Array<string | undefined>): { preset?: string; error?: string } => {
	const presets = [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
	if (presets.length > 1) {
		return { error: `Conflicting preset values: ${presets.join(", ")}` };
	}
	return presets[0] ? { preset: presets[0] } : {};
};

const makeAgentCompletions = (state: SubagentState, multiAgent: boolean) => (prefix: string) => {
	const agents = discoverAgents(state.baseCwd, "both", { surface: "subagent" }).agents;
	if (!multiAgent) {
		if (prefix.includes(" ")) return null;
		return agents.filter((a) => a.name.startsWith(prefix)).map((a) => ({ value: a.name, label: a.name }));
	}

	const lastArrow = prefix.lastIndexOf(" -> ");
	const segment = lastArrow !== -1 ? prefix.slice(lastArrow + 4) : prefix;
	if (segment.includes(" -- ") || segment.includes('"') || segment.includes("'")) return null;

	const lastWord = (prefix.match(/(\S*)$/) || ["", ""])[1];
	const beforeLastWord = prefix.slice(0, prefix.length - lastWord.length);

	if (lastWord === "->") {
		return agents.map((a) => ({ value: `${prefix} ${a.name}`, label: a.name }));
	}

	return agents.filter((a) => a.name.startsWith(lastWord)).map((a) => ({ value: `${beforeLastWord}${a.name}`, label: a.name }));
};

async function requestSlashRun(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	requestId: string,
	params: SubagentParamsLike,
): Promise<SlashSubagentResponse> {
	return new Promise((resolve, reject) => {
		let done = false;
		let started = false;

		const startTimeoutMs = 15_000;
		const startTimeout = setTimeout(() => {
			finish(() => reject(new Error(
				"Slash subagent bridge did not start within 15s. Ensure the extension is loaded correctly.",
			)));
		}, startTimeoutMs);

		const onStarted = (data: unknown) => {
			if (done || !data || typeof data !== "object") return;
			if ((data as { requestId?: unknown }).requestId !== requestId) return;
			started = true;
			clearTimeout(startTimeout);
			if (ctx.hasUI) ctx.ui.setStatus("subagent-slash", "running...");
		};

		const onResponse = (data: unknown) => {
			if (done || !data || typeof data !== "object") return;
			const response = data as Partial<SlashSubagentResponse>;
			if (response.requestId !== requestId) return;
			clearTimeout(startTimeout);
			finish(() => resolve(response as SlashSubagentResponse));
		};

		const onUpdate = (data: unknown) => {
			if (done || !data || typeof data !== "object") return;
			const update = data as SlashSubagentUpdate;
			if (update.requestId !== requestId) return;
			applySlashUpdate(requestId, update);
			if (!ctx.hasUI) return;
			const tool = update.currentTool ? ` ${update.currentTool}` : "";
			const count = update.toolCount ?? 0;
			ctx.ui.setStatus("subagent-slash", `${count} tools${tool} | Ctrl+O live detail`);
		};

		const onTerminalInput = ctx.hasUI
			? ctx.ui.onTerminalInput((input) => {
				if (!matchesKey(input, Key.escape)) return undefined;
				pi.events.emit(SLASH_SUBAGENT_CANCEL_EVENT, { requestId });
				finish(() => reject(new Error("Cancelled")));
				return { consume: true };
			})
			: undefined;

		const unsubStarted = pi.events.on(SLASH_SUBAGENT_STARTED_EVENT, onStarted);
		const unsubResponse = pi.events.on(SLASH_SUBAGENT_RESPONSE_EVENT, onResponse);
		const unsubUpdate = pi.events.on(SLASH_SUBAGENT_UPDATE_EVENT, onUpdate);

		const finish = (next: () => void) => {
			if (done) return;
			done = true;
			clearTimeout(startTimeout);
			unsubStarted();
			unsubResponse();
			unsubUpdate();
			onTerminalInput?.();
			next();
		};

		pi.events.emit(SLASH_SUBAGENT_REQUEST_EVENT, { requestId, params });

		// Bridge emits STARTED synchronously during REQUEST emit.
		// If not started, no bridge received the request.
		if (!started && done) return;
		if (!started) {
			finish(() => reject(new Error(
				"No slash subagent bridge responded. Ensure the subagent extension is loaded correctly.",
			)));
		}
	});
}

function extractSlashMessageText(content: string | Array<{ type?: string; text?: string }>): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

function formatExportPathList(paths: string[]): string {
	return paths.map((file) => `- \`${file}\``).join("\n");
}

function collectResultPaths(results: SingleResult[], getPath: (result: SingleResult) => string | undefined): string[] {
	return results
		.map(getPath)
		.filter((file): file is string => typeof file === "string" && file.length > 0);
}

function buildSlashExportText(response: SlashSubagentResponse): string {
	const output = extractSlashMessageText(response.result.content) || response.errorText || "(no output)";
	const results = response.result.details?.results ?? [];
	const sessionFiles = collectResultPaths(results, (result) => result.sessionFile);
	const savedOutputs = collectResultPaths(results, (result) => result.savedOutputPath);
	const artifactOutputs = collectResultPaths(results, (result) => result.artifactPaths?.outputPath);
	const sections = ["## Subagent result", output];
	if (sessionFiles.length > 0) sections.push("## Child session exports", formatExportPathList(sessionFiles));
	if (savedOutputs.length > 0) sections.push("## Saved outputs", formatExportPathList(savedOutputs));
	if (artifactOutputs.length > 0) sections.push("## Artifact outputs", formatExportPathList(artifactOutputs));
	return sections.join("\n\n");
}

function persistSlashSessionSnapshot(ctx: ExtensionContext): void {
	try {
		if (!ctx.sessionManager) return;
		const sessionManager = ctx.sessionManager as typeof ctx.sessionManager & {
			_rewriteFile?: () => void;
			flushed?: boolean;
		};
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile || typeof sessionManager._rewriteFile !== "function") return;
		fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
		sessionManager._rewriteFile();
		sessionManager.flushed = true;
	} catch (error) {
		logger.error("Failed to persist slash session snapshot for export", error instanceof Error ? error : undefined, {
			error: error instanceof Error ? undefined : String(error),
		});
	}
}

async function runSlashSubagent(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	params: SubagentParamsLike,
): Promise<void> {
	const requestId = randomUUID();
	const initialDetails = buildSlashInitialResult(requestId, params);
	const initialText = extractSlashMessageText(initialDetails.result.content) || "Running subagent...";
	pi.sendMessage({
		customType: SLASH_RESULT_TYPE,
		content: initialText,
		display: true,
		details: initialDetails,
	});
	persistSlashSessionSnapshot(ctx);

	try {
		const response = await requestSlashRun(pi, ctx, requestId, params);
		const finalDetails = finalizeSlashResult(response);
		pi.sendMessage({
			customType: SLASH_RESULT_TYPE,
			content: buildSlashExportText(response),
			display: true,
			details: finalDetails,
		});
		persistSlashSessionSnapshot(ctx);
		if (ctx.hasUI) {
			ctx.ui.setStatus("subagent-slash", undefined);
		}
		if (response.isError && ctx.hasUI) {
			ctx.ui.notify(response.errorText || "Subagent failed", "error");
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const failedDetails = failSlashResult(requestId, params, message);
		pi.sendMessage({
			customType: SLASH_RESULT_TYPE,
			content: `## Subagent result\n\n${message}`,
			display: true,
			details: failedDetails,
		});
		persistSlashSessionSnapshot(ctx);
		if (ctx.hasUI) {
			ctx.ui.setStatus("subagent-slash", undefined);
		}
		if (message === "Cancelled") {
			if (ctx.hasUI) ctx.ui.notify("Cancelled", "warning");
			return;
		}
		if (ctx.hasUI) ctx.ui.notify(message, "error");
	}
}

interface ParsedStep { name: string; config: InlineConfig; task?: string }

const parseAgentArgs = (
	state: SubagentState,
	args: string,
	command: string,
	ctx: ExtensionContext,
	preset?: string,
): { steps: ParsedStep[]; task: string } | null => {
	const input = args.trim();
	const usage = `Usage: /${command} agent1 "task1" -> agent2 "task2"`;
	let steps: ParsedStep[];
	let sharedTask: string;
	let perStep = false;

	if (input.includes(" -> ")) {
		perStep = true;
		const segments = input.split(" -> ");
		steps = [];
		for (const seg of segments) {
			const trimmed = seg.trim();
			if (!trimmed) continue;
			let agentPart: string;
			let task: string | undefined;
			const qMatch = trimmed.match(/^(\S+(?:\[[^\]]*\])?)\s+(?:"([^"]*)"|'([^']*)')$/);
			if (qMatch) {
				agentPart = qMatch[1]!;
				task = (qMatch[2] ?? qMatch[3]) || undefined;
			} else {
				const dashIdx = trimmed.indexOf(" -- ");
				if (dashIdx !== -1) {
					agentPart = trimmed.slice(0, dashIdx).trim();
					task = trimmed.slice(dashIdx + 4).trim() || undefined;
				} else {
					agentPart = trimmed;
				}
			}
			const parsed = parseAgentToken(agentPart);
			steps.push({ ...parsed, task });
		}
		sharedTask = steps.find((s) => s.task)?.task ?? "";
	} else {
		const delimiterIndex = input.indexOf(" -- ");
		if (delimiterIndex === -1) {
			ctx.ui.notify(usage, "error");
			return null;
		}
		const agentsPart = input.slice(0, delimiterIndex).trim();
		sharedTask = input.slice(delimiterIndex + 4).trim();
		if (!agentsPart || !sharedTask) {
			ctx.ui.notify(usage, "error");
			return null;
		}
		steps = agentsPart.split(/\s+/).filter(Boolean).map((t) => parseAgentToken(t));
	}

	if (steps.length === 0) {
		ctx.ui.notify(usage, "error");
		return null;
	}
	const agents = discoverAgents(state.baseCwd, "both", { preset, surface: "subagent" }).agents;
	for (const step of steps) {
		if (!agents.find((a) => a.name === step.name)) {
			ctx.ui.notify(`Unknown agent: ${step.name}`, "error");
			return null;
		}
	}
	if (command === "parallel" && !steps.some((s) => s.task) && !sharedTask) {
		ctx.ui.notify("At least one step must have a task", "error");
		return null;
	}
	return { steps, task: sharedTask };
};

export function registerSlashCommands(
	pi: ExtensionAPI,
	state: SubagentState,
	getWidgetClient?: (ctx: ExtensionContext) => UtilsClient | undefined,
): void {
	pi.registerCommand("run", {
		description: "Run a subagent directly: /run [preset=name] agent[output=file] [task] [--bg] [--fork]",
		getArgumentCompletions: makeAgentCompletions(state, false),
		handler: async (args, ctx) => {
			const { args: cleanedArgs, bg, fork } = extractExecutionFlags(args);
			const { args: input, config: topLevel } = extractTopLevelInlineConfig(cleanedArgs);
			const firstSpace = input.indexOf(" ");
			if (!input) { ctx.ui.notify("Usage: /run [preset=name] <agent> [task] [--bg] [--fork]", "error"); return; }
			const { name: agentName, config: inline } = parseAgentToken(firstSpace === -1 ? input : input.slice(0, firstSpace));
			const task = firstSpace === -1 ? "" : input.slice(firstSpace + 1).trim();
			const presetResolution = resolveSlashPreset(topLevel.preset, inline.preset);
			if (presetResolution.error) { ctx.ui.notify(presetResolution.error, "error"); return; }

			const agents = discoverAgents(state.baseCwd, "both", { preset: presetResolution.preset, surface: "subagent" }).agents;
			if (!agents.find((a) => a.name === agentName)) { ctx.ui.notify(`Unknown agent: ${agentName}`, "error"); return; }

			let finalTask = task;
			if (inline.reads && Array.isArray(inline.reads) && inline.reads.length > 0) {
				finalTask = `[Read from: ${inline.reads.join(", ")}]\n\n${finalTask}`;
			}
			const taskParam = {
				agent: agentName,
				task: finalTask,
				...(inline.output !== undefined ? { output: inline.output } : {}),
				...(fork ? { context: "fork" as const } : {}),
			};
			const params: SubagentParamsLike = { run: [taskParam] };
			if (bg) params.async = true;
			await runSlashSubagent(pi, ctx, params);
		},
	});

	pi.registerCommand("parallel", {
		description: "Run agents in parallel: /parallel [preset=name] scout \"task1\" -> reviewer \"task2\" [--bg] [--fork]",
		getArgumentCompletions: makeAgentCompletions(state, true),
		handler: async (args, ctx) => {
			const { args: cleanedArgs, bg, fork } = extractExecutionFlags(args);
			const { args: parallelArgs, config: topLevel } = extractTopLevelInlineConfig(cleanedArgs);
			const parsed = parseAgentArgs(state, parallelArgs, "parallel", ctx, topLevel.preset);
			if (!parsed) return;
			const presetResolution = resolveSlashPreset(topLevel.preset, ...parsed.steps.map((step) => step.config.preset));
			if (presetResolution.error) { ctx.ui.notify(presetResolution.error, "error"); return; }
			const tasks = parsed.steps.map(({ name, config, task: stepTask }) => ({
				agent: name,
				task: stepTask ?? parsed.task,
				...(fork ? { context: "fork" as const } : {}),
			}));
			const params: SubagentParamsLike = { run: tasks };
			if (bg) params.async = true;
			await runSlashSubagent(pi, ctx, params);
		},
	});

	// Shared opener so the slash command and the shortcut stay in sync.
	const openSubagentsStatus = async (ctx: ExtensionContext) => {
		const sessionCwd = (ctx as { cwd?: string }).cwd ?? state.baseCwd;
		const sessionId = ctx.sessionManager?.getSessionId?.() ?? state.currentSessionId ?? undefined;
		// Branch-aware membership: collect the top-level run ids anchored on the
		// CURRENT message-tree branch. Re-read on every reload so a /tree revert
		// (which moves the leaf) immediately hides abandoned-branch runs.
		const getBranchAnchorRunIds = (): Set<string> => {
			const ids = new Set<string>();
			const branch = ctx.sessionManager?.getBranch?.();
			if (!branch) return ids;
			for (const entry of branch) {
				if (!entry || typeof entry !== "object") continue;
				const candidate = entry as { type?: string; customType?: string; data?: { runId?: unknown } };
				if (candidate.type !== "custom" || candidate.customType !== "subagent_run") continue;
				if (typeof candidate.data?.runId === "string") ids.add(candidate.data.runId);
			}
			return ids;
		};
		const componentFactory = (tui: unknown, theme: unknown, done: (value: void) => void) =>
			new SubagentsStatusComponent(tui as never, theme as never, () => done(undefined), {
				listForegroundRuns: () => foregroundRunsFromState(state),
				sessionCwd,
				...(sessionId ? { sessionId } : {}),
				getBranchAnchorRunIds,
			});
		const client = getWidgetClient?.(ctx);
		if (client) {
			await client.ui.fullscreen<void>((tui, theme, _kb, done) => componentFactory(tui, theme, done));
		} else {
			await ctx.ui.custom<void>((tui, theme, _kb, done) => componentFactory(tui, theme, done));
		}
	};

	pi.registerCommand("subagents-status", {
		description: "Show live subagent runs",
		handler: async (_args, ctx) => {
			await openSubagentsStatus(ctx);
		},
	});

	pi.registerShortcut("ctrl+shift+s", {
		handler: async (ctx) => {
			await openSubagentsStatus(ctx as ExtensionContext);
		},
	});
}
