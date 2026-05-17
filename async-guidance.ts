export const ASYNC_NO_POLL_GUIDANCE = "Polling is not required; do not poll unless you need an immediate update.";

export function formatAsyncStatusHint(id: string): string {
	return `Status: subagent({ action: "status", id: "${id}" })`;
}
