import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RegisteredPersonaDir, discoverAgents } from "../shared/agents.ts";
import { claimPendingChildLineage, setChildLineage, setHostLineage } from "../state/lineage.ts";
import type { createSubagentExecutor } from "../dispatch/subagent-executor.ts";
import { addUsageInto, emptyUsage } from "../dispatch/executor-helpers.ts";
import { readShardEntries, type RunsRegistryEntry } from "../state/runs-registry.ts";
import { readStatus } from "../shared/utils.ts";
import {
	type Details,
	type ExtensionConfig,
	type SpawnRawInput,
	type SpawnResult,
	type SubagentExposedAPI,
	type SubagentLineage,
	type SubagentState,
	type SubagentUsageRecord,
	type SubagentUsageSnapshot,
	SUBAGENT_EXPOSE_API_EVENT,
	SUBAGENT_LINEAGE_EVENT,
	SUBAGENT_REQUEST_API_EVENT,
} from "../protocol/types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeUsageRecord(value: unknown): SubagentUsageRecord | undefined {
	if (!isRecord(value)) return undefined;
	if (typeof value.runId !== "string" || !isRecord(value.totalUsage)) return undefined;
	const mode =
		value.mode === "single" || value.mode === "parallel" || value.mode === "workflow" ? value.mode : undefined;
	const source = value.source === "sync" || value.source === "async" ? value.source : undefined;
	if (!mode || !source) return undefined;
	const input = typeof value.totalUsage.input === "number" ? value.totalUsage.input : 0;
	const output = typeof value.totalUsage.output === "number" ? value.totalUsage.output : 0;
	return {
		runId: value.runId,
		...(typeof value.rootRunId === "string" ? { rootRunId: value.rootRunId } : {}),
		...(typeof value.parentRunId === "string" ? { parentRunId: value.parentRunId } : {}),
		...(typeof value.rootSessionId === "string" ? { rootSessionId: value.rootSessionId } : {}),
		mode,
		source,
		totalUsage: {
			input,
			output,
			...(typeof value.totalUsage.cacheRead === "number" ? { cacheRead: value.totalUsage.cacheRead } : {}),
			...(typeof value.totalUsage.cacheWrite === "number" ? { cacheWrite: value.totalUsage.cacheWrite } : {}),
			...(typeof value.totalUsage.cost === "number" ? { cost: value.totalUsage.cost } : {}),
			...(typeof value.totalUsage.turns === "number" ? { turns: value.totalUsage.turns } : {}),
		},
		timestamp: typeof value.timestamp === "number" ? value.timestamp : Date.now(),
	};
}

function usageSnapshotFromRecords(records: SubagentUsageRecord[]): SubagentUsageSnapshot {
	const byRun = new Map<string, SubagentUsageRecord>();
	for (const record of records) byRun.set(record.runId, record);
	const deduped = [...byRun.values()].sort((a, b) => a.timestamp - b.timestamp);
	const totalUsage = emptyUsage();
	for (const record of deduped) addUsageInto(totalUsage, record.totalUsage);
	return {
		records: deduped,
		totalUsage,
		...(deduped.length > 0 ? { updatedAt: deduped[deduped.length - 1]!.timestamp } : {}),
	};
}

function usageFromTokenUsage(value: unknown): SubagentUsageRecord["totalUsage"] | undefined {
	if (!isRecord(value)) return undefined;
	const input = typeof value.input === "number" ? value.input : 0;
	const output = typeof value.output === "number" ? value.output : 0;
	const cacheRead = typeof value.cacheRead === "number" ? value.cacheRead : 0;
	const cacheWrite = typeof value.cacheWrite === "number" ? value.cacheWrite : 0;
	if (input + output + cacheRead + cacheWrite <= 0) return undefined;
	return { input, output, cacheRead, cacheWrite, cost: 0, turns: 0 };
}

function usageFromPersistedRun(entry: RunsRegistryEntry): SubagentUsageRecord | undefined {
	if (entry.parentRunId) return undefined;
	const status = readStatus(entry.runRecordDir);
	if (!status) return undefined;
	const totalUsage =
		status.totalUsage ??
		usageFromTokenUsage(status.totalTokens) ??
		(() => {
			const usage = emptyUsage();
			for (const step of status.steps ?? []) addUsageInto(usage, usageFromTokenUsage(step.tokens));
			return usage.input + usage.output + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0) > 0
				? usage
				: undefined;
		})();
	if (!totalUsage) return undefined;
	return {
		runId: entry.runId,
		rootRunId: entry.rootRunId ?? entry.runId,
		...(entry.rootSessionId ? { rootSessionId: entry.rootSessionId } : {}),
		mode: entry.kind === "workflow" ? "workflow" : entry.mode,
		source: entry.source,
		totalUsage,
		timestamp: status.endedAt ?? status.lastUpdate ?? entry.startedAt,
	};
}

function persistedUsageRecordsForSession(sessionId: string | null): SubagentUsageRecord[] {
	if (!sessionId) return [];
	const records: SubagentUsageRecord[] = [];
	for (const entry of readShardEntries(sessionId)) {
		const record = usageFromPersistedRun(entry);
		if (record) records.push(record);
	}
	return records;
}

function usageSnapshotForState(state: SubagentState): SubagentUsageSnapshot {
	const records: SubagentUsageRecord[] = [
		...persistedUsageRecordsForSession(state.currentSessionId),
		...(state.usageByRun?.values() ?? []),
	];
	const branch = state.lastUiContext?.sessionManager?.getBranch?.() ?? [];
	for (const entry of branch) {
		if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== "subagent_usage") continue;
		const record = normalizeUsageRecord(entry.data);
		if (record) records.push(record);
	}
	return usageSnapshotFromRecords(records);
}

/**
 * Publish a session-scoped SubagentExposedAPI on the child's pi.events with
 * the child's lineage. Other extensions loaded inside this child session
 * (e.g. pi-charter) can listen on SUBAGENT_EXPOSE_API_EVENT and call
 * api.lineage() to learn who they are.
 *
 * Children deliberately get a STUB spawnRaw/list: spawning nested subagents
 * from inside a child session is not supported on the in-process executor.
 */
export function registerChildSessionApi(pi: ExtensionAPI): void {
	let lineage: SubagentLineage | null = null;
	const publish = () => {
		const api: SubagentExposedAPI = {
			spawnRaw: async () => ({
				content: [{ type: "text", text: "spawnRaw is not available inside a child session" }],
				details: { type: "error", message: "spawnRaw unsupported in child" } as unknown as Details,
				isError: true,
			}),
			list: () => [],
			usageSnapshot: () => usageSnapshotFromRecords([]),
			lineage: () => lineage,
		};
		pi.events.emit(SUBAGENT_EXPOSE_API_EVENT, api);
		pi.events.emit(SUBAGENT_LINEAGE_EVENT, lineage);
	};
	// Let extensions that load later ask for the current API snapshot.
	pi.events.on(SUBAGENT_REQUEST_API_EVENT, publish);
	// Publish immediately with a null lineage so eager listeners see something;
	// re-publish once session_start gives us the session id and lets us claim
	// the lineage that the in-process executor pushed onto the pending queue.
	publish();
	pi.on("session_start", (_event, ctx) => {
		const sid = ctx.sessionManager?.getSessionId?.();
		if (typeof sid !== "string" || sid.length === 0) return;
		// Fallback: claim from the pending queue if the in-process executor's
		// pre-registered-by-sid lineage didn't land for this session. Normally
		// lineage is already in the store keyed by sid before activate runs.
		lineage = claimPendingChildLineage(sid, { runId: null, agentName: null });
		if (!lineage) {
			lineage = {
				role: "child",
				currentAgent: "",
				parentAgent: null,
				parentSessionId: null,
				rootSessionId: null,
				depth: 0,
				runId: null,
				canDelegate: false,
				allowedDelegateAgents: [],
				maxSubagentDepth: 0,
			};
			setChildLineage(sid, lineage);
		}
		publish();
	});
}

interface CreateHostSubagentApiParams {
	pi: ExtensionAPI;
	executor: ReturnType<typeof createSubagentExecutor>;
	config: ExtensionConfig;
	state: SubagentState;
	getRegisteredPersonaDirs: () => RegisteredPersonaDir[];
	discoverAgents: typeof discoverAgents;
}

export function createHostSubagentApi(params: CreateHostSubagentApiParams): {
	setCurrentAgent: (name: string) => void;
	republish: () => void;
} {
	const { pi, executor, config, state, getRegisteredPersonaDirs, discoverAgents } = params;
	const spawnRaw = async (input: SpawnRawInput): Promise<SpawnResult> => {
		const ctx = state.lastUiContext;
		if (!ctx) {
			return {
				content: [{ type: "text", text: "spawnRaw is unavailable until session context is established" }],
				details: {
					type: "error",
					message: "spawnRaw has no authoritative session context",
				} as unknown as Details,
				isError: true,
			};
		}
		return executor.executeInternal(
			"subagent-spawn-raw",
			{
				agent: "__raw__",
				task: input.prompt,
				async: input.async,
				cwd: input.cwd,
				metadata: input.metadata,
				rawAgentConfig: {
					name: "__raw__",
					description: "Raw extension subagent",
					tools: input.tools ?? ["read", "grep", "find", "ls"],
					model: input.model,
					thinking: input.thinking,
					systemPromptMode: input.systemPromptMode ?? "replace",
					inheritProjectContext: input.inheritProjectContext ?? false,
					inheritSkills: input.inheritSkills === true,
					systemPrompt: input.systemPrompt,
					source: "builtin",
					filePath: "<spawnRaw>",
					skills: Array.isArray(input.inheritSkills) ? input.inheritSkills : undefined,
					defaultReads: input.defaultReads,
					defaultProgress: input.defaultProgress,
					surface: "internal",
				},
			},
			new AbortController().signal,
			undefined,
			ctx,
		) as unknown as SpawnResult;
	};
	// Host lineage is recorded on session_start once we know the host session
	// id. Until then, lineage() returns a best-effort host shape with a null
	// rootSessionId so callers never see undefined.
	let hostLineage: SubagentLineage = {
		role: "host",
		currentAgent: "",
		parentAgent: null,
		parentSessionId: null,
		rootSessionId: null,
		depth: 0,
		runId: null,
	};
	const subagentApi: SubagentExposedAPI = {
		spawnRaw,
		list: (options) =>
			discoverAgents(state.lastUiContext?.cwd ?? state.baseCwd, "both", {
				config,
				includeInternal: options?.includeInternal,
				registeredPersonaDirs: getRegisteredPersonaDirs(),
			}).agents.map((agent) => ({
				name: agent.name,
				description: agent.description,
				source: agent.source,
				surface: agent.surface,
			})),
		usageSnapshot: () => usageSnapshotForState(state),
		lineage: () => hostLineage,
	};
	const exposeSubagentApi = () => {
		pi.events.emit(SUBAGENT_EXPOSE_API_EVENT, subagentApi);
		pi.events.emit(SUBAGENT_LINEAGE_EVENT, hostLineage);
	};
	pi.events.on(SUBAGENT_REQUEST_API_EVENT, exposeSubagentApi);
	exposeSubagentApi();

	// Refine host lineage once session_start fires with the host session id.
	pi.on("session_start", (_event, ctx) => {
		const sid = ctx.sessionManager?.getSessionId?.();
		if (typeof sid === "string" && sid.length > 0) {
			hostLineage = { ...hostLineage, rootSessionId: sid };
			setHostLineage(sid, hostLineage.currentAgent);
			// Re-emit so any listener that subscribed before session_start gets the
			// updated rootSessionId.
			exposeSubagentApi();
		}
	});

	return {
		setCurrentAgent: (name: string) => {
			hostLineage = { ...hostLineage, currentAgent: name };
			if (hostLineage.rootSessionId) setHostLineage(hostLineage.rootSessionId, name);
			exposeSubagentApi();
		},
		republish: exposeSubagentApi,
	};
}
