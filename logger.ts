/**
 * Centralized logging for pi-subagents.
 *
 * Writes to ~/.pi/logs/extensions/pi-subagents.log. Never writes to stdout/stderr
 * — those go through the pi TUI and would corrupt it. All failures are swallowed
 * so logging never breaks the extension.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogContext {
	runId?: string;
	stepIndex?: number;
	agent?: string;
	[key: string]: unknown;
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
};

const LEVEL_PREFIX: Record<LogLevel, string> = {
	debug: "[subagents:DEBUG]",
	info: "[subagents]",
	warn: "[subagents:WARN]",
	error: "[subagents:ERROR]",
};

const DEFAULT_LOG_PATH = join(homedir(), ".pi", "logs", "extensions", "pi-subagents.log");
const LOG_PATH = process.env.PI_SUBAGENTS_LOG_PATH?.trim() || DEFAULT_LOG_PATH;

class Logger {
	private minLevel: LogLevel = "info";
	private defaultContext: LogContext = {};

	setLevel(level: LogLevel): void {
		this.minLevel = level;
	}

	setDefaultContext(context: LogContext): void {
		this.defaultContext = context;
	}

	private shouldLog(level: LogLevel): boolean {
		return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[this.minLevel];
	}

	private emit(level: LogLevel, message: string, context?: LogContext, error?: Error): void {
		if (!this.shouldLog(level)) return;
		const merged = { ...this.defaultContext, ...context };
		const line = formatEntry(level, message, merged, error);
		try {
			mkdirSync(dirname(LOG_PATH), { recursive: true });
			appendFileSync(LOG_PATH, `${line}\n`, "utf-8");
		} catch {
			// Logging must never disrupt the pi TUI/runtime.
		}
	}

	debug(message: string, context?: LogContext): void {
		this.emit("debug", message, context);
	}

	info(message: string, context?: LogContext): void {
		this.emit("info", message, context);
	}

	warn(message: string, context?: LogContext): void {
		this.emit("warn", message, context);
	}

	error(message: string, error?: Error, context?: LogContext): void {
		this.emit("error", message, context, error);
	}

	child(context: LogContext): ChildLogger {
		return new ChildLogger(this, context);
	}

	logPath(): string {
		return LOG_PATH;
	}
}

class ChildLogger {
	private parent: Logger;
	private context: LogContext;

	constructor(parent: Logger, context: LogContext) {
		this.parent = parent;
		this.context = context;
	}

	debug(message: string, context?: LogContext): void {
		this.parent.debug(message, { ...this.context, ...context });
	}

	info(message: string, context?: LogContext): void {
		this.parent.info(message, { ...this.context, ...context });
	}

	warn(message: string, context?: LogContext): void {
		this.parent.warn(message, { ...this.context, ...context });
	}

	error(message: string, error?: Error, context?: LogContext): void {
		this.parent.error(message, error, { ...this.context, ...context });
	}

	child(context: LogContext): ChildLogger {
		return new ChildLogger(this.parent, { ...this.context, ...context });
	}
}

function formatEntry(level: LogLevel, message: string, context: LogContext, error?: Error): string {
	const prefix = LEVEL_PREFIX[level];
	const contextStr = formatContext(context);
	const head = contextStr ? `${prefix} ${message} ${contextStr}` : `${prefix} ${message}`;
	const errStr = error ? ` ${error.stack ?? error.message}` : "";
	return `${new Date().toISOString()} ${head}${errStr}`;
}

function formatContext(context: LogContext): string {
	const keys = Object.keys(context);
	if (keys.length === 0) return "";
	const parts: string[] = [];
	for (const key of keys) {
		const value = context[key];
		if (value === undefined || value === null) continue;
		parts.push(`${key}=${typeof value === "string" ? value : JSON.stringify(value)}`);
	}
	return parts.length > 0 ? `(${parts.join(", ")})` : "";
}

export const logger = new Logger();

if (process.env.PI_SUBAGENTS_DEBUG === "1" || process.env.PI_SUBAGENTS_DEBUG === "true") {
	logger.setLevel("debug");
}
