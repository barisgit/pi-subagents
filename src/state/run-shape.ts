/**
 * Pure helpers that centralize how parallel/single run shapes are labeled across
 * spawn confirmations, completion notifications, the live widget, and the
 * /subagents-status dashboard. No I/O, no on-disk state.
 */

export type RunMode = "single" | "parallel";

type RunHandleStyle = "compact" | "verbose";

export interface RunHandleInput {
	mode: RunMode;
	agents: string[];
	style?: RunHandleStyle;
}

export function formatRunHandle(input: RunHandleInput): string {
	const agents = input.agents;
	if (agents.length === 0) return "subagent";
	if (input.mode === "single" || agents.length === 1) return agents[0]!;
	const style = input.style ?? "compact";
	if (style === "verbose") return `[${agents.join(", ")}]`;
	return `parallel:${agents.join("+")}`;
}

export type AgentLabelDescription =
	| { kind: "single"; name: string; color?: string }
	| { kind: "uniformParallel"; total: number; name: string; color?: string }
	| { kind: "mixedParallel"; agents: Array<{ name: string; color?: string }> };

export function describeAgentLabel(
	agents: string[],
	mode: RunMode,
	fallbackColor?: string,
	agentColors?: Array<string | undefined>,
): AgentLabelDescription {
	if (agents.length === 0) return { kind: "single", name: "subagent", color: fallbackColor };
	if (mode === "single") return { kind: "single", name: agents[0]!, color: agentColors?.[0] ?? fallbackColor };
	const unique: string[] = [];
	const colorByName = new Map<string, string | undefined>();
	for (let i = 0; i < agents.length; i++) {
		const name = agents[i]!;
		if (!unique.includes(name)) unique.push(name);
		const color = agentColors?.[i];
		if (color && !colorByName.has(name)) colorByName.set(name, color);
	}
	if (unique.length === 1) {
		const name = unique[0]!;
		const firstColor = agentColors?.find((c): c is string => Boolean(c));
		return {
			kind: "uniformParallel",
			total: agents.length,
			name,
			color: firstColor ?? colorByName.get(name) ?? fallbackColor,
		};
	}
	return {
		kind: "mixedParallel",
		agents: unique.map((name) => ({ name, color: colorByName.get(name) ?? fallbackColor })),
	};
}

export interface ShapeBadgeInput {
	mode: RunMode;
	current: number;
	total: number;
}

export function formatShapeBadge(input: ShapeBadgeInput): string | undefined {
	if (input.mode === "parallel" && input.total > 1) return `parallel ${input.current}/${input.total}`;
	return undefined;
}
