/**
 * Async execution logic for subagent tool
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AgentConfig } from "./agents.ts";
import { applyThinkingSuffix } from "./pi-args.ts";
import { injectSingleOutputInstruction, resolveSingleOutputPath } from "./single-output.ts";
import { isParallelStep, resolveStepBehavior, type ChainStep, type SequentialStep, type StepOverrides } from "./settings.ts";
import type { RunnerStep } from "./parallel-utils.ts";
import { resolvePiPackageRoot } from "./pi-spawn.ts";
import { buildSkillInjection, normalizeSkillInput, resolveSkillsWithFallback } from "./skills.ts";
import { resolveChildCwd } from "./utils.ts";
import { buildModelCandidates, resolveModelCandidate, type AvailableModelInfo } from "./model-fallback.ts";
import {
	type ArtifactConfig,
	type Details,
	type ForkReuseConfig,
	type MaxOutputConfig,
	type ResolvedControlConfig,
	ASYNC_DIR,
	RESULTS_DIR,
	SUBAGENT_ASYNC_STARTED_EVENT,
	TEMP_ROOT_DIR,
	getAsyncConfigPath,
	resolveChildMaxSubagentDepth,
} from "./types.ts";

const require = createRequire(import.meta.url);
const piPackageRoot = resolvePiPackageRoot();
const jitiCliPath: string | undefined = (() => {
	const candidates: Array<() => string> = [
		() => path.join(path.dirname(require.resolve("jiti/package.json")), "lib/jiti-cli.mjs"),
		() => path.join(path.dirname(require.resolve("@mariozechner/jiti/package.json")), "lib/jiti-cli.mjs"),
		() => {
			const piEntry = fs.realpathSync(process.argv[1]);
			const piRequire = createRequire(piEntry);
			return path.join(path.dirname(piRequire.resolve("@mariozechner/jiti/package.json")), "lib/jiti-cli.mjs");
		},
	];
	for (const candidate of candidates) {
		try {
			const p = candidate();
			if (fs.existsSync(p)) return p;
		} catch {
			// Candidate not available in this install, continue probing.
		}
	}
	return undefined;
})();

export interface AsyncExecutionContext {
	pi: ExtensionAPI;
	cwd: string;
	currentSessionId: string;
	currentModelProvider?: string;
	preset?: string;
	parentAgentName?: string;
}

export interface AsyncChainParams {
	chain: ChainStep[];
	agents: AgentConfig[];
	ctx: AsyncExecutionContext;
	availableModels?: AvailableModelInfo[];
	cwd?: string;
	maxOutput?: MaxOutputConfig;
	artifactsDir?: string;
	artifactConfig: ArtifactConfig;
	shareEnabled: boolean;
	sessionRoot?: string;
	chainSkills?: string[];
	sessionFilesByFlatIndex?: (string | undefined)[];
	maxSubagentDepth: number;
	forkReuse?: ForkReuseConfig;
	worktreeSetupHook?: string;
	worktreeSetupHookTimeoutMs?: number;
	controlConfig?: ResolvedControlConfig;
	controlIntercomTarget?: string;
	childIntercomTarget?: (agent: string, index: number) => string | undefined;
}

export interface AsyncSingleParams {
	agent: string;
	task?: string;
	agentConfig: AgentConfig;
	ctx: AsyncExecutionContext;
	cwd?: string;
	maxOutput?: MaxOutputConfig;
	artifactsDir?: string;
	artifactConfig: ArtifactConfig;
	shareEnabled: boolean;
	sessionRoot?: string;
	sessionFile?: string;
	skills?: string[];
	output?: string | false;
	modelOverride?: string;
	availableModels?: AvailableModelInfo[];
	maxSubagentDepth: number;
	forkReuse?: ForkReuseConfig;
	worktreeSetupHook?: string;
	worktreeSetupHookTimeoutMs?: number;
	controlConfig?: ResolvedControlConfig;
	controlIntercomTarget?: string;
	childIntercomTarget?: (agent: string, index: number) => string | undefined;
}

export interface AsyncExecutionResult {
	content: Array<{ type: "text"; text: string }>;
	details: Details;
	isError?: boolean;
}

/**
 * Check if jiti is available for async execution
 */
export function isAsyncAvailable(): boolean {
	return jitiCliPath !== undefined;
}

/**
 * Spawn the async runner process
 */
function spawnRunner(cfg: object, suffix: string, cwd: string): { pid?: number; error?: string } {
	if (!jitiCliPath) {
		return { error: "jiti for TypeScript execution could not be found" };
	}

	try {
		const cwdStats = fs.statSync(cwd);
		if (!cwdStats.isDirectory()) {
			return { error: `cwd is not a directory: ${cwd}` };
		}
	} catch {
		return { error: `cwd does not exist: ${cwd}` };
	}

	fs.mkdirSync(TEMP_ROOT_DIR, { recursive: true });
	const cfgPath = getAsyncConfigPath(suffix);
	fs.writeFileSync(cfgPath, JSON.stringify(cfg));
	const runner = path.join(path.dirname(fileURLToPath(import.meta.url)), "subagent-runner.ts");

	const proc = spawn(process.execPath, [jitiCliPath, runner, cfgPath], {
		cwd,
		detached: true,
		stdio: "ignore",
		windowsHide: true,
	});
	proc.on("error", (error) => {
		console.error(`[pi-subagents] async spawn failed: ${error.message}`);
	});
	if (typeof proc.pid !== "number") {
		return { error: `async runner did not produce a pid for cwd: ${cwd}` };
	}
	proc.unref();
	return { pid: proc.pid };
}

function formatAsyncStartError(mode: "single" | "chain", message: string): AsyncExecutionResult {
	return {
		content: [{ type: "text", text: message }],
		isError: true,
		details: { mode, results: [] },
	};
}

/**
 * Execute a chain asynchronously
 */
export function executeAsyncChain(
	id: string,
	params: AsyncChainParams,
): AsyncExecutionResult {
	const {
		chain,
		agents,
		ctx,
		cwd,
		maxOutput,
		artifactsDir,
		artifactConfig,
		shareEnabled,
		sessionRoot,
		sessionFilesByFlatIndex,
		maxSubagentDepth,
		worktreeSetupHook,
		worktreeSetupHookTimeoutMs,
		controlConfig,
		controlIntercomTarget,
		childIntercomTarget,
	} = params;
	const chainSkills = params.chainSkills ?? [];
	const availableModels = params.availableModels;
	const forkReuse = params.forkReuse;
	const runnerCwd = resolveChildCwd(ctx.cwd, cwd);

	for (const s of chain) {
		const stepAgents = isParallelStep(s)
			? s.parallel.map((t) => t.agent)
			: [(s as SequentialStep).agent];
		for (const agentName of stepAgents) {
			if (!agents.find((x) => x.name === agentName)) {
				return {
					content: [{ type: "text", text: `Unknown agent: ${agentName}` }],
					isError: true,
					details: { mode: "chain" as const, results: [] },
				};
			}
		}
	}

	const asyncDir = path.join(ASYNC_DIR, id);
	try {
		fs.mkdirSync(asyncDir, { recursive: true });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			content: [{ type: "text", text: `Failed to create async run directory '${asyncDir}': ${message}` }],
			isError: true,
			details: { mode: "chain" as const, results: [] },
		};
	}

	const buildSeqStep = (s: SequentialStep, sessionFile?: string) => {
		const a = agents.find((x) => x.name === s.agent)!;
		const stepCwd = resolveChildCwd(runnerCwd, s.cwd);
		const outputPath = resolveSingleOutputPath(s.output, ctx.cwd, stepCwd);
		const task = injectSingleOutputInstruction(s.task ?? "{previous}", outputPath);
		const maxDepth = resolveChildMaxSubagentDepth(maxSubagentDepth, a.maxSubagentDepth);

		if (forkReuse) {
			return {
				agent: s.agent,
				task,
				cwd: stepCwd,
				inheritProjectContext: true,
				inheritSkills: true,
				outputPath,
				sessionFile,
				maxSubagentDepth: maxDepth,
				preset: ctx.preset,
				runtimeMode: "root" as const,
				rootRoleName: forkReuse.agentName,
				parentAgentName: ctx.parentAgentName,
				canDelegate: a.canDelegate,
				allowedDelegateAgents: a.allowedDelegateAgents,
			};
		}

		const stepSkillInput = normalizeSkillInput(s.skill);
		const stepOverrides: StepOverrides = { skills: stepSkillInput };
		const behavior = resolveStepBehavior(a, stepOverrides, chainSkills);
		const skillNames = behavior.skills === false ? [] : behavior.skills;
		const { resolved: resolvedSkills } = resolveSkillsWithFallback(skillNames, stepCwd, ctx.cwd);

		let systemPrompt = a.systemPrompt?.trim() ?? "";
		if (resolvedSkills.length > 0) {
			const injection = buildSkillInjection(resolvedSkills);
			systemPrompt = systemPrompt ? `${systemPrompt}\n\n${injection}` : injection;
		}

		const primaryModel = resolveModelCandidate(s.model ?? a.model, availableModels, ctx.currentModelProvider);
		return {
			agent: s.agent,
			task,
			cwd: stepCwd,
			model: applyThinkingSuffix(primaryModel, a.thinking),
			modelCandidates: buildModelCandidates(s.model ?? a.model, a.fallbackModels, availableModels, ctx.currentModelProvider).map((candidate) =>
				applyThinkingSuffix(candidate, a.thinking),
			),
			tools: a.tools,
			extensions: a.extensions,
			mcpDirectTools: a.mcpDirectTools,
			systemPrompt,
			systemPromptMode: a.systemPromptMode,
			inheritProjectContext: a.inheritProjectContext,
			inheritSkills: a.inheritSkills,
			skills: resolvedSkills.map((r) => r.name),
			outputPath,
			sessionFile,
			maxSubagentDepth: maxDepth,
			preset: ctx.preset,
			runtimeMode: "delegated" as const,
			parentAgentName: ctx.parentAgentName,
			canDelegate: a.canDelegate,
			allowedDelegateAgents: a.allowedDelegateAgents,
		};
	};

	let flatStepIndex = 0;
	const nextSessionFile = (): string | undefined => {
		const sessionFile = sessionFilesByFlatIndex?.[flatStepIndex];
		flatStepIndex++;
		return sessionFile;
	};

	const steps: RunnerStep[] = chain.map((s) => {
		if (isParallelStep(s)) {
			return {
				parallel: s.parallel.map((t) => buildSeqStep({
					agent: t.agent,
					task: t.task,
					cwd: t.cwd,
					skill: t.skill,
					model: t.model,
					output: t.output,
				}, nextSessionFile())),
				concurrency: s.concurrency,
				failFast: s.failFast,
				worktree: s.worktree,
			};
		}
		return buildSeqStep(s as SequentialStep, nextSessionFile());
	});
	let childTargetIndex = 0;
	const childIntercomTargets = childIntercomTarget ? steps.flatMap((step) => {
		if ("parallel" in step) {
			return step.parallel.map((task) => childIntercomTarget(task.agent, childTargetIndex++));
		}
		return [childIntercomTarget(step.agent, childTargetIndex++)];
	}) : undefined;

	let spawnResult: { pid?: number; error?: string } = {};
	try {
		spawnResult = spawnRunner(
			{
				id,
				steps,
				resultPath: path.join(RESULTS_DIR, `${id}.json`),
				cwd: runnerCwd,
				placeholder: "{previous}",
				maxOutput,
				artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
				artifactConfig,
				share: shareEnabled,
				sessionDir: sessionRoot ? path.join(sessionRoot, `async-${id}`) : undefined,
				asyncDir,
				sessionId: ctx.currentSessionId,
				piPackageRoot,
				piArgv1: process.argv[1],
				worktreeSetupHook,
				worktreeSetupHookTimeoutMs,
				controlConfig,
				controlIntercomTarget,
				childIntercomTargets,
			},
			id,
			runnerCwd,
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return formatAsyncStartError("chain", `Failed to start async chain '${id}': ${message}`);
	}

	if (spawnResult.error) {
		return formatAsyncStartError("chain", `Failed to start async chain '${id}': ${spawnResult.error}`);
	}

	if (spawnResult.pid) {
		const firstStep = chain[0];
		const firstAgents = isParallelStep(firstStep)
			? firstStep.parallel.map((t) => t.agent)
			: [(firstStep as SequentialStep).agent];
		ctx.pi.events.emit(SUBAGENT_ASYNC_STARTED_EVENT, {
			id,
			pid: spawnResult.pid,
			agent: firstAgents[0],
			task: isParallelStep(firstStep)
				? firstStep.parallel[0]?.task?.slice(0, 50)
				: (firstStep as SequentialStep).task?.slice(0, 50),
			chain: chain.map((s) =>
				isParallelStep(s) ? `[${s.parallel.map((t) => t.agent).join("+")}]` : (s as SequentialStep).agent,
			),
			cwd: runnerCwd,
			asyncDir,
		});
	}

	const chainDesc = chain
		.map((s) =>
			isParallelStep(s) ? `[${s.parallel.map((t) => t.agent).join("+")}]` : (s as SequentialStep).agent,
		)
		.join(" -> ");

	return {
		content: [{ type: "text", text: `Async chain: ${chainDesc} [${id}]` }],
		details: { mode: "chain", results: [], asyncId: id, asyncDir },
	};
}

/**
 * Execute a single agent asynchronously
 */
export function executeAsyncSingle(
	id: string,
	params: AsyncSingleParams,
): AsyncExecutionResult {
	const {
		agent,
		agentConfig,
		ctx,
		cwd,
		maxOutput,
		artifactsDir,
		artifactConfig,
		shareEnabled,
		sessionRoot,
		sessionFile,
		maxSubagentDepth,
		worktreeSetupHook,
		worktreeSetupHookTimeoutMs,
		controlConfig,
		controlIntercomTarget,
		childIntercomTarget,
	} = params;
	const task = params.task ?? "";
	const runnerCwd = resolveChildCwd(ctx.cwd, cwd);
	const forkReuse = params.forkReuse;
	const skillNames = forkReuse ? [] : (params.skills ?? agentConfig.skills ?? []);
	const availableModels = params.availableModels;
	const { resolved: resolvedSkills } = forkReuse
		? { resolved: [] }
		: resolveSkillsWithFallback(skillNames, runnerCwd, ctx.cwd);
	let systemPrompt = agentConfig.systemPrompt?.trim() ?? "";
	if (!forkReuse && resolvedSkills.length > 0) {
		const injection = buildSkillInjection(resolvedSkills);
		systemPrompt = systemPrompt ? `${systemPrompt}\n\n${injection}` : injection;
	}

	const asyncDir = path.join(ASYNC_DIR, id);
	try {
		fs.mkdirSync(asyncDir, { recursive: true });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			content: [{ type: "text", text: `Failed to create async run directory '${asyncDir}': ${message}` }],
			isError: true,
			details: { mode: "single" as const, results: [] },
		};
	}

	const outputPath = resolveSingleOutputPath(params.output, ctx.cwd, runnerCwd);
	const taskWithOutputInstruction = injectSingleOutputInstruction(task, outputPath);
	let spawnResult: { pid?: number; error?: string } = {};
	try {
		spawnResult = spawnRunner(
			{
				id,
				steps: [
					{
						agent,
						task: taskWithOutputInstruction,
						cwd: runnerCwd,
						model: forkReuse
							? undefined
							: applyThinkingSuffix(resolveModelCandidate(params.modelOverride ?? agentConfig.model, availableModels, ctx.currentModelProvider), agentConfig.thinking),
						modelCandidates: forkReuse
							? undefined
							: buildModelCandidates(params.modelOverride ?? agentConfig.model, agentConfig.fallbackModels, availableModels, ctx.currentModelProvider).map((candidate) =>
								applyThinkingSuffix(candidate, agentConfig.thinking),
							),
						tools: forkReuse ? undefined : agentConfig.tools,
						extensions: forkReuse ? undefined : agentConfig.extensions,
						mcpDirectTools: forkReuse ? undefined : agentConfig.mcpDirectTools,
						systemPrompt: forkReuse ? undefined : systemPrompt,
						systemPromptMode: forkReuse ? undefined : agentConfig.systemPromptMode,
						inheritProjectContext: forkReuse ? true : agentConfig.inheritProjectContext,
						inheritSkills: forkReuse ? true : agentConfig.inheritSkills,
						skills: resolvedSkills.map((r) => r.name),
						outputPath,
						sessionFile,
						maxSubagentDepth: resolveChildMaxSubagentDepth(maxSubagentDepth, agentConfig.maxSubagentDepth),
						preset: ctx.preset,
						runtimeMode: forkReuse ? "root" : "delegated",
						rootRoleName: forkReuse?.agentName,
						parentAgentName: ctx.parentAgentName,
						canDelegate: agentConfig.canDelegate,
						allowedDelegateAgents: agentConfig.allowedDelegateAgents,
					},
				],
				resultPath: path.join(RESULTS_DIR, `${id}.json`),
				cwd: runnerCwd,
				placeholder: "{previous}",
				maxOutput,
				artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
				artifactConfig,
				share: shareEnabled,
				sessionDir: sessionRoot ? path.join(sessionRoot, `async-${id}`) : undefined,
				asyncDir,
				sessionId: ctx.currentSessionId,
				piPackageRoot,
				piArgv1: process.argv[1],
				worktreeSetupHook,
				worktreeSetupHookTimeoutMs,
				controlConfig,
				controlIntercomTarget,
				childIntercomTargets: childIntercomTarget ? [childIntercomTarget(agent, 0)] : undefined,
			},
			id,
			runnerCwd,
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return formatAsyncStartError("single", `Failed to start async run '${id}': ${message}`);
	}

	if (spawnResult.error) {
		return formatAsyncStartError("single", `Failed to start async run '${id}': ${spawnResult.error}`);
	}

	if (spawnResult.pid) {
		ctx.pi.events.emit(SUBAGENT_ASYNC_STARTED_EVENT, {
			id,
			pid: spawnResult.pid,
			agent,
			task: task?.slice(0, 50),
			cwd: runnerCwd,
			asyncDir,
		});
	}

	return {
		content: [{ type: "text", text: `Async: ${agent} [${id}]` }],
		details: { mode: "single", results: [], asyncId: id, asyncDir },
	};
}
