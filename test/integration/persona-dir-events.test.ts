import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import registerSubagentExtension from "../../index.ts";
import {
	SUBAGENT_EXPOSE_API_EVENT,
	SUBAGENT_REGISTER_PERSONA_DIR_ERROR_EVENT,
	SUBAGENT_REGISTER_PERSONA_DIR_EVENT,
	SUBAGENT_UNREGISTER_PERSONA_DIR_EVENT,
	type PersonaDirErrorPayload,
	type SubagentExposedAPI,
} from "../../src/protocol/types.ts";
import { createTempDir, removeTempDir } from "../support/helpers.ts";

function createPiHarness() {
	const events = new EventEmitter();
	let exposed: SubagentExposedAPI | undefined;
	const errors: PersonaDirErrorPayload[] = [];
	const sessionHandlers = new Map<string, (...args: unknown[]) => unknown>();
	const pi = {
		events: {
			emit: (event: string, payload: unknown) => events.emit(event, payload),
			on: (event: string, listener: (...args: unknown[]) => void) => {
				events.on(event, listener);
				return () => events.off(event, listener);
			},
		},
		on: (event: string, handler: (...args: unknown[]) => unknown) => {
			sessionHandlers.set(event, handler);
		},
		registerTool: () => {},
		registerCommand: () => {},
		registerShortcut: () => {},
		registerMessageRenderer: () => {},
		getAllTools: () => [{ name: "read" }, { name: "grep" }, { name: "find" }, { name: "ls" }],
		getSessionName: () => undefined,
		setSessionName: () => {},
		sendMessage: () => {},
		appendEntry: () => {},
	};
	events.on(SUBAGENT_EXPOSE_API_EVENT, (api) => {
		exposed = api as SubagentExposedAPI;
	});
	events.on(SUBAGENT_REGISTER_PERSONA_DIR_ERROR_EVENT, (payload) => {
		errors.push(payload as PersonaDirErrorPayload);
	});
	return { pi, events, getExposed: () => exposed, errors, sessionHandlers };
}

function writePersona(dir: string, name: string, scope = "both") {
	fs.writeFileSync(path.join(dir, `${name}.md`), `---\nname: ${name}\ndescription: Test persona ${name}\nscope: ${scope}\n---\n\nYou are ${name}.\n`);
}

describe("persona directory registration events", () => {
	let tempDirs: string[];

	beforeEach(() => {
		tempDirs = [];
	});

	afterEach(() => {
		for (const dir of tempDirs) removeTempDir(dir);
	});

	function makeDir() {
		const dir = createTempDir();
		tempDirs.push(dir);
		return dir;
	}

	it("registers forced-internal personas and unregisters them", () => {
		const dir = makeDir();
		writePersona(dir, "event-persona");
		const { pi, events, getExposed } = createPiHarness();
		registerSubagentExtension(pi as never);
		const api = getExposed();
		assert.ok(api, "expected exposed subagent API");

		events.emit(SUBAGENT_REGISTER_PERSONA_DIR_EVENT, { extensionId: "ext-a", path: dir, scope: "internal" });

		assert.equal(api.list().some((agent) => agent.name === "event-persona"), false);
		const agent = api.list({ includeInternal: true }).find((candidate) => candidate.name === "event-persona");
		assert.ok(agent, "expected registered persona in internal list");
		assert.equal(agent.surface, "internal");

		events.emit(SUBAGENT_UNREGISTER_PERSONA_DIR_EVENT, { extensionId: "ext-a" });
		assert.equal(api.list({ includeInternal: true }).some((candidate) => candidate.name === "event-persona"), false);
	});

	it("emits a collision error without throwing", () => {
		const first = makeDir();
		const second = makeDir();
		writePersona(first, "shared-persona");
		writePersona(second, "shared-persona");
		const { pi, events, getExposed, errors } = createPiHarness();
		registerSubagentExtension(pi as never);
		const api = getExposed();
		assert.ok(api, "expected exposed subagent API");

		events.emit(SUBAGENT_REGISTER_PERSONA_DIR_EVENT, { extensionId: "ext-a", path: first, scope: "internal" });
		assert.doesNotThrow(() => {
			events.emit(SUBAGENT_REGISTER_PERSONA_DIR_EVENT, { extensionId: "ext-b", path: second, scope: "internal" });
		});

		assert.deepEqual(errors, [{
			extensionId: "ext-b",
			conflictingExtensionId: "ext-a",
			personaName: "shared-persona",
			message: "Subagent persona name 'shared-persona' is already registered by extension 'ext-a'",
		}]);
		const matches = api.list({ includeInternal: true }).filter((candidate) => candidate.name === "shared-persona");
		assert.equal(matches.length, 1);
	});
});
