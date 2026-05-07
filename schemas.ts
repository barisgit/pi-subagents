/**
 * TypeBox schemas for subagent tool parameters
 */

import { Type } from "typebox";

const SkillOverride = Type.Union([
	Type.Boolean(),
	Type.Array(Type.String()),
	Type.String(),
], {
	description: "Skill override: string, string[], true default, or false disabled",
});

const OutputOverride = Type.Union([
	Type.Boolean(),
	Type.String(),
], {
	description: "Output path, true default, or false disabled",
});

const ReadsOverride = Type.Union([
	Type.Array(Type.String()),
	Type.Boolean(),
], {
	description: "Files to read first, or false disabled",
});

export const TaskItem = Type.Object({ 
	agent: Type.Optional(Type.String({ description: "Agent; optional with top-level agent." })), 
	task: Type.String(), 
	cwd: Type.Optional(Type.String()),
	count: Type.Optional(Type.Integer({ minimum: 1, description: "Repeat task N times." })),
	model: Type.Optional(Type.String({ description: "Model override" })),
	skill: Type.Optional(SkillOverride),
});

export const TopLevelTaskItem = Type.Union([
	Type.Object({
		agent: Type.Optional(Type.String({ description: "Agent; optional with top-level agent." })),
		task: Type.String(),
		cwd: Type.Optional(Type.String()),
		count: Type.Optional(Type.Integer({ minimum: 1, description: "Repeat task N times." })),
		model: Type.Optional(Type.String({ description: "Model override" })),
		skill: Type.Optional(SkillOverride),
	}, { additionalProperties: true }),
	Type.String(),
], {
	description: "Parallel/swarm item; string shorthand allowed with top-level agent.",
});

// Sequential chain step (single agent)
export const SequentialStepSchema = Type.Object({
	agent: Type.String(),
	task: Type.Optional(Type.String({ 
		description: "Task template; supports {task}, {previous}, {chain_dir}." 
	})),
	cwd: Type.Optional(Type.String()),
	output: Type.Optional(OutputOverride),
	reads: Type.Optional(ReadsOverride),
	progress: Type.Optional(Type.Boolean({ description: "Track progress.md in {chain_dir}" })),
	skill: Type.Optional(SkillOverride),
	model: Type.Optional(Type.String({ description: "Model override" })),
});

// Parallel task item (within a parallel step)
export const ParallelTaskSchema = Type.Object({
	agent: Type.String(),
	task: Type.Optional(Type.String({ description: "Task template; supports {task}, {previous}, {chain_dir}." })),
	cwd: Type.Optional(Type.String()),
	count: Type.Optional(Type.Integer({ minimum: 1, description: "Repeat task N times." })),
	output: Type.Optional(OutputOverride),
	reads: Type.Optional(ReadsOverride),
	progress: Type.Optional(Type.Boolean({ description: "Track progress.md in {chain_dir}" })),
	skill: Type.Optional(SkillOverride),
	model: Type.Optional(Type.String({ description: "Model override" })),
});

// Parallel chain step (multiple agents running concurrently)
export const ParallelStepSchema = Type.Object({
	parallel: Type.Array(ParallelTaskSchema, { minItems: 1, description: "Parallel tasks" }),
	prompt: Type.Optional(Type.String({ description: "Shared prompt; {in} inserts task text." })),
	concurrency: Type.Optional(Type.Number({ description: "Max concurrent tasks" })),
	failFast: Type.Optional(Type.Boolean({ description: "Stop on first failure" })),
	worktree: Type.Optional(Type.Boolean({
		description: "Isolated git worktrees per parallel task."
	})),
});

// Flattened so providers that reject anyOf/oneOf can still accept either sequential or parallel steps.
export const ChainItem = Type.Object({
	agent: Type.Optional(Type.String({ description: "Sequential step agent" })),
	task: Type.Optional(Type.String({
		description: "Task template; supports {task}, {previous}, {chain_dir}."
	})),
	cwd: Type.Optional(Type.String()),
	output: Type.Optional(OutputOverride),
	reads: Type.Optional(ReadsOverride),
	progress: Type.Optional(Type.Boolean({ description: "Track progress.md in {chain_dir}" })),
	skill: Type.Optional(SkillOverride),
	model: Type.Optional(Type.String({ description: "Model override" })),
	parallel: Type.Optional(Type.Array(ParallelTaskSchema, { minItems: 1, description: "Parallel tasks" })),
	concurrency: Type.Optional(Type.Number({ description: "Max concurrent tasks" })),
	failFast: Type.Optional(Type.Boolean({ description: "Stop on first failure" })),
	worktree: Type.Optional(Type.Boolean({
		description: "Isolated git worktrees per parallel task."
	})),
}, { description: "Chain step: sequential {agent, task?} or parallel {parallel}." });

export const ControlOverrides = Type.Object({
	enabled: Type.Optional(Type.Boolean({ description: "Enable control tracking" })),
	needsAttentionAfterMs: Type.Optional(Type.Integer({ minimum: 1, description: "Idle ms before attention notice" })),
	notifyOn: Type.Optional(Type.Array(Type.String({ enum: ["needs_attention"] }), {
		description: "Control events to notify on.",
	})),
	notifyChannels: Type.Optional(Type.Array(Type.String({ enum: ["event", "async", "intercom"] }), {
		description: "Notification channels.",
	})),
});

export const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Agent name or management target" })),
	task: Type.Optional(Type.String({ description: "Single-agent task; optional for self-contained agents" })),
	// Management action (when present, tool operates in management mode)
	action: Type.Optional(Type.String({
		description: "Action: list/get/create/update/delete/status/interrupt; omit for execution."
	})),
	id: Type.Optional(Type.String({
		description: "Run id/prefix for status or interrupt."
	})),
	runId: Type.Optional(Type.String({
		description: "Interrupt target run ID; prefer id."
	})),
	dir: Type.Optional(Type.String({
		description: "Async run directory for status."
	})),
	// Chain identifier for management (can't reuse 'chain' — that's the execution array)
	chainName: Type.Optional(Type.String({
		description: "Chain name for management actions"
	})),
	// Agent/chain configuration for create/update (nested to avoid conflicts with execution fields)
	config: Type.Optional(Type.Union([
		Type.Object({}, { additionalProperties: true }),
		Type.String(),
	], {
		description: "Agent/chain config; include name/description/systemPrompt. String must be JSON; steps creates a chain."
	})),
	tasks: Type.Optional(Type.Array(TopLevelTaskItem, { description: "Parallel/swarm tasks; strings allowed with top-level agent." })),
	concurrency: Type.Optional(Type.Integer({ minimum: 1, description: "Max concurrent top-level parallel tasks" })),
	worktree: Type.Optional(Type.Boolean({
		description: "Isolated git worktrees for parallel tasks; requires clean git state."
	})),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Sequential/parallel chain; {previous} is prior result." })),
	prompt: Type.Optional(Type.String({ description: "Shared swarm prompt; {in} inserts task text." })),
	preset: Type.Optional(Type.String({ description: "Preset override; env fallback PI_PRESET/OH_MY_OPENCODE_SLIM_PRESET." })),
	context: Type.Optional(Type.String({
		enum: ["fresh", "fork"],
		description: "'fresh' default; 'fork' only for same-role session branching",
	})),
	chainDir: Type.Optional(Type.String({ description: "Persistent chain artifact directory" })),
	async: Type.Optional(Type.Boolean({ description: "Run in background" })),
	agentScope: Type.Optional(Type.String({ description: "Agent discovery scope: user, project, or both" })),
	cwd: Type.Optional(Type.String()),
	artifacts: Type.Optional(Type.Boolean({ description: "Write debug artifacts" })),
	includeProgress: Type.Optional(Type.Boolean({ description: "Include full progress" })),
	share: Type.Optional(Type.Boolean({ description: "Upload session to GitHub Gist" })),
	sessionDir: Type.Optional(
		Type.String({ description: "Session log directory" }),
	),
	// Clarification TUI
	clarify: Type.Optional(Type.Boolean({ description: "Show preview/edit TUI; implies sync" })),
	control: Type.Optional(ControlOverrides),
	// Solo agent overrides
	output: Type.Optional(Type.Union([
		Type.Boolean(),
		Type.String(),
	], {
		description: "Single-agent output path, or false disabled.",
	})),
	skill: Type.Optional(SkillOverride),
	model: Type.Optional(Type.String({ description: "Single-agent model override" })),
});
