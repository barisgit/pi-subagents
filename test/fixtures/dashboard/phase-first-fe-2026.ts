import type { LiveRun, RunView } from "../../../src/state/run-view.ts";

const START = 4_000_000_000_000;
const TOKENS = { input: 80, output: 20, total: 100 };

interface StageOptions {
	id: string;
	agent: string;
	state: RunView["state"];
	phaseIndex: number;
	phaseTitle: string;
	pipelineId: string;
	pipelineName: string;
	itemIndex: number;
	itemLabel: string;
	stageIndex: number;
	stageTitle: string;
	stageCount: number;
	itemCount: number;
	finalOutput?: string;
	currentTool?: string;
	recentTools?: Array<{ tool: string; args: string; endMs: number }>;
	error?: string;
}

function stage(options: StageOptions): RunView {
	const running = options.state === "running";
	return {
		id: options.id,
		parentRunId: "fe-2026",
		mode: "single",
		state: options.state,
		startedAt: START + options.stageIndex * 10_000 + options.itemIndex * 2_000,
		...(running ? {} : { endedAt: START + options.stageIndex * 10_000 + options.itemIndex * 2_000 + 1_000 }),
		phaseIndex: options.phaseIndex,
		phaseTitle: options.phaseTitle,
		pipeline: {
			id: options.pipelineId,
			name: options.pipelineName,
			itemIndex: options.itemIndex,
			itemLabel: options.itemLabel,
			stageIndex: options.stageIndex,
			stageTitle: options.stageTitle,
			stageCount: options.stageCount,
			itemCount: options.itemCount,
		},
		currentAgent: options.agent,
		...(options.currentTool ? { currentTool: options.currentTool, currentToolStartedAt: START } : {}),
		...(options.recentTools ? { recentTools: options.recentTools } : {}),
		...(options.finalOutput ? { finalOutput: options.finalOutput } : {}),
		totalTokens: TOKENS,
		steps: [
			{
				index: 0,
				agent: options.agent,
				status: options.state,
				...(options.error ? { error: options.error } : {}),
				tokens: TOKENS,
				durationMs: running ? 0 : 1_000,
			},
		],
	};
}

export const fe2026Runs: RunView[] = [
	{
		id: "fe-2026",
		workflow: true,
		workflowMeta: {
			name: "Frontend Feature FE-2026",
			description: "Research, implement, and validate the frontend feature.",
			phases: [{ title: "Raziskava" }, { title: "Implementacija" }, { title: "Validacija" }],
		},
		mode: "parallel",
		state: "running",
		startedAt: START,
		steps: [],
	},
	stage({
		id: "draft-research-a",
		agent: "explorer",
		state: "complete",
		phaseIndex: 1,
		phaseTitle: "Raziskava",
		pipelineId: "drafts",
		pipelineName: "Osnutki",
		itemIndex: 0,
		itemLabel: "Prijava",
		stageIndex: 0,
		stageTitle: "Raziskava",
		stageCount: 2,
		itemCount: 2,
		finalOutput: "Raziskava za prijavo je končana.",
	}),
	stage({
		id: "draft-research-b",
		agent: "explorer",
		state: "complete",
		phaseIndex: 1,
		phaseTitle: "Raziskava",
		pipelineId: "drafts",
		pipelineName: "Osnutki",
		itemIndex: 1,
		itemLabel: "Profil",
		stageIndex: 0,
		stageTitle: "Raziskava",
		stageCount: 2,
		itemCount: 2,
		finalOutput: "Raziskava za profil je končana.",
	}),
	{
		id: "research-fix",
		parentRunId: "fe-2026",
		mode: "single",
		state: "complete",
		startedAt: START,
		endedAt: START + 1_000,
		phaseIndex: 1,
		phaseTitle: "Raziskava",
		currentAgent: "fixer",
		totalTokens: TOKENS,
		steps: [{ index: 0, agent: "fixer", status: "complete", durationMs: 1_000, tokens: TOKENS }],
	},
	stage({
		id: "draft-build-a",
		agent: "fixer",
		state: "complete",
		phaseIndex: 2,
		phaseTitle: "Implementacija",
		pipelineId: "drafts",
		pipelineName: "Osnutki",
		itemIndex: 0,
		itemLabel: "Prijava",
		stageIndex: 1,
		stageTitle: "Osnutek",
		stageCount: 2,
		itemCount: 2,
		finalOutput: "Osnutek prijave je pripravljen.",
	}),
	stage({
		id: "draft-build-b",
		agent: "fixer",
		state: "running",
		phaseIndex: 2,
		phaseTitle: "Implementacija",
		pipelineId: "drafts",
		pipelineName: "Osnutki",
		itemIndex: 1,
		itemLabel: "Profil",
		stageIndex: 1,
		stageTitle: "Osnutek",
		stageCount: 2,
		itemCount: 2,
		recentTools: [{ tool: "read", args: "src/profile.ts", endMs: START }],
	}),
	stage({
		id: "verify-test-a",
		agent: "operator",
		state: "complete",
		phaseIndex: 3,
		phaseTitle: "Validacija",
		pipelineId: "verification",
		pipelineName: "Preverjanje",
		itemIndex: 0,
		itemLabel: "Prijava",
		stageIndex: 0,
		stageTitle: "Testi",
		stageCount: 2,
		itemCount: 2,
		finalOutput: "Testi prijave so uspešni.",
	}),
	stage({
		id: "verify-test-b",
		agent: "operator",
		state: "running",
		phaseIndex: 3,
		phaseTitle: "Validacija",
		pipelineId: "verification",
		pipelineName: "Preverjanje",
		itemIndex: 1,
		itemLabel: "Profil",
		stageIndex: 0,
		stageTitle: "Testi",
		stageCount: 2,
		itemCount: 2,
		currentTool: "bash",
	}),
	stage({
		id: "verify-review-a",
		agent: "reviewer",
		state: "failed",
		phaseIndex: 3,
		phaseTitle: "Validacija",
		pipelineId: "verification",
		pipelineName: "Preverjanje",
		itemIndex: 0,
		itemLabel: "Prijava",
		stageIndex: 1,
		stageTitle: "Pregled",
		stageCount: 2,
		itemCount: 2,
		finalOutput: "Pregled ni uspel.",
		error: "Najdena regresija",
	}),
];

export const fe2026LiveRuns: LiveRun[] = fe2026Runs.map((run) => ({ ownership: "live", run }));
