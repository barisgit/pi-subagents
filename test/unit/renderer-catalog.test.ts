import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { RendererCatalog, __setRendererCatalogDepsForTest } from "../../src/runtime/renderer-catalog.ts";
import { isInsideChildSession } from "../../src/shared/child-session-context.ts";

describe("RendererCatalog", () => {
	it("creates one all-tools in-memory session inside child context and disposes it once", async () => {
		const calls: string[] = [];
		let options: Record<string, unknown> | undefined;
		let disposeCalls = 0;
		let releaseReload: (() => void) | undefined;
		const reloadGate = new Promise<void>((resolve) => {
			releaseReload = resolve;
		});
		const restore = __setRendererCatalogDepsForTest({
			getAgentDir: () => "/agent",
			createResourceLoader: (resourceOptions) => {
				calls.push(`loader:${resourceOptions.cwd}:${resourceOptions.agentDir}`);
				return {
					reload: async () => {
						assert.equal(isInsideChildSession(), true);
						calls.push("reload");
						await reloadGate;
					},
				} as never;
			},
			createInMemorySession: (cwd) => {
				assert.equal(isInsideChildSession(), true);
				calls.push(`memory:${cwd}`);
				return { kind: "memory" } as never;
			},
			createAgentSession: async (sessionOptions) => {
				assert.equal(isInsideChildSession(), true);
				options = sessionOptions as unknown as Record<string, unknown>;
				calls.push("create");
				return {
					session: {
						getToolDefinition: (name: string) => (name === "custom" ? ({ name } as never) : undefined),
						dispose: () => {
							disposeCalls++;
						},
					},
				} as never;
			},
		});
		try {
			const catalog = new RendererCatalog("/project");
			const modelRegistry = {} as ExtensionContext["modelRegistry"];
			const first = catalog.ensure(modelRegistry);
			const second = catalog.ensure(modelRegistry);
			releaseReload?.();
			assert.equal(await first, true);
			assert.equal(await second, true);
			assert.deepEqual(calls, ["loader:/project:/agent", "reload", "memory:/project", "create"]);
			assert.equal(options?.cwd, "/project");
			assert.equal(options?.agentDir, "/agent");
			assert.equal(options?.modelRegistry, modelRegistry);
			assert.equal((options?.sessionManager as { kind?: string }).kind, "memory");
			for (const key of ["tools", "noTools", "excludeTools", "customTools"]) {
				assert.equal(Object.hasOwn(options ?? {}, key), false, `${key} must be omitted`);
			}
			assert.equal(catalog.getToolDefinition("custom")?.name, "custom");
			catalog.dispose();
			catalog.dispose();
			assert.equal(disposeCalls, 1);
		} finally {
			restore();
		}
	});

	it("fails quietly and disposes a session created after cleanup", async () => {
		let releaseCreate: (() => void) | undefined;
		const createGate = new Promise<void>((resolve) => {
			releaseCreate = resolve;
		});
		let disposeCalls = 0;
		const restore = __setRendererCatalogDepsForTest({
			createResourceLoader: () => ({ reload: async () => {} }) as never,
			createInMemorySession: () => ({}) as never,
			createAgentSession: async () => {
				await createGate;
				return {
					session: {
						getToolDefinition: () => undefined,
						dispose: () => {
							disposeCalls++;
						},
					},
				} as never;
			},
		});
		try {
			const catalog = new RendererCatalog("/project");
			const pending = catalog.ensure({} as ExtensionContext["modelRegistry"]);
			catalog.dispose();
			releaseCreate?.();
			assert.equal(await pending, false);
			assert.equal(disposeCalls, 1);
			assert.equal(catalog.getToolDefinition("anything"), undefined);
		} finally {
			restore();
		}
	});
});
