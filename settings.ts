import type { AgentConfig } from "./agents.ts";

export interface ResolvedStepBehavior {
	output: string | false;
	reads: string[] | false;
	progress: boolean;
	skills: string[] | false;
	model?: string;
}

export interface StepOverrides {
	output?: string | false;
	reads?: string[] | false;
	progress?: boolean;
	skills?: string[] | false;
	model?: string;
}

export function resolveStepBehavior(
	agentConfig: AgentConfig,
	stepOverrides: StepOverrides,
): ResolvedStepBehavior {
	const output =
		stepOverrides.output !== undefined
			? stepOverrides.output
			: agentConfig.output ?? false;

	const reads =
		stepOverrides.reads !== undefined
			? stepOverrides.reads
			: agentConfig.defaultReads ?? false;

	const progress =
		stepOverrides.progress !== undefined
			? stepOverrides.progress
			: agentConfig.defaultProgress ?? false;

	let skills: string[] | false;
	if (stepOverrides.skills === false) {
		skills = false;
	} else if (stepOverrides.skills !== undefined) {
		skills = [...stepOverrides.skills];
	} else {
		skills = agentConfig.skills ? [...agentConfig.skills] : [];
	}

	const model = stepOverrides.model ?? agentConfig.model;
	return { output, reads, progress, skills, model };
}
