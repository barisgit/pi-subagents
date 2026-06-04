export const ASYNC_NO_POLL_GUIDANCE = "Avoid polling: Pi will send a completion or needs-attention message and trigger a new turn when this run needs you. Continue independent work or stop if blocked on the result. Use status/sleep checks only when immediate inspection is genuinely necessary.";

export function formatAsyncStatusHint(id: string): string {
	return `Manage only if needed: subagent({ action: "status", id: "${id}" })`;
}
