import type { Theme } from "@earendil-works/pi-coding-agent";
import type { AgentSource } from "./agents.ts";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { pad, row, renderHeader, renderFooter, fuzzyFilter, formatScrollInfo } from "./render-helpers.ts";

export interface ListAgent {
	id: string;
	name: string;
	description: string;
	model?: string;
	source: AgentSource;
	overrideScope?: "user" | "project";
	disabled?: boolean;
	kind: "agent";
}

export interface ListState {
	cursor: number;
	scrollOffset: number;
	filterQuery: string;
	selected: string[];
}

export type ListAction =
	| { type: "open-detail"; id: string }
	| { type: "clone"; id: string }
	| { type: "create" }
	| { type: "delete"; id: string }
	| { type: "edit"; id: string }
	| { type: "run-selected"; ids: string[] }
	| { type: "launch-parallel"; ids: string[] }
	| { type: "close" };

const LIST_VIEWPORT_HEIGHT = 8;

function selectionCount(selected: string[], id: string): number {
	let count = 0;
	for (const s of selected) if (s === id) count++;
	return count;
}

function clampCursor(state: ListState, filtered: ListAgent[]): void {
	if (filtered.length === 0) { state.cursor = 0; state.scrollOffset = 0; return; }
	state.cursor = Math.max(0, Math.min(state.cursor, filtered.length - 1));
	const maxOffset = Math.max(0, filtered.length - LIST_VIEWPORT_HEIGHT);
	state.scrollOffset = Math.max(0, Math.min(state.scrollOffset, maxOffset));
	if (state.cursor < state.scrollOffset) state.scrollOffset = state.cursor;
	else if (state.cursor >= state.scrollOffset + LIST_VIEWPORT_HEIGHT) state.scrollOffset = state.cursor - LIST_VIEWPORT_HEIGHT + 1;
}

export function handleListInput(state: ListState, agents: ListAgent[], data: string): ListAction | undefined {
	const filtered = fuzzyFilter(agents, state.filterQuery);
	if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
		if (state.filterQuery.length > 0) { state.filterQuery = ""; state.cursor = 0; state.scrollOffset = 0; return; }
		if (state.selected.length > 0) { state.selected.length = 0; return; }
		return { type: "close" };
	}
	if (matchesKey(data, "return")) {
		const agent = filtered[state.cursor];
		if (agent) return { type: "open-detail", id: agent.id };
		return;
	}
	if (matchesKey(data, "up") || matchesKey(data, "down")) {
		if (matchesKey(data, "up")) state.cursor -= 1;
		if (matchesKey(data, "down")) state.cursor += 1;
		clampCursor(state, filtered);
		return;
	}
	if (matchesKey(data, "backspace")) {
		if (state.filterQuery.length > 0) { state.filterQuery = state.filterQuery.slice(0, -1); state.cursor = 0; state.scrollOffset = 0; }
		return;
	}
	if (matchesKey(data, "alt+n")) return { type: "create" };
	if (matchesKey(data, "ctrl+k")) { const agent = filtered[state.cursor]; if (agent) return { type: "clone", id: agent.id }; return; }
	if (matchesKey(data, "ctrl+e")) { const agent = filtered[state.cursor]; if (agent) return { type: "edit", id: agent.id }; return; }
	if (matchesKey(data, "ctrl+d") || matchesKey(data, "delete")) { const agent = filtered[state.cursor]; if (agent) return { type: "delete", id: agent.id }; return; }
	if (matchesKey(data, "tab")) {
		const agent = filtered[state.cursor];
		if (!agent) return;
		state.selected.push(agent.id);
		return;
	}
	if (matchesKey(data, "shift+tab")) {
		const agent = filtered[state.cursor];
		if (!agent) return;
		const idx = state.selected.lastIndexOf(agent.id);
		if (idx >= 0) state.selected.splice(idx, 1);
		return;
	}
	if (matchesKey(data, "ctrl+r")) {
		if (state.selected.length > 0) return { type: "run-selected", ids: [...state.selected] };
		const agent = filtered[state.cursor];
		if (agent) return { type: "run-selected", ids: [agent.id] };
		return;
	}
	if (matchesKey(data, "ctrl+p")) {
		if (state.selected.length > 0) return { type: "launch-parallel", ids: [...state.selected] };
		const agent = filtered[state.cursor];
		if (agent) return { type: "launch-parallel", ids: [agent.id] };
		return;
	}
	const text = data;
	if (text && text.length === 1 && text >= " " && text !== "\x7f") {
		state.filterQuery += text;
		state.cursor = 0;
		state.scrollOffset = 0;
		return;
	}
}

export function renderList(state: ListState, agents: ListAgent[], width: number, theme: Theme, status?: { text: string; type: "error" | "info" }): string[] {
	const filtered = fuzzyFilter(agents, state.filterQuery);
	clampCursor(state, filtered);
	const lines: string[] = [];
	lines.push(renderHeader(` Subagents [${agents.length} agents] `, width, theme));
	if (state.filterQuery) lines.push(row(` Filter: ${state.filterQuery}`, width, theme));
	if (status) lines.push(row(` ${status.text}`, width, theme));
	if (filtered.length === 0) lines.push(row(" No agents found", width, theme));
	const end = Math.min(filtered.length, state.scrollOffset + LIST_VIEWPORT_HEIGHT);
	for (let i = state.scrollOffset; i < end; i++) {
		const agent = filtered[i]!;
		const marker = i === state.cursor ? theme.fg("accent", ">") : " ";
		const count = selectionCount(state.selected, agent.id);
		const selected = count > 0 ? theme.fg("accent", count > 1 ? `[${count}] ` : "[*] ") : "    ";
		const modelRaw = agent.model ?? "default";
		const model = theme.fg("dim", truncateToWidth(modelRaw, 16));
		const name = agent.disabled ? theme.fg("dim", agent.name) : theme.bold(agent.name);
		const scopeLabel = agent.source === "builtin" ? "[builtin]" : agent.source === "project" ? "[project]" : "[user]";
		const left = `${marker}${selected}${name}`;
		const right = `${model} ${theme.fg("dim", scopeLabel)}`;
		const space = Math.max(1, width - visibleWidth(left) - visibleWidth(right) - 2);
		lines.push(row(` ${left}${" ".repeat(space)}${right}`, width, theme));
		if (agent.description) lines.push(row(`      ${theme.fg("dim", truncateToWidth(agent.description, width - 8))}`, width, theme));
	}
	const selCount = state.selected.length;
	const footer = selCount > 0 ? ` [ctrl+r] run  [ctrl+p] parallel  [tab] add  [shift+tab] remove (${selCount}) ` : " [enter] details  [ctrl+r] run  [ctrl+p] parallel  [tab] select  [esc] close ";
	lines.push(renderFooter(`${footer}${pad("", Math.max(0, width - visibleWidth(footer) - 4))}${formatScrollInfo(state.scrollOffset, Math.max(0, filtered.length - state.scrollOffset - LIST_VIEWPORT_HEIGHT))}`, width, theme));
	return lines;
}
