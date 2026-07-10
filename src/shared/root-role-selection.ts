import type { AgentConfig } from "./agents.ts";

export interface RootRoleSelectionInput {
	roleFlag?: string;
	envRole?: string;
	restoredRole?: string;
	defaultRole?: string;
}

export function selectRootRole(availableRoles: AgentConfig[], input: RootRoleSelectionInput): AgentConfig | undefined {
	const candidates = [input.roleFlag, input.envRole, input.restoredRole, input.defaultRole].filter(
		(value): value is string => Boolean(value),
	);
	for (const candidate of candidates) {
		const role = availableRoles.find((available) => available.name === candidate);
		if (role) return role;
	}
	return availableRoles[0];
}
