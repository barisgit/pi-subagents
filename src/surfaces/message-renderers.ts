import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Container, Spacer, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { Details } from "../protocol/types.ts";
import { getSlashRenderableSnapshot, type SlashMessageDetails } from "../state/slash-live-state.ts";
import { renderSubagentResult, syncResultAnimation } from "./render-result.ts";
import { formatDuration, shortenPath } from "./formatters.ts";
import type { SubagentBatchNotifyDetails, SubagentNotifyDetails } from "./notify.ts";

function isSlashResultRunning(result: { details?: Details }): boolean {
	return (
		result.details?.progress?.some((entry) => entry.status === "running") ||
		result.details?.results.some((entry) => entry.progress?.status === "running") ||
		false
	);
}

function isSlashResultError(result: { details?: Details }): boolean {
	return (
		result.details?.results.some((entry) => entry.exitCode !== 0 && entry.progress?.status !== "running") || false
	);
}

function rebuildSlashResultContainer(
	container: Container,
	result: AgentToolResult<Details>,
	options: { expanded: boolean },
	theme: ExtensionContext["ui"]["theme"],
): void {
	container.clear();
	container.addChild(new Spacer(1));
	const boxTheme = isSlashResultRunning(result)
		? "toolPendingBg"
		: isSlashResultError(result)
			? "toolErrorBg"
			: "toolSuccessBg";
	const box = new Box(1, 1, (text: string) => theme.bg(boxTheme, text));
	box.addChild(renderSubagentResult(result, options, theme));
	container.addChild(box);
}

export function createSlashResultComponent(
	details: SlashMessageDetails,
	options: { expanded: boolean },
	theme: ExtensionContext["ui"]["theme"],
	requestRender: () => void,
): Container {
	const container = new Container();
	const animationState: { subagentResultAnimationTimer?: ReturnType<typeof setInterval> } = {};
	let lastVersion = -1;
	container.render = (width: number): string[] => {
		const snapshot = getSlashRenderableSnapshot(details);
		syncResultAnimation(snapshot.result, { state: animationState, invalidate: requestRender });
		if (snapshot.version !== lastVersion || isSlashResultRunning(snapshot.result)) {
			lastVersion = snapshot.version;
			rebuildSlashResultContainer(container, snapshot.result, options, theme);
		}
		return Container.prototype.render.call(container, width);
	};
	return container;
}

export function parseSubagentNotifyContent(content: string): SubagentNotifyDetails | undefined {
	const lines = content.split("\n");
	const header = lines[0] ?? "";
	const match = header.match(
		/^Background task (completed|failed|paused|interrupted): \*\*(.+?)\*\*(?:\s+(\([^)]*\)))?$/,
	);
	if (!match) return undefined;
	const body = lines.slice(2);
	let sessionIndex = -1;
	for (let i = body.length - 1; i >= 1; i--) {
		if (body[i - 1]?.trim() === "" && /^(Session|Session file|Session share error):\s+/.test(body[i]!)) {
			sessionIndex = i;
			break;
		}
	}
	const sessionLine = sessionIndex >= 0 ? body[sessionIndex] : undefined;
	const resultLines = sessionIndex >= 0 ? body.slice(0, sessionIndex) : body;
	const resultPreview = resultLines.join("\n").trim() || "(no output)";
	let sessionLabel: string | undefined;
	let sessionValue: string | undefined;
	if (sessionLine) {
		const separator = sessionLine.indexOf(":");
		sessionLabel = sessionLine.slice(0, separator).toLowerCase();
		sessionValue = sessionLine.slice(separator + 1).trim();
	}
	return {
		agent: match[2]!,
		status: match[1] as SubagentNotifyDetails["status"],
		...(match[3] ? { taskInfo: match[3] } : {}),
		resultPreview,
		...(sessionLabel && sessionValue ? { sessionLabel, sessionValue } : {}),
	};
}

export class SubagentNotifyNoticeComponent implements Component {
	private readonly details: SubagentNotifyDetails | SubagentBatchNotifyDetails;
	private readonly options: { expanded: boolean };
	private readonly theme: ExtensionContext["ui"]["theme"];

	constructor(
		details: SubagentNotifyDetails | SubagentBatchNotifyDetails,
		options: { expanded: boolean },
		theme: ExtensionContext["ui"]["theme"],
	) {
		this.details = details;
		this.options = options;
		this.theme = theme;
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (width < 3) return [truncateToWidth("Subagent notification", width)];
		const bodyWidth = Math.max(1, Math.min(width - 2, 68));
		const borderChar = "─";
		const header =
			this.details.kind === "batch"
				? ` Subagent batch complete · ${this.details.completed}/${this.details.total} `
				: ` Subagent ${this.details.status}: ${this.details.agent} `;
		const headerText = truncateToWidth(header, bodyWidth, "");
		const headerPadding = Math.max(0, bodyWidth - visibleWidth(headerText));
		// Truncation/inner styles inject ANSI resets; keep the closing border in
		// its own accent segment so a reset inside the text can't bleach it.
		const lines = [
			this.theme.fg("accent", `╭${headerText}`) + this.theme.fg("accent", `${borderChar.repeat(headerPadding)}╮`),
		];

		for (const line of this.bodyLines()) {
			const text = truncateToWidth(line, bodyWidth, "…");
			const padding = Math.max(0, bodyWidth - visibleWidth(text));
			lines.push(this.theme.fg("accent", `│${text}`) + " ".repeat(padding) + this.theme.fg("accent", "│"));
		}
		lines.push(this.theme.fg("accent", `╰${borderChar.repeat(bodyWidth)}╯`));
		return lines;
	}

	private bodyLines(): string[] {
		if (this.details.kind === "batch") {
			const lines = this.details.children.map((child) => {
				const glyph =
					child.state === "complete" || child.state === "completed"
						? this.theme.fg("success", "✓")
						: child.state === "paused" || child.state === "interrupted"
							? this.theme.fg("warning", "■")
							: this.theme.fg("error", "✗");
				const name = child.label?.trim() || child.agent || child.runId.slice(0, 8);
				return `${glyph} ${name} ${this.theme.fg("dim", `(${child.agent}) · ${child.state}`)}`;
			});
			return lines.length > 0 ? lines : ["(no child results)"];
		}

		const icon =
			this.details.status === "completed"
				? this.theme.fg("success", "✓")
				: this.details.status === "paused" || this.details.status === "interrupted"
					? this.theme.fg("warning", "■")
					: this.theme.fg("error", "✗");
		const parts: string[] = [];
		if (this.details.taskInfo) parts.push(this.details.taskInfo);
		if (this.details.durationMs !== undefined) parts.push(formatDuration(this.details.durationMs));
		let first = `${icon} ${this.theme.bold(this.details.agent)} ${this.theme.fg("dim", this.details.status)}`;
		if (parts.length > 0)
			first += ` ${this.theme.fg("dim", "·")} ${parts.map((part) => this.theme.fg("dim", part)).join(` ${this.theme.fg("dim", "·")} `)}`;
		const lines = [first];
		const trimmedPreview = this.details.resultPreview.trim();
		const previewLines = this.options.expanded
			? trimmedPreview.split("\n").filter((line) => line.trim())
			: [trimmedPreview.split("\n", 1)[0] ?? ""].filter((line) => line.trim());
		for (const line of previewLines.length > 0 ? previewLines : ["(no output)"]) {
			lines.push(`  └─ ${line}`);
		}
		if (this.options.expanded && this.details.sessionLabel && this.details.sessionValue) {
			lines.push(`  ${this.details.sessionLabel}: ${shortenPath(this.details.sessionValue)}`);
		}
		return lines;
	}
}
