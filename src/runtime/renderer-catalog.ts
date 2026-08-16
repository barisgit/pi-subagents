import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
	type AgentSession,
	type ExtensionContext,
	type ResourceLoader,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { runInChildSessionContext } from "../shared/child-session-context.ts";
import { logger } from "../shared/logger.ts";

type CatalogSession = Pick<AgentSession, "dispose" | "getToolDefinition">;

interface RendererCatalogDeps {
	getAgentDir(): string;
	createResourceLoader(options: { cwd: string; agentDir: string }): ResourceLoader;
	createInMemorySession(cwd: string): ReturnType<typeof SessionManager.inMemory>;
	createAgentSession: typeof createAgentSession;
}

let runtimeDeps: RendererCatalogDeps = {
	getAgentDir,
	createResourceLoader: (options) => new DefaultResourceLoader(options),
	createInMemorySession: (cwd) => SessionManager.inMemory(cwd),
	createAgentSession,
};

export function __setRendererCatalogDepsForTest(deps: Partial<RendererCatalogDeps>): () => void {
	const previous = runtimeDeps;
	runtimeDeps = { ...runtimeDeps, ...deps };
	return () => {
		runtimeDeps = previous;
	};
}

/** Activation-owned catalog of Pi's native tool renderers. */
export class RendererCatalog {
	private readonly cwd: string;
	private session: CatalogSession | undefined;
	private initialization: Promise<boolean> | undefined;
	private disposed = false;

	constructor(cwd: string) {
		this.cwd = cwd;
	}

	ensure(modelRegistry: ExtensionContext["modelRegistry"]): Promise<boolean> {
		if (this.disposed) return Promise.resolve(false);
		if (this.session) return Promise.resolve(true);
		this.initialization ??= this.initialize(modelRegistry);
		return this.initialization;
	}

	getToolDefinition(name: string): ToolDefinition | undefined {
		return this.session?.getToolDefinition(name);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.session?.dispose();
		this.session = undefined;
	}

	private async initialize(modelRegistry: ExtensionContext["modelRegistry"]): Promise<boolean> {
		try {
			const created = await runInChildSessionContext(async () => {
				const agentDir = runtimeDeps.getAgentDir();
				const resourceLoader = runtimeDeps.createResourceLoader({ cwd: this.cwd, agentDir });
				await resourceLoader.reload();
				const sessionManager = runtimeDeps.createInMemorySession(this.cwd);
				return await runtimeDeps.createAgentSession({
					cwd: this.cwd,
					agentDir,
					modelRegistry,
					resourceLoader,
					sessionManager,
				});
			});
			if (this.disposed) {
				created.session.dispose();
				return false;
			}
			this.session = created.session;
			return true;
		} catch (error) {
			logger.warn("dashboard renderer catalog initialization failed", { error });
			return false;
		}
	}
}
