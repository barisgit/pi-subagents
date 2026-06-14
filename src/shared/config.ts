import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "./logger.ts";
import type { ExtensionConfig } from "../protocol/types.ts";

export const SUBAGENT_CONFIG_PRIMARY = path.join(os.homedir(), ".pi", "agent", "subagent.json");
export const SUBAGENT_CONFIG_LEGACY = path.join(os.homedir(), ".pi", "agent", "extensions", "subagent", "config.json");

export function resolveConfigPath(): string {
	if (fs.existsSync(SUBAGENT_CONFIG_PRIMARY)) return SUBAGENT_CONFIG_PRIMARY;
	if (fs.existsSync(SUBAGENT_CONFIG_LEGACY)) return SUBAGENT_CONFIG_LEGACY;
	return SUBAGENT_CONFIG_PRIMARY;
}

export function loadConfig(): ExtensionConfig {
	const configPath = resolveConfigPath();
	try {
		if (fs.existsSync(configPath)) {
			return JSON.parse(fs.readFileSync(configPath, "utf-8")) as ExtensionConfig;
		}
	} catch (error) {
		logger.error("Failed to load subagent config", error instanceof Error ? error : undefined, {
			configPath,
			error: error instanceof Error ? undefined : String(error),
		});
	}
	return {};
}

export function expandTilde(p: string): string {
	return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}
