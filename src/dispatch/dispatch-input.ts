import type { InternalSubagentParams, TaskParam } from "./executor-types.ts";
import { validationError } from "./executor-helpers.ts";
import type { SubagentToolResult } from "../protocol/types.ts";
import { buildRequestedModeError } from "./execution-input.ts";

// "preset" is not part of the model-facing tool schema (additionalProperties:
// false blocks it there); it is accepted here so internal surfaces such as the
// slash commands can thread a resolved preset into dispatch.
const SLIM_TOP_LEVEL_KEYS = new Set(["run", "async", "batch", "worktree", "message", "action", "id", "preset"]);
const SLIM_TASK_KEYS = new Set(["agent", "task", "label", "context", "output"]);
export const ALLOWED_CONTROL_ACTIONS = ["list", "status", "interrupt", "resume"] as const;
const REMOVED_CRUD_ACTIONS = new Set(["create", "update", "delete", "get"]);
function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function validateSlimTask(task: unknown, pathLabel: string): SubagentToolResult | null {
	if (!isRecord(task)) return validationError(`${pathLabel} must be a task with agent and task.`);
	const unknownKey = Object.keys(task).find((key) => !SLIM_TASK_KEYS.has(key));
	if (unknownKey) return validationError(`Unknown task key '${unknownKey}' at ${pathLabel}.`);
	if (typeof task.agent !== "string" || typeof task.task !== "string") {
		return validationError(`${pathLabel} must be a task with agent and task.`);
	}
	// Same-agent enforcement for context:"fork" happens at dispatch time in
	// resolveForkReuseConfig, where the current agent identity is known.
	return null;
}
function isTaskStep(step: unknown): step is TaskParam {
	return isRecord(step) && typeof step.agent === "string" && typeof step.task === "string";
}
export function applySharedMessage(message: string, task: string): string {
	if (message === "") return task;
	if (message.includes("{task}") || message.includes("{in}")) {
		return message.replaceAll("{task}", task).replaceAll("{in}", task);
	}
	return `${message}\n\n${task}`;
}
export function normalizeRunDispatchParams(params: InternalSubagentParams): {
	params?: InternalSubagentParams;
	error?: SubagentToolResult;
} {
	const slimValidationError = validateSubagentToolInput(params);
	if (slimValidationError) return { error: slimValidationError };
	const input = params as InternalSubagentParams & { run?: unknown[]; message?: string };
	if (!Array.isArray(input.run) || input.run.length === 0) {
		return { error: validationError("`run` must contain at least one task") };
	}
	if (input.message) {
		const placeholderCount = (input.message.match(/\{in\}/g) ?? []).length;
		if (placeholderCount > 1) {
			return {
				error: validationError(
					`message contains ${placeholderCount} occurrences of {in}; only one is allowed.`,
				),
			};
		}
	}
	const firstNestedIndex = input.run.findIndex(Array.isArray);
	if (firstNestedIndex !== -1) {
		return {
			error: validationError(
				"Nested Task[] dispatch is no longer supported; use the workflow tool for orchestration.",
			),
		};
	}
	const tasks = input.run as TaskParam[];
	const invalidIndex = tasks.findIndex((task) => !isTaskStep(task));
	if (invalidIndex !== -1) {
		return { error: validationError(`run[${invalidIndex}] must be a task with agent and task.`) };
	}
	if (tasks.length === 1) {
		const [task] = tasks;
		const singleTask = task! as TaskParam & { context?: "fresh" | "fork"; output?: string | boolean };
		const taskText = input.message ? applySharedMessage(input.message, singleTask.task) : singleTask.task;
		return {
			params: {
				...params,
				agent: singleTask.agent,
				task: taskText,
				...(singleTask.label ? { label: singleTask.label } : { label: undefined }),
				...(singleTask.context ? { context: singleTask.context } : { context: undefined }),
				...(singleTask.output !== undefined ? { output: singleTask.output } : {}),
				tasks: undefined,
				message: undefined,
				prompt: undefined,
			},
		};
	}
	const parallelTasks = input.message
		? tasks.map((task) => ({ ...task, task: applySharedMessage(input.message!, task.task) }))
		: tasks;
	return {
		params: {
			...params,
			agent: undefined,
			task: undefined,
			tasks: parallelTasks,
			message: undefined,
			prompt: undefined,
		},
	};
}
export function validateSubagentToolInput(input: unknown): SubagentToolResult | null {
	if (!isRecord(input)) return null;
	const action = typeof input.action === "string" ? input.action : undefined;
	if (action && REMOVED_CRUD_ACTIONS.has(action)) {
		return validationError(
			`Author agents as files under agents/<name>.md instead of action:"${action}". Allowed actions: ${ALLOWED_CONTROL_ACTIONS.join(", ")}.`,
		);
	}
	if (action && !(ALLOWED_CONTROL_ACTIONS as readonly string[]).includes(action)) {
		return validationError(`Unknown action: ${action}. Allowed actions: ${ALLOWED_CONTROL_ACTIONS.join(", ")}.`);
	}
	if (action === "resume") {
		if (Object.hasOwn(input, "run")) return validationError("resume is per-run; do not supply `run`");
		if (Object.hasOwn(input, "agent"))
			return validationError("resume takes only `message`; do not supply `agent` or Task");
		if (!Object.hasOwn(input, "id")) return validationError("resume requires `id` (runId)");
		if (!Object.hasOwn(input, "message")) return validationError("resume requires `message` to send to the child");
	}
	const unknownKey = Object.keys(input).find((key) => !SLIM_TOP_LEVEL_KEYS.has(key));
	if (unknownKey) {
		if (unknownKey === "prompt")
			return validationError("Unknown top-level key 'prompt'; `prompt` renamed to `message`.");
		return validationError(`Unknown top-level key '${unknownKey}'.`);
	}
	if (!Array.isArray(input.run)) return null;
	if (input.run.length === 0) return validationError("`run` must contain at least one task");
	for (let i = 0; i < input.run.length; i++) {
		const step = input.run[i];
		if (Array.isArray(step)) {
			if (input.parallel !== true)
				return validationError(
					"Nested Task[] dispatch is no longer supported; use the workflow tool for orchestration.",
				);
			for (let j = 0; j < step.length; j++) {
				const error = validateSlimTask(step[j], `run[${i}][${j}]`);
				if (error) return error;
			}
			continue;
		}
		const error = validateSlimTask(step, `run[${i}]`);
		if (error) return error;
	}
	return null;
}
function expandTopLevelTaskCounts(tasks: TaskParam[]): { tasks?: TaskParam[]; error?: string } {
	const expanded: TaskParam[] = [];
	for (let taskIndex = 0; taskIndex < tasks.length; taskIndex++) {
		const task = tasks[taskIndex]!;
		const rawCount = (task as TaskParam & { count?: unknown }).count;
		if (rawCount !== undefined && (typeof rawCount !== "number" || !Number.isInteger(rawCount) || rawCount < 1)) {
			return { error: `tasks[${taskIndex}].count must be an integer >= 1` };
		}
		const { count, ...concreteTask } = task;
		for (let repeat = 0; repeat < (rawCount ?? 1); repeat++) {
			expanded.push({ ...concreteTask });
		}
	}
	return { tasks: expanded };
}
export function normalizeRepeatedParallelCounts(params: InternalSubagentParams): {
	params?: InternalSubagentParams;
	error?: SubagentToolResult;
} {
	if (params.tasks) {
		const expandedTasks = expandTopLevelTaskCounts(params.tasks);
		if (expandedTasks.error) {
			return { error: buildRequestedModeError(params, expandedTasks.error) };
		}
		return { params: { ...params, tasks: expandedTasks.tasks } };
	}
	return { params };
}
