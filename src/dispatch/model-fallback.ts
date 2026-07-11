import type { ModelInfo } from "./executor-types.ts";

export type AvailableModelInfo = ModelInfo;

export interface ModelRefInfo {
	provider: string;
	id: string;
}

export function normalizeAvailableModels(models: Array<{ provider: string; id: string }>): ModelInfo[] {
	return models.map((model) => ({ provider: model.provider, id: model.id, fullId: `${model.provider}/${model.id}` }));
}

function splitThinkingSuffix(model: string): { baseModel: string; thinkingSuffix: string } {
	const colonIdx = model.lastIndexOf(":");
	if (colonIdx === -1) return { baseModel: model, thinkingSuffix: "" };
	return {
		baseModel: model.substring(0, colonIdx),
		thinkingSuffix: model.substring(colonIdx),
	};
}

export function resolveModelCandidate(
	model: string | undefined,
	availableModels: AvailableModelInfo[] | undefined,
	preferredProvider?: string,
): string | undefined {
	if (!model) return undefined;
	if (model.includes("/")) return model;
	if (!availableModels || availableModels.length === 0) return model;

	const { baseModel, thinkingSuffix } = splitThinkingSuffix(model);
	const matches = availableModels.filter((entry) => entry.id === baseModel);
	if (preferredProvider) {
		const preferredMatch = matches.find((entry) => entry.provider === preferredProvider);
		if (preferredMatch) return `${preferredMatch.fullId}${thinkingSuffix}`;
	}
	if (matches.length !== 1) return model;
	return `${matches[0]!.fullId}${thinkingSuffix}`;
}

export function buildModelCandidates(
	primaryModel: string | undefined,
	fallbackModels: string[] | undefined,
	availableModels: AvailableModelInfo[] | undefined,
	preferredProvider?: string,
): string[] {
	const seen = new Set<string>();
	const candidates: string[] = [];
	for (const raw of [primaryModel, ...(fallbackModels ?? [])]) {
		if (!raw) continue;
		const normalized = resolveModelCandidate(raw.trim(), availableModels, preferredProvider);
		if (!normalized || seen.has(normalized)) continue;
		seen.add(normalized);
		candidates.push(normalized);
	}
	return candidates;
}

export function resolveModelRef<T extends ModelRefInfo>(
	ref: string | undefined,
	models: T[],
	fallback: T | undefined,
	findByProvider?: (provider: string, id: string) => T | undefined,
): T | undefined {
	if (!ref) return fallback ?? models[0];
	const slashIdx = ref.indexOf("/");
	if (slashIdx !== -1) {
		const provider = ref.substring(0, slashIdx);
		const id = ref.substring(slashIdx + 1);
		const providerMatch =
			findByProvider?.(provider, id) ??
			models.find((model) => model.provider.toLowerCase() === provider.toLowerCase() && model.id === id);
		if (providerMatch) return providerMatch;
		if (models.some((model) => model.provider.toLowerCase() === provider.toLowerCase())) return undefined;
	}
	return models.find((model) => model.id === ref) ?? fallback ?? models[0];
}

const RETRYABLE_MODEL_FAILURE_PATTERNS = [
	/rate\s*limit/i,
	/too many requests/i,
	/\b429\b/,
	/quota/i,
	/billing/i,
	/credit/i,
	/auth(?:entication)?/i,
	/unauthori[sz]ed/i,
	/forbidden/i,
	/api key/i,
	/token expired/i,
	/invalid key/i,
	/provider.*unavailable/i,
	/model.*unavailable/i,
	/model.*disabled/i,
	/model.*not found/i,
	/unknown model/i,
	/overloaded/i,
	/service unavailable/i,
	/temporar(?:ily)? unavailable/i,
	/connection refused/i,
	/fetch failed/i,
	/network error/i,
	/socket hang up/i,
	/upstream/i,
	/timed? out/i,
	/timeout/i,
	/\b502\b/,
	/\b503\b/,
	/\b504\b/,
];

export function isRetryableModelFailure(error: string | undefined): boolean {
	if (!error) return false;
	return RETRYABLE_MODEL_FAILURE_PATTERNS.some((pattern) => pattern.test(error));
}
