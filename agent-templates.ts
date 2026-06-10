export type TemplateItem =
	| { type: "agent"; name: string; description: string }
	| { type: "separator"; label: string };

export const AGENT_TEMPLATES: TemplateItem[] = [
	{ type: "separator", label: "Built-in Roles" },
	{ type: "agent", name: "explorer", description: "Recon, call tracing, and locating relevant code/tests" },
	{ type: "agent", name: "fixer", description: "Bounded implementation changes and local verification" },
	{ type: "agent", name: "qa", description: "Runtime validation, builds, tests, and artifacts" },
	{ type: "agent", name: "review", description: "Read-only correctness and regression critique" },
	{ type: "agent", name: "oracle", description: "Strategy, architecture, and hard-debug direction" },
];
