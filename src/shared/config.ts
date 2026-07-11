import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { logger } from "./logger.ts";
import type { ExtensionConfig } from "../protocol/types.ts";

export const SUBAGENT_CONFIG_PRIMARY = path.join(getAgentDir(), "subagent.json");

export function resolveConfigPath(): string {
	return SUBAGENT_CONFIG_PRIMARY;
}

// Disk-boundary codec: untrusted JSON is only trusted after a shape check.
// Fails closed (null) on anything that is not a plain object, so activation
// never dereferences properties on null/array/scalar config content.
function parseExtensionConfig(raw: string): ExtensionConfig | null {
	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch {
		return null;
	}
	if (data === null || typeof data !== "object" || Array.isArray(data)) return null;
	return data as ExtensionConfig;
}

export function loadConfig(): ExtensionConfig {
	const configPath = resolveConfigPath();
	try {
		if (fs.existsSync(configPath)) {
			const parsed = parseExtensionConfig(fs.readFileSync(configPath, "utf-8"));
			if (parsed) return parsed;
			logger.warn("Malformed subagent config; falling back to defaults", { configPath });
			return {};
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
