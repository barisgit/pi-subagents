export type Layer0GroupStatus = "running" | "complete" | "failed";
export type Layer0ChildStatus = "pending" | "queued" | "running" | "complete" | "failed" | "interrupted" | string;

export function computeGroupStatus(childStatuses: Layer0ChildStatus[]): Layer0GroupStatus {
	if (childStatuses.some((status) => status === "pending" || status === "queued" || status === "running"))
		return "running";
	if (childStatuses.some((status) => status === "failed" || status === "interrupted")) return "failed";
	return "complete";
}
