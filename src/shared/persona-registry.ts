import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type RegisteredPersonaDir, loadInternalPersonaDir } from "./agents.ts";
import {
	type PersonaDirErrorPayload,
	type RegisterPersonaDirPayload,
	type UnregisterPersonaDirPayload,
	SUBAGENT_REGISTER_PERSONA_DIR_ERROR_EVENT,
} from "../protocol/types.ts";

export function createPersonaDirRegistry(pi: ExtensionAPI): {
	getRegisteredPersonaDirs(): RegisteredPersonaDir[];
	handleRegisterPersonaDir(data: unknown): void;
	handleUnregisterPersonaDir(data: unknown): void;
} {
	const personaDirs = new Map<string, RegisterPersonaDirPayload>();
	const getRegisteredPersonaDirs = (): RegisteredPersonaDir[] =>
		Array.from(personaDirs.values()).map((dir) => ({
			extensionId: dir.extensionId,
			path: dir.path,
		}));
	const emitPersonaDirError = (payload: PersonaDirErrorPayload) => {
		pi.events.emit(SUBAGENT_REGISTER_PERSONA_DIR_ERROR_EVENT, payload);
	};
	const handleRegisterPersonaDir = (data: unknown) => {
		const payload = data as RegisterPersonaDirPayload;
		if (!payload || !payload.extensionId || payload.scope !== "internal" || !path.isAbsolute(payload.path)) {
			emitPersonaDirError({
				extensionId: payload?.extensionId ?? "",
				conflictingExtensionId: "",
				personaName: "",
				message: "Invalid subagent persona directory registration",
			});
			return;
		}
		const newAgents = loadInternalPersonaDir(payload.path);
		const newNames = new Set(newAgents.map((agent) => agent.name));
		for (const existing of personaDirs.values()) {
			if (existing.extensionId === payload.extensionId) continue;
			for (const agent of loadInternalPersonaDir(existing.path)) {
				if (!newNames.has(agent.name)) continue;
				emitPersonaDirError({
					extensionId: payload.extensionId,
					conflictingExtensionId: existing.extensionId,
					personaName: agent.name,
					message: `Subagent persona name '${agent.name}' is already registered by extension '${existing.extensionId}'`,
				});
				return;
			}
		}
		personaDirs.set(payload.extensionId, payload);
	};
	const handleUnregisterPersonaDir = (data: unknown) => {
		const payload = data as UnregisterPersonaDirPayload;
		if (payload?.extensionId) personaDirs.delete(payload.extensionId);
	};
	return { getRegisteredPersonaDirs, handleRegisterPersonaDir, handleUnregisterPersonaDir };
}
