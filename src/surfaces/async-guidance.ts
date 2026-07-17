export { ASYNC_NO_POLL_GUIDANCE } from "../shared/formatting.ts";

export function formatAsyncStatusHint(id: string): string {
	return `Steer if needed: subagent({ action: "resume", id: "${id}", message: "..." }). No interrupt needed. Inspect: subagent({ action: "status", id: "${id}" })`;
}
