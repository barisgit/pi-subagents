/**
 * TypeBox schemas for subagent tool parameters.
 */

import { Type, type Static } from "typebox";

const OutputOverride = Type.Union([Type.String(), Type.Boolean()], {
	description: "Output path, true default, or false disabled.",
});

// Future context mode `summarized` is reserved; current runtime accepts fresh/fork only.
export const TaskSchema = Type.Object(
	{
		agent: Type.String({ description: "Agent persona to invoke." }),
		task: Type.String({ description: "Concrete instruction for that agent." }),
		label: Type.Optional(Type.String({ description: "Short status/notification label." })),
		context: Type.Optional(
			Type.Union([Type.Literal("fresh"), Type.Literal("fork")], {
				description: "fresh is default; fork is same-agent self-branching only.",
			}),
		),
		cwd: Type.Optional(
			Type.String({ description: "Run working directory; relative paths resolve from the top-level cwd." }),
		),
		output: Type.Optional(OutputOverride),
	},
	{ additionalProperties: false },
);

export const StepSchema = TaskSchema;

export const SubagentParams = Type.Object(
	{
		run: Type.Optional(Type.Array(StepSchema, { minItems: 1, description: "Work to dispatch." })),
		async: Type.Optional(Type.Boolean({ description: "Run detached (returns immediately)." })),
		batch: Type.Optional(Type.Boolean({ description: "Collapse completion notifications into one rollup." })),
		cwd: Type.Optional(
			Type.String({ description: "Default run cwd; relative paths resolve from the caller/session cwd." }),
		),
		message: Type.Optional(
			Type.String({
				description:
					"Shared dispatch framing, or instructions to steer/resume a run without interrupting first.",
			}),
		),
		action: Type.Optional(
			Type.Union(
				[Type.Literal("list"), Type.Literal("status"), Type.Literal("interrupt"), Type.Literal("resume")],
				{
					description: "Control action; omit for dispatch. Resume can steer a live run directly.",
				},
			),
		),
		id: Type.Optional(Type.String({ description: "Run/batch id for status, interrupt, or resume." })),
	},
	{ additionalProperties: false },
);

export type Task = Static<typeof TaskSchema>;
export type SubagentToolInput = {
	run?: Task[];
	async?: boolean;
	batch?: boolean;
	cwd?: string;
	message?: string;
	action?: "list" | "status" | "interrupt" | "resume";
	id?: string;
};
