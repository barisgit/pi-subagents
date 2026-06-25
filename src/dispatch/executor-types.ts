import type { AgentToolResult, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type { TSchema } from "typebox";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentConfig, AgentScope } from "../shared/agents.ts";
import type {
	ArtifactConfig,
	ControlConfig,
	Details,
	ExtensionConfig,
	ForkReuseConfig,
	MaxOutputConfig,
	ResolvedControlConfig,
	SubagentMetadata,
	SubagentState,
} from "../protocol/types.ts";
import type { ChildAgentRegistry } from "./child-agent-registry.ts";
import type { IntercomBridgeState } from "./intercom-bridge.ts";
import type { StatusWriter } from "../state/status-writer.ts";
import type { SingleOutputSnapshot } from "../surfaces/single-output.ts";

export interface ModelInfo {
	provider: string;
	id: string;
	fullId: string;
}

export interface TaskParam {
	agent: string;
	task: string;
	/** Caller-provided short summary (~5-10 words) shown in widgets and status overlays. */
	label?: string;
	cwd?: string;
	count?: number;
	model?: string;
	skill?: string | string[] | boolean;
}

export interface ResolvedAgentConfig {
	name: string;
	description?: string;
	systemPrompt?: string;
	tools?: string[];
	mcpDirectTools?: string[];
	model?: string;
	fallbackModels?: string[];
	thinking?: string;
	skills?: string[];
	[key: string]: unknown;
}

export interface ChildAgentStep {
	runId: string;
	stepIndex: number;
	agentName: string;
	agentConfig: ResolvedAgentConfig;
	task: string;
	cwd: string;
	model: Model<any>;
	modelCandidates: Model<any>[];
	thinkingLevel?: ThinkingLevel;
	/**
	 * Tool allowlist for the child session.
	 * - undefined: no allowlist (child sees ALL tools registered by pi + extensions)
	 * - string[]: exact allowlist (use empty array for zero tools)
	 */
	activeToolNames: string[] | undefined;
	customTools: ToolDefinition[];
	systemPrompt: string;
	/**
	 * Additive system-prompt text delivered through the loader's append channel
	 * (never clobbers an inherited/fork-reuse prompt). Carries the output finish
	 * contract and, on the workflow path, the result-schema shape instruction.
	 */
	systemPromptAppend?: string;
	/**
	 * Workflow-authored TypeBox schema for the child's <output> result (workflow
	 * path only). The executor validates the extracted block against it and reprompts
	 * a non-compliant child; undefined keeps the default string result.
	 */
	resultSchema?: TSchema;
	skillsResolved: string[];
	sessionFile: string;
	runRecordDir: string;
	forkReuse?: { sessionFile: string; agentName: string };
	intercom?: { selfTarget?: string; bridgeTarget?: string };
	artifactsDir?: string;
	label?: string;
	parentAgentName?: string;
	parentSessionId?: string;
	rootSessionId?: string;
	rootRunId?: string;
	maxSubagentDepth: number;
	preset?: string;
	shareEnabled: boolean;
	controlConfig?: ControlConfig;
	outputPath?: string;
}

export interface InternalSubagentParams {
	action?: string;
	id?: string;
	runId?: string;
	dir?: string;
	agent?: string;
	task?: string;
	/** Caller-provided short summary (~5-10 words) shown in widgets and status overlays. */
	label?: string;
	tasks?: TaskParam[];
	prompt?: string;
	message?: string;
	worktree?: boolean;
	batch?: boolean;
	context?: "fresh" | "fork";
	async?: boolean;
	clarify?: boolean;
	share?: boolean;
	control?: ControlConfig;
	sessionDir?: string;
	cwd?: string;
	maxOutput?: MaxOutputConfig;
	artifacts?: boolean;
	includeProgress?: boolean;
	model?: string;
	skill?: string | string[] | boolean;
	output?: string | boolean;
	agentScope?: unknown;
	preset?: string;
	metadata?: SubagentMetadata;
	rawAgentConfig?: AgentConfig;
}

export interface ExecutorDeps {
	pi: ExtensionAPI;
	state: SubagentState;
	config: ExtensionConfig;
	asyncByDefault: boolean;
	tempArtifactsDir: string;
	childRegistry: ChildAgentRegistry;
	expandTilde: (p: string) => string;
	discoverAgents: (
		cwd: string,
		scope: AgentScope,
		options?: { preset?: string; includeInternal?: boolean },
	) => { agents: AgentConfig[] };
	getActiveRootRoleName?: () => string | undefined;
}

export interface ExecutionContextData {
	params: InternalSubagentParams;
	effectiveCwd: string;
	ctx: ExtensionContext;
	signal: AbortSignal;
	onUpdate?: (r: AgentToolResult<Details>) => void;
	agents: AgentConfig[];
	runId: string;
	rootRunId: string;
	shareEnabled: boolean;
	sessionRoot: string;
	sessionDirForIndex: (idx?: number) => string;
	sessionFileForIndex: (idx?: number) => string | undefined;
	artifactConfig: ArtifactConfig;
	artifactsDir: string;
	backgroundRequestedWhileClarifying: boolean;
	effectiveAsync: boolean;
	controlConfig: ResolvedControlConfig;
	intercomBridge: IntercomBridgeState;
	forkReuse?: ForkReuseConfig;
	/** Single-foreground sync status writer (TERMINAL policy); used by runSinglePath mirror/update. */
	foregroundStatusWriter?: StatusWriter;
}

export type ForegroundControlRef = SubagentState["foregroundControls"] extends Map<string, infer T> ? T : never;

export interface AsyncDispatchStep {
	step: ChildAgentStep;
	cleanTask: string;
	agentConfig: AgentConfig;
	outputSnapshot?: SingleOutputSnapshot;
}
