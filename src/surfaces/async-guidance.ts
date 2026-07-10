export { ASYNC_NO_POLL_GUIDANCE } from "../shared/formatting.ts";

export function formatAsyncStatusHint(id: string): string {
	return `Manage only if needed: subagent({ action: "status", id: "${id}" })`;
}
