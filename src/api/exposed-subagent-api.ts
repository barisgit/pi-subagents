import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RegisteredPersonaDir, discoverAgents } from "../shared/agents.ts";
import { claimPendingChildLineage, setHostLineage } from "../state/lineage.ts";
import type { createSubagentExecutor } from "../dispatch/subagent-executor.ts";
import {
	type Details,
	type ExtensionConfig,
	type SpawnRawInput,
	type SpawnResult,
	type SubagentExposedAPI,
	type SubagentLineage,
	type SubagentState,
	SUBAGENT_EXPOSE_API_EVENT,
	SUBAGENT_LINEAGE_EVENT,
} from "../protocol/types.ts";

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
			lineage: () => lineage,
		};
		pi.events.emit(SUBAGENT_EXPOSE_API_EVENT, api);
		pi.events.emit(SUBAGENT_LINEAGE_EVENT, lineage);
	};
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
	const buildSpawnRawContext = (): ExtensionContext =>
		state.lastUiContext ??
		({
			cwd: state.baseCwd,
			hasUI: false,
			ui: {} as ExtensionContext["ui"],
			sessionManager: {
				getSessionId: () => state.currentSessionId ?? "spawn-raw",
				getSessionFile: () => null,
			} as unknown as ExtensionContext["sessionManager"],
			modelRegistry: { getAvailable: () => [] } as unknown as ExtensionContext["modelRegistry"],
			model: undefined,
			isIdle: () => true,
			signal: undefined,
			abort: () => {},
			hasPendingMessages: () => false,
			shutdown: () => {},
			getContextUsage: () => undefined,
			compact: () => {},
			getSystemPrompt: () => "",
		} as ExtensionContext);
	const spawnRaw = async (input: SpawnRawInput): Promise<SpawnResult> =>
		executor.executeInternal(
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
			buildSpawnRawContext(),
		) as unknown as SpawnResult;
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
		lineage: () => hostLineage,
	};
	const exposeSubagentApi = () => {
		pi.events.emit(SUBAGENT_EXPOSE_API_EVENT, subagentApi);
		pi.events.emit(SUBAGENT_LINEAGE_EVENT, hostLineage);
	};
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
