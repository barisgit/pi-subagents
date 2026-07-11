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
		// SDK 0.75 marks a registered tool call failed only when execute throws.
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
		description: `Delegate a bounded task to a named specialist agent, run several in parallel, fork same-role branches, or inspect/resume background runs. Use when a specialist or background run beats doing the work inline. Use the workflow tool for multi-step orchestration where a later step depends on an earlier step's result, needs branching, retry/fallback, loops, or runtime fan-out.

Shape: run: Task[] dispatches work. Multiple entries run in parallel.

Top fields: run work entries; async runs in the background and returns immediately with an id so the parent can keep working; batch collapses multi-entry completion notices into one rollup; worktree sets top-level isolated-worktree mode for parallel runs; message is shared dispatch framing or the next turn for action:"resume"; action is list/status/interrupt/resume; id targets status/interrupt (optional; newest run when omitted) and is required for resume.

Async/background contract: after starting an async run, do not wait by default with sleep/status loops. Pi will send a completion or needs-attention message and trigger a new turn when the run needs you. Continue independent work or stop if blocked on the result. Use status/sleep checks only for immediate management or genuinely necessary inspection.

Task fields: agent persona; task instruction; label status text; context "fresh"|"fork"; output path/boolean capture override.

Substitution: in message, {task} and {in} become each Task.task; at most one {in} per message. context defaults to "fresh". "fork" is same-agent self-branching only (same configured role continuing in a branch), never role switching; cross-agent delegation uses "fresh".

Examples:
// single
{ run:[{ agent:"<configured-role>", task:"Patch the bug" }] }
// parallel
{ run:[{ agent:"<investigation-role>", task:"Find relevant tests" },{ agent:"<verification-role>", task:"Run the checks" }], batch:true }

Run management: Use { action: "list" } when available agents are unknown or may have changed; execute only executable/non-disabled agents. Use action:"status" (id optional; lists all when omitted) / action:"interrupt" (id optional; newest running run when omitted) / action:"resume" id message.

Author agents as files under \`agents/<name>.md\`. For advanced patterns see skills/subagent.`,
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
