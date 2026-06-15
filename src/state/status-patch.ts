import type { PersistedRunStatus, PersistedRunStep, StatusPatch } from "../protocol/status-types.ts";

type StatusStep = PersistedRunStep;

function stepFor(status: PersistedRunStatus & { steps: PersistedRunStep[] }, stepIndex: number): StatusStep {
	while (status.steps.length <= stepIndex) {
		status.steps.push({ status: "queued" });
	}
	return status.steps[stepIndex]!;
}

/**
 * Apply a structured {@link StatusPatch} to a {@link PersistedRunStatus} in place.
 *
 * Extracted VERBATIM from StatusWriter.applyPatch so the in-memory RunView mirror
 * (ChildAgentRegistry) and the on-disk status.json writer mutate identical status
 * state from the same patch stream — eliminating divergence between the two
 * projections. `status.steps` is required here because every caller seeds it to
 * `[]` before applying patches.
 */
export function applyPatchToStatus(
	status: PersistedRunStatus & { steps: PersistedRunStep[] },
	patch: StatusPatch,
): void {
	const now = Date.now();
	status.lastUpdate = patch.endedAt ?? now;
	status.currentStep = patch.stepIndex;
	const isTerminalStepPatch =
		patch.endedAt !== undefined &&
		(patch.state === "complete" || patch.state === "failed" || patch.state === "interrupted");
	if (patch.state && !isTerminalStepPatch) status.state = patch.state;
	if (patch.endedAt !== undefined) status.endedAt = patch.endedAt;
	if (patch.outputText !== undefined && !isTerminalStepPatch) status.outputText = patch.outputText;
	if (patch.activity) {
		status.lastActivityAt = patch.activity.updatedAt;
		if (patch.activity.toolName !== undefined) {
			status.currentTool = patch.activity.toolName;
			status.currentToolStartedAt = patch.activity.updatedAt;
		} else if (patch.activity.state !== "tool_running") {
			status.currentTool = undefined;
			status.currentToolStartedAt = undefined;
		}
	}

	// Merge phase: preserve last-known phase fields when a patch omits them (high-frequency patches must not erase phase state).
	if (patch.phase !== undefined) status.phase = patch.phase;
	if (patch.phaseStartedAt !== undefined) status.phaseStartedAt = patch.phaseStartedAt;
	// Bump runnerHeartbeatAt on every patch to signal the runner is alive.
	status.runnerHeartbeatAt = patch.runnerHeartbeatAt ?? now;

	const step = stepFor(status, patch.stepIndex);
	if (patch.state) step.status = patch.state;
	if (patch.endedAt !== undefined) step.endedAt = patch.endedAt;
	if (patch.activity) {
		step.lastActivityAt = patch.activity.updatedAt;
		if (patch.activity.toolName !== undefined) {
			step.currentTool = patch.activity.toolName;
			step.currentToolStartedAt = patch.activity.updatedAt;
		} else if (patch.activity.state !== "tool_running") {
			step.currentTool = undefined;
			step.currentToolStartedAt = undefined;
		}
	}
	if (
		patch.liveText !== undefined ||
		patch.toolCallDelta ||
		patch.toolResultDelta ||
		patch.toolErrorDelta ||
		patch.phase !== undefined ||
		patch.phaseStartedAt !== undefined
	) {
		step.live = step.live ?? {};
		if (patch.liveText !== undefined) step.live.outputText = patch.liveText;
		if (patch.toolCallDelta) step.live.toolCallCount = (step.live.toolCallCount ?? 0) + patch.toolCallDelta;
		if (patch.toolResultDelta) step.live.toolResultCount = (step.live.toolResultCount ?? 0) + patch.toolResultDelta;
		if (patch.toolErrorDelta) step.live.toolErrorCount = (step.live.toolErrorCount ?? 0) + patch.toolErrorDelta;
		if (patch.phase !== undefined) step.live.phase = patch.phase;
		if (patch.phaseStartedAt !== undefined) step.live.phaseStartedAt = patch.phaseStartedAt;
	}
	// Persist live token usage so nested-child readers (which can only see the
	// on-disk status.json, not the runner's in-memory progress) show running
	// token counts instead of ~0 until finalize. Only step.tokens is set; the
	// run total is derived by summing steps when status.totalTokens is absent
	// (inlineTokenCount fallback), so a single live step never clobbers a
	// multi-step aggregate. finalize() later writes the authoritative total.
	if (patch.tokens && patch.tokens.total > 0) {
		step.tokens = { ...patch.tokens };
	}
}
