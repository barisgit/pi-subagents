import { AgentSession, type AgentSessionEvent, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ChildAgentResult, StatusPatch } from "../protocol/status-types.ts";

export interface ChildAgentContext {
	extensionCtx: ExtensionContext;
	abortSignal: AbortSignal;
	onEvent?: (stepIndex: number, e: AgentSessionEvent) => void;
	onStatusUpdate?: (patch: StatusPatch) => void;
	onCompleted?: (result: ChildAgentResult) => void;
	registry: ChildAgentRegistry;
	pi: ExtensionAPI;
}

export interface ChildAgentHandle {
	readonly runId: string;
	readonly stepIndex: number;
	readonly session: AgentSession;
	readonly completed: Promise<ChildAgentResult>;
	abort(reason: string): Promise<void>;
}

export class ChildAgentRegistry {
	private readonly handles = new Map<string, Map<number, ChildAgentHandle>>();
	private readonly controllers = new Map<string, AbortController>();

	signalForRun(runId: string): AbortSignal {
		return this.controllerForRun(runId).signal;
	}

	register(handle: ChildAgentHandle): void {
		this.controllerForRun(handle.runId);
		let byStep = this.handles.get(handle.runId);
		if (!byStep) {
			byStep = new Map();
			this.handles.set(handle.runId, byStep);
		}
		byStep.set(handle.stepIndex, handle);
	}

	get(runId: string): ChildAgentHandle | undefined {
		return this.handles.get(runId)?.values().next().value;
	}

	delete(runId: string, stepIndex?: number): void {
		if (stepIndex === undefined) {
			this.handles.delete(runId);
			this.controllers.delete(runId);
			return;
		}
		const byStep = this.handles.get(runId);
		byStep?.delete(stepIndex);
		if (!byStep || byStep.size === 0) {
			this.handles.delete(runId);
			this.controllers.delete(runId);
		}
	}

	list(): ChildAgentHandle[] {
		return [...this.handles.values()].flatMap((byStep) => [...byStep.values()]);
	}

	snapshot(): { runId: string; stepIndex: number }[] {
		return this.list().map((handle) => ({ runId: handle.runId, stepIndex: handle.stepIndex }));
	}

	async abortAll(reason: string): Promise<void> {
		await Promise.all(this.list().map((handle) => this.abortRun(handle.runId, reason)));
	}

	async abortRun(runId: string, reason: string): Promise<void> {
		const controller = this.controllerForRun(runId);
		if (!controller.signal.aborted) {
			controller.abort(reason);
		}
		await Promise.all([...this.handles.get(runId)?.values() ?? []].map((handle) => handle.abort(reason)));
	}

	private controllerForRun(runId: string): AbortController {
		let controller = this.controllers.get(runId);
		if (!controller) {
			controller = new AbortController();
			this.controllers.set(runId, controller);
		}
		return controller;
	}
}
