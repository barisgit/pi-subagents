/**
 * Runtime environment reads for subagent dispatch: temp-scope identity (uses
 * node:os) and the PI_SUBAGENT_* depth / nested-delegation policy reads
 * (process.env). Kept out of protocol/types.ts so that module stays a pure
 * DTO/vocabulary leaf with no os/env coupling; this module imports the pure
 * helpers/vocabulary downward from protocol.
 */

import * as os from "node:os";
import {
	DEFAULT_SUBAGENT_MAX_DEPTH,
	LEGACY_ALLOWED_NESTED_CHILD_AGENT_NAMES,
	isNestedOrchestratorAgent,
	normalizeAgentIdentity,
	normalizeMaxSubagentDepth,
} from "../protocol/types.ts";

function sanitizeTempScopeSegment(value: string): string {
	const sanitized = value
		.trim()
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return sanitized || "unknown";
}

export function resolveTempScopeId(options?: {
	env?: NodeJS.ProcessEnv;
	getuid?: (() => number) | undefined;
	userInfo?: (() => { username?: string | null }) | undefined;
	homedir?: (() => string) | undefined;
}): string {
	const env = options?.env ?? process.env;
	const getuid = options && Object.hasOwn(options, "getuid")
		? options.getuid
		: process.getuid?.bind(process);
	if (typeof getuid === "function") {
		return `uid-${getuid()}`;
	}

	for (const key of ["USERNAME", "USER", "LOGNAME"] as const) {
		const value = env[key];
		if (value) return `user-${sanitizeTempScopeSegment(value)}`;
	}

	const userInfo = options && Object.hasOwn(options, "userInfo")
		? options.userInfo
		: os.userInfo;
	try {
		const username = userInfo?.().username;
		if (username) return `user-${sanitizeTempScopeSegment(username)}`;
	} catch {
		// Fall through to home-directory-based scoping.
	}

	const homedir = env.USERPROFILE ?? env.HOME;
	if (homedir) return `home-${sanitizeTempScopeSegment(homedir)}`;

	const resolveHomedir = options && Object.hasOwn(options, "homedir")
		? options.homedir
		: os.homedir;
	try {
		const fallbackHomedir = resolveHomedir?.();
		if (fallbackHomedir) return `home-${sanitizeTempScopeSegment(fallbackHomedir)}`;
	} catch {
		// Fall through to the last-resort shared scope.
	}

	return "shared";
}

export function resolveCurrentMaxSubagentDepth(configMaxDepth?: number): number {
	return normalizeMaxSubagentDepth(process.env.PI_SUBAGENT_MAX_DEPTH)
		?? normalizeMaxSubagentDepth(configMaxDepth)
		?? DEFAULT_SUBAGENT_MAX_DEPTH;
}

export function checkSubagentDepth(configMaxDepth?: number): { blocked: boolean; depth: number; maxDepth: number } {
	const depth = Number(process.env.PI_SUBAGENT_DEPTH ?? "0");
	const maxDepth = resolveCurrentMaxSubagentDepth(configMaxDepth);
	const blocked = Number.isFinite(depth) && depth >= maxDepth;
	return { blocked, depth, maxDepth };
}

export function getSubagentDepthEnv(maxDepth?: number): Record<string, string> {
	const parentDepth = Number(process.env.PI_SUBAGENT_DEPTH ?? "0");
	const nextDepth = Number.isFinite(parentDepth) ? parentDepth + 1 : 1;
	return {
		PI_SUBAGENT_DEPTH: String(nextDepth),
		PI_SUBAGENT_MAX_DEPTH: String(normalizeMaxSubagentDepth(maxDepth) ?? resolveCurrentMaxSubagentDepth()),
	};
}

function parseEnvBoolean(value: string | undefined): boolean | undefined {
	if (!value) return undefined;
	const normalized = value.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(normalized)) return true;
	if (["0", "false", "no", "off"].includes(normalized)) return false;
	return undefined;
}

function parseEnvAgentList(value: string | undefined): string[] | undefined {
	if (!value) return undefined;
	const normalized = value
		.split(",")
		.map((item) => normalizeAgentIdentity(item))
		.filter((item): item is string => Boolean(item));
	return normalized.length > 0 ? normalized : undefined;
}

export function checkNestedDelegationGuard(requestedAgents: string[]): {
	blocked: boolean;
	currentAgent?: string;
	parentAgent?: string;
	reason?: string;
} {
	const currentAgent = normalizeAgentIdentity(process.env.PI_SUBAGENT_CURRENT_AGENT);
	const parentAgent = normalizeAgentIdentity(process.env.PI_SUBAGENT_PARENT_AGENT);
	if (!currentAgent) return { blocked: false };

	const explicitCanDelegate = parseEnvBoolean(process.env.PI_SUBAGENT_CAN_DELEGATE);
	const canDelegate = explicitCanDelegate ?? isNestedOrchestratorAgent(currentAgent);
	if (!canDelegate) {
		return {
			blocked: true,
			currentAgent,
			parentAgent,
			reason:
				`Nested subagent call blocked: '${process.env.PI_SUBAGENT_CURRENT_AGENT}' is not allowed to delegate. ` +
				"Only agents marked canDelegate may make nested subagent calls.",
		};
	}

	const targets = [...new Set(requestedAgents.map((agent) => normalizeAgentIdentity(agent)).filter((agent): agent is string => Boolean(agent)))];
	const explicitAllowedTargets = parseEnvAgentList(process.env.PI_SUBAGENT_ALLOWED_DELEGATE_AGENTS);
	const allowedTargets = explicitAllowedTargets
		?? (isNestedOrchestratorAgent(currentAgent) ? [...LEGACY_ALLOWED_NESTED_CHILD_AGENT_NAMES] : undefined);
	if (allowedTargets && allowedTargets.length > 0) {
		const allowedTargetSet = new Set(allowedTargets);
		const disallowedTargets = targets.filter((agent) => !allowedTargetSet.has(agent));
		if (disallowedTargets.length > 0) {
			return {
				blocked: true,
				currentAgent,
				parentAgent,
				reason:
					`Nested subagent call blocked: agent '${process.env.PI_SUBAGENT_CURRENT_AGENT}' may only delegate to ` +
					`${allowedTargets.join(", ")}. Requested: ${disallowedTargets.join(", ")}.`,
			};
		}
	}

	return { blocked: false, currentAgent, parentAgent };
}
