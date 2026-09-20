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
		description: `Delegate bounded work to configured agents, or manage existing runs. Plain subagents may form agent-directed delegation trees. Use \`workflow\` when later dispatch depends on earlier results or needs programmable control flow.

\`run\` accepts one or more entries; multiple entries execute in parallel. A shared \`message\` templates the entries with \`{task}\` and at most one \`{in}\` substitution. \`batch\` groups completion notices. Top-level \`cwd\` defaults every entry and resolves from the caller cwd; an entry \`cwd\` overrides it and resolves from that top-level cwd. \`context\` defaults to \`"fresh"\`; \`"fork"\` is same-role self-branching, while delegation to another configured role uses \`"fresh"\`.

\`async\` returns immediately. Calls made from a child session are forced to synchronous execution unless extension config explicitly enables \`allowNestedAsync\`; with that opt-in, completion starts a new turn in the immediate parent session. After any async dispatch, leave the delegated scope to the child and do not poll or duplicate its work; Pi reports completion or attention needs in a new turn.

Use \`action\` to list, inspect, interrupt, or resume runs. Resume requires \`id\` and \`message\`: it steers a live run without first interrupting it, and may restart a terminal run that has a saved session. Interrupt only work that must stop. When configured roles are unknown or may have changed, use { action: "list" } and choose an executable/non-disabled role. Agents are defined under \`agents/<name>.md\`.`,
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
