import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { matchesKey } from "@earendil-works/pi-tui";
import type { AgentConfig } from "./agents.ts";
import { renderList, handleListInput, type ListAgent, type ListState } from "./agent-manager-list.ts";
import { createParallelState, handleParallelInput, renderParallel, formatParallelTitle, type ParallelState, type AgentOption } from "./agent-manager-parallel.ts";
import { renderDetail, handleDetailInput, renderTaskInput, type DetailState } from "./agent-manager-detail.ts";
import { type ModelInfo, type SkillInfo } from "./agent-manager-edit.ts";
import { createEditorState, handleEditorInput } from "./text-editor.ts";
import type { TextEditorState } from "./text-editor.ts";

export type ManagerResult =
	| { action: "launch"; agent: string; task: string; skipClarify?: boolean }
	| { action: "parallel"; tasks: Array<{ agent: string; task: string }>; prompt?: string; skipClarify?: boolean }
	| undefined;

export interface AgentData {
	builtin: AgentConfig[];
	user: AgentConfig[];
	project: AgentConfig[];
	userDir: string;
	projectDir: string | null;
	userSettingsPath: string;
	projectSettingsPath: string | null;
	cwd: string;
}

type ManagerScreen = "list" | "detail" | "task-input" | "parallel-builder";
interface AgentEntry { id: string; config: AgentConfig; }
interface StatusMessage { text: string; type: "error" | "info"; }

function cloneConfig(config: AgentConfig): AgentConfig {
	return {
		...config,
		tools: config.tools ? [...config.tools] : undefined,
		mcpDirectTools: config.mcpDirectTools ? [...config.mcpDirectTools] : undefined,
		skills: config.skills ? [...config.skills] : undefined,
		fallbackModels: config.fallbackModels ? [...config.fallbackModels] : undefined,
		defaultReads: config.defaultReads ? [...config.defaultReads] : undefined,
		extraFields: config.extraFields ? { ...config.extraFields } : undefined,
	};
}

export class AgentManagerComponent implements Component {
	private overlayWidth = 84;
	private screen: ManagerScreen = "list";
	private agents: AgentEntry[] = [];
	private listState: ListState = { cursor: 0, scrollOffset: 0, filterQuery: "", selected: [] };
	private detailState: DetailState = { resolved: true, scrollOffset: 0 };
	private currentAgentId: string | null = null;
	private taskEditor: TextEditorState = createEditorState();
	private skipClarify = false;
	private parallelState: ParallelState | null = null;
	private taskBackScreen: ManagerScreen = "list";
	private statusMessage?: StatusMessage;
	private nextId = 1;

	constructor(
		private tui: TUI,
		private theme: Theme,
		private agentData: AgentData,
		private models: ModelInfo[],
		private skills: SkillInfo[],
		private done: (result: ManagerResult) => void,
	) {
		void this.models;
		void this.skills;
		this.reload();
	}

	private reload(agentName?: string): void {
		this.agents = [...this.agentData.builtin, ...this.agentData.user, ...this.agentData.project]
			.map((config) => ({ id: `a${this.nextId++}`, config: cloneConfig(config) }));
		if (agentName) {
			const entry = this.agents.find((candidate) => candidate.config.name === agentName);
			this.currentAgentId = entry?.id ?? null;
		}
	}

	private getAgentEntry(id: string | null): AgentEntry | undefined {
		if (!id) return undefined;
		return this.agents.find((entry) => entry.id === id);
	}

	private listAgents(): ListAgent[] {
		return this.agents.map((entry) => ({
			id: entry.id,
			name: entry.config.name,
			description: entry.config.description,
			model: entry.config.model,
			source: entry.config.source,
			overrideScope: entry.config.override?.scope,
			disabled: entry.config.disabled,
			kind: "agent" as const,
		}));
	}

	private enterTask(ids: string[], backScreen: ManagerScreen): void {
		this.listState = { ...this.listState, selected: ids };
		this.taskBackScreen = backScreen;
		this.taskEditor = createEditorState();
		this.skipClarify = true;
		this.screen = "task-input";
	}

	private enterParallel(): void {
		const selected = this.listState.selected.length ? this.listState.selected : [this.listAgents()[this.listState.cursor]?.id].filter((id): id is string => Boolean(id));
		const names = selected.map((id) => this.getAgentEntry(id)?.config.name).filter((name): name is string => Boolean(name));
		this.parallelState = createParallelState(names);
		this.screen = "parallel-builder";
	}

	invalidate(): void {
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (this.screen === "list") {
			if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) { this.done(undefined); return; }
			if (matchesKey(data, "ctrl+p")) { this.enterParallel(); this.tui.requestRender(); return; }
			const action = handleListInput(this.listState, this.listAgents(), data);
			if (!action) return;
			switch (action.type) {
				case "open-detail": this.currentAgentId = action.id; this.detailState = { resolved: true, scrollOffset: 0 }; this.screen = "detail"; break;
				case "run-selected": this.enterTask(action.ids, "list"); break;
				case "launch-parallel": this.enterParallel(); break;
				case "create": this.statusMessage = { text: "Create agents by adding files under agents/.", type: "info" }; break;
				case "clone":
				case "edit":
				case "delete": this.statusMessage = { text: "Use files or the management action for edits.", type: "info" }; break;
			}
			this.tui.requestRender();
			return;
		}
		if (this.screen === "detail") {
			if (matchesKey(data, "escape") || matchesKey(data, "left")) { this.screen = "list"; this.tui.requestRender(); return; }
			const entry = this.getAgentEntry(this.currentAgentId);
			if (!entry) { this.screen = "list"; this.tui.requestRender(); return; }
			const action = handleDetailInput(this.detailState, data);
			if (action?.type === "launch") this.enterTask([entry.id], "detail");
			this.tui.requestRender();
			return;
		}
		if (this.screen === "parallel-builder") {
			if (!this.parallelState) { this.screen = "list"; this.tui.requestRender(); return; }
			const options: AgentOption[] = this.agents.map((entry) => ({ name: entry.config.name, description: entry.config.description }));
			const action = handleParallelInput(this.parallelState, options, data, this.overlayWidth);
			if (!action) return;
			if (action.type === "back") { this.parallelState = null; this.screen = "list"; this.tui.requestRender(); return; }
			if (action.type === "proceed") {
				const prompt = this.parallelState.commonPrompt.trim();
				const tasks = this.parallelState.slots.map((slot) => ({ agent: slot.agentName, task: slot.customTask.trim() || prompt }));
				this.done({ action: "parallel", tasks, ...(prompt ? { prompt } : {}), skipClarify: true });
				return;
			}
			this.tui.requestRender();
			return;
		}
		if (this.screen === "task-input") {
			if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) { this.screen = this.taskBackScreen; this.tui.requestRender(); return; }
			if (matchesKey(data, "tab")) { this.skipClarify = !this.skipClarify; this.tui.requestRender(); return; }
			if (matchesKey(data, "return") || matchesKey(data, "enter")) {
				const ids = this.listState.selected.length ? this.listState.selected : [this.currentAgentId].filter((id): id is string => Boolean(id));
				const names = ids.map((id) => this.getAgentEntry(id)?.config.name).filter((name): name is string => Boolean(name));
				if (names.length > 1) this.done({ action: "parallel", tasks: names.map((agent) => ({ agent, task: this.taskEditor.buffer })), skipClarify: this.skipClarify });
				else this.done({ action: "launch", agent: names[0] ?? "", task: this.taskEditor.buffer, skipClarify: this.skipClarify });
				return;
			}
			const next = handleEditorInput(this.taskEditor, data, this.overlayWidth - 4, { multiLine: true });
			if (next) { this.taskEditor = next; this.tui.requestRender(); }
		}
	}

	render(width: number): string[] {
		const w = Math.min(width, this.overlayWidth);
		if (this.screen === "detail") {
			const entry = this.getAgentEntry(this.currentAgentId);
			if (!entry) return renderList(this.listState, this.listAgents(), w, this.theme, this.statusMessage);
			return renderDetail(this.detailState, entry.config, process.cwd(), w, this.theme);
		}
		if (this.screen === "parallel-builder") {
			const options: AgentOption[] = this.agents.map((entry) => ({ name: entry.config.name, description: entry.config.description }));
			return renderParallel(this.parallelState!, options, w, this.theme);
		}
		if (this.screen === "task-input") {
			const selected = this.listState.selected.map((id) => this.getAgentEntry(id)?.config.name).filter((name): name is string => Boolean(name));
			const title = selected.length > 1 ? formatParallelTitle(selected.map((agentName) => ({ agentName, customTask: "" }))) : this.getAgentEntry(this.currentAgentId)?.config.name ?? "Agent";
			return renderTaskInput(title, this.taskEditor, this.skipClarify, w, this.theme);
		}
		return renderList(this.listState, this.listAgents(), w, this.theme, this.statusMessage);
	}
}
