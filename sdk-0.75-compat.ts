// TODO(sdk-0.75-shape): pi-subagents still carries runtime metadata fields that
// @earendil-works/pi-agent-core 0.75 no longer exposes on AgentToolResult.
// Keep this compile-time augmentation until call sites are migrated to thrown
// tool errors / explicit Details state without changing runtime behavior here.
declare module "@earendil-works/pi-agent-core" {
	interface AgentToolResult<T> {
		isError?: boolean;
	}
}

export {};
