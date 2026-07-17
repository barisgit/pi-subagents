import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { Details, SubagentToolResult } from "../protocol/types.ts";
import { SubagentParams } from "../protocol/schemas.ts";
import { createWorkflowTool } from "../workflow/workflow.ts";
import { renderSubagentResult, syncResultAnimation } from "../surfaces/render-result.ts";
import type { createSubagentExecutor } from "./subagent-executor.ts";

export function createSubagentToolDefinitions(deps: { executor: ReturnType<typeof createSubagentExecutor> }): {
	tool: ToolDefinition<typeof SubagentParams, Details>;
	workflowTool: ReturnType<typeof createWorkflowTool>;
} {
	const { executor } = deps;
	const throwEmptyFailure = <T>(result: SubagentToolResult<T>): SubagentToolResult<T> => {
		// The Pi SDK marks a registered tool call failed only when execute throws.
		// Preserve populated Details for partial child failures; empty failures carry
		// no renderer/persistence value beyond their text and must use the SDK path.
		const details = result.details;
		const hasResults =
			details !== null &&
			typeof details === "object" &&
			"results" in details &&
			Array.isArray(details.results) &&
			details.results.length > 0;
		if (result.isError && !hasResults) {
			const text = result.content.find((part) => part.type === "text")?.text ?? "Subagent tool failed";
			throw new Error(text);
		}
		return result;
	};

	const tool: ToolDefinition<typeof SubagentParams, Details> = {
		name: "subagent",
		label: "Subagent",
		promptSnippet: "Delegate to subagents or manage runs",
		description: `Delegate a bounded task to a configured agent or inspect/resume background runs. Use \`workflow\` when later steps depend on earlier results or require branching, retries, loops, or runtime fan-out.

\`run\` dispatches work; multiple entries run in parallel. \`async\` returns immediately, \`batch\` groups completion notices, and \`worktree\` isolates parallel edits. Shared \`message\` text supports \`{task}\` and at most one \`{in}\` substitution.

\`context\` defaults to \`"fresh"\`. \`"fork"\` is same-role self-branching only, never a role switch; cross-agent delegation uses \`"fresh"\`.

Use \`action\` to list, inspect, interrupt, or resume runs; resume requires \`id\` and \`message\`. Resume steers a live run with new instructions without interrupting first; use interrupt only when the current work must stop. A terminal run with a saved session can also be resumed. Use { action: "list" } when available agents are unknown or may have changed, and select only executable/non-disabled agents.

After an async dispatch, continue independent work or stop if blocked. Do not poll; Pi sends a new turn when a run completes or needs attention. Agents are files under \`agents/<name>.md\`.`,
		parameters: SubagentParams,

		async execute(id, params, signal, onUpdate, ctx) {
			const result = await executor.execute(
				id,
				params as unknown as Parameters<typeof executor.execute>[1],
				signal as AbortSignal,
				onUpdate,
				ctx,
			);
			return throwEmptyFailure(result);
		},

		renderCall(args, theme) {
			if (args.action) {
				const target = args.id || "";
				return new Text(
					`${theme.fg("toolTitle", theme.bold("subagent "))}${args.action}${target ? ` ${theme.fg("accent", target)}` : ""}`,
					0,
					0,
				);
			}
			const run = args.run ?? [];
			const asyncLabel = args.async === true ? theme.fg("warning", " [background]") : "";
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

	const workflowTool = createWorkflowTool({
		openWorkflowGroup: (workflowContext) => executor.openWorkflowGroup(workflowContext),
	});
	const executeWorkflow = workflowTool.execute;
	if (executeWorkflow) {
		workflowTool.execute = async (...args) => throwEmptyFailure(await executeWorkflow(...args));
	}
	workflowTool.renderResult = (result, options, theme, context) => {
		const subagentResult = result as SubagentToolResult;
		syncResultAnimation(subagentResult, context);
		return renderSubagentResult(subagentResult, options, theme);
	};

	return { tool, workflowTool };
}
