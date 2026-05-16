/**
 * Pure helpers that centralize how chain/parallel/single run shapes are labeled
 * across spawn confirmations, completion notifications, the live widget, and the
 * /subagents-status dashboard. No I/O, no on-disk state.
 *
 * The four call sites previously open-coded their own joins ('+' vs '->' vs ', '),
 * their own 'parallel(N)' vs unique-agents fan-out, and their own 'chain X/Y' /
 * 'parallel X/Y' badges. Centralizing the label decisions here keeps them in sync.
 */

export type RunMode = "single" | "chain" | "parallel";

export type RunHandleStyle = "compact" | "verbose";

export interface RunHandleInput {
	mode: RunMode;
	/**
	 * Ordered step labels. For chains that contain a parallel sub-step, the caller
	 * may pre-render that sub-step as a single token like "[a+b]" and pass it as
	 * one element; this helper performs no nesting transformation of its own.
	 */
	agents: string[];
	style?: RunHandleStyle;
}

/**
 * Plain-text run label used in two contexts.
 *
 * compact (default) — identifier-style, used by completion notifications:
 *   single   -> "a"
 *   chain    -> "chain:a->b->c"
 *   parallel -> "parallel:a+b+c"
 *
 * verbose — prose-style, used by async spawn confirmations:
 *   single   -> "a"
 *   chain    -> "a -> b -> c"
 *   parallel -> "[a, b, c]"
 */
export function formatRunHandle(input: RunHandleInput): string {
	const agents = input.agents;
	if (agents.length === 0) return "subagent";
	if (input.mode === "single" || agents.length === 1) return agents[0]!;
	const style = input.style ?? "compact";
	if (style === "verbose") {
		if (input.mode === "parallel") return `[${agents.join(", ")}]`;
		return agents.join(" -> ");
	}
	const sep = input.mode === "parallel" ? "+" : "->";
	return `${input.mode}:${agents.join(sep)}`;
}

/**
 * Structural description of a row's agent label for the widget + dashboard.
 *
 * Callers apply their own theme tinting (e.g. tintAgentName, theme.bold) around
 * the returned names/separators -- only the *string content* and the per-agent
 * color hints flow through this helper.
 */
export type AgentLabelDescription =
	| { kind: "single"; name: string; color?: string }
	| { kind: "uniformParallel"; total: number; name: string; color?: string }
	| { kind: "mixedParallel"; agents: Array<{ name: string; color?: string }> };

export interface DescribeAgentLabelInput {
	mode: RunMode | undefined;
	agents: string[];
	/** Index-aligned with `agents`. */
	agentColors?: Array<string | undefined>;
	/** Used when the row collapses to a single name (non-parallel or empty parallel). */
	fallbackName: string;
	fallbackColor?: string;
}

export function describeAgentLabel(input: DescribeAgentLabelInput): AgentLabelDescription {
	const { mode, agents, agentColors, fallbackName, fallbackColor } = input;
	if (mode === "parallel" && agents.length > 0) {
		const unique = Array.from(new Set(agents));
		// First-occurrence color per unique name -- matches the per-step alignment
		// used by both the widget (job.agentColors) and the dashboard (step.color).
		const colorByName = new Map<string, string | undefined>();
		for (let i = 0; i < agents.length; i++) {
			const name = agents[i]!;
			if (!colorByName.has(name)) colorByName.set(name, agentColors?.[i]);
		}
		if (unique.length === 1) {
			const name = unique[0]!;
			// For uniform parallel, prefer the first *non-empty* color so an
			// undefined leading entry doesn't blank out an otherwise-coloured run.
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
			agents: unique.map((n) => ({ name: n, color: colorByName.get(n) })),
		};
	}
	return { kind: "single", name: fallbackName, color: fallbackColor };
}

export interface ShapeBadgeInput {
	mode: RunMode | undefined;
	total: number;
	/** 1-based numerator; the caller decides whether it means 'current step' or 'done count'. */
	current: number;
	/** Label to use when mode is 'single' or undefined; when omitted, returns "". */
	fallbackLabel?: string;
}

/**
 * Right-aligned progress badge. Empty for single-step runs so the row stays compact.
 *
 *   chain    -> "chain 3/8"
 *   parallel -> "parallel 2/5"
 *   single   -> "" (or `${fallbackLabel} ${current}/${total}` when caller supplies one)
 */
export function formatShapeBadge(input: ShapeBadgeInput): string {
	if (input.total <= 1) return "";
	if (input.mode === "chain") return `chain ${input.current}/${input.total}`;
	if (input.mode === "parallel") return `parallel ${input.current}/${input.total}`;
	if (input.fallbackLabel) return `${input.fallbackLabel} ${input.current}/${input.total}`;
	return "";
}
