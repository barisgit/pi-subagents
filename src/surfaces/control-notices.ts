import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import {
	claimControlNotificationKey,
	createControlNotificationDedupeStore,
	evictControlNotificationsForRunId,
	formatControlNoticeMessage,
} from "../dispatch/subagent-control.ts";
import { resolveSubagentIntercomTarget } from "../dispatch/intercom-bridge.ts";
import type { ControlEvent } from "../protocol/types.ts";

export const SUBAGENT_CONTROL_MESSAGE_TYPE = "subagent_control_notice";

export interface SubagentControlMessageDetails {
	event: ControlEvent;
	source?: "foreground" | "async";
	asyncDir?: string;
	childIntercomTarget?: string;
	noticeText?: string;
}

export function controlNoticeTarget(details: SubagentControlMessageDetails): string | undefined {
	return details.childIntercomTarget;
}

export function registerControlNotices(params: {
	pi: ExtensionAPI;
	isChildSession: boolean;
	globalStore: Record<string, unknown>;
}): { controlEventHandler: (payload: unknown) => void; controlRunTerminalHandler: (payload: unknown) => void } {
	const { pi, isChildSession, globalStore } = params;
	const controlNoticeSeenStoreKey = "__piSubagentVisibleControlNotices";
	const existingVisibleControlNotices = isChildSession ? undefined : globalStore[controlNoticeSeenStoreKey];
	const visibleControlNotices = createControlNotificationDedupeStore(existingVisibleControlNotices);
	if (!isChildSession) globalStore[controlNoticeSeenStoreKey] = visibleControlNotices;
	const controlEventHandler = (payload: unknown) => {
		const details = payload as SubagentControlMessageDetails;
		if (!details?.event) return;
		const childIntercomTarget = controlNoticeTarget(details);
		if (!claimControlNotificationKey(details.event, visibleControlNotices, childIntercomTarget)) return;
		const noticeText = details.noticeText ?? formatControlNoticeMessage(details.event, childIntercomTarget);
		pi.sendMessage(
			{
				customType: SUBAGENT_CONTROL_MESSAGE_TYPE,
				content: noticeText,
				display: true,
				details: { ...details, childIntercomTarget, noticeText },
			},
			{ triggerTurn: true },
		);
	};
	const controlRunTerminalHandler = (payload: unknown) => {
		const details = payload as {
			agent?: unknown;
			id?: unknown;
			index?: unknown;
			runId?: unknown;
			taskIndex?: unknown;
		};
		const runId = typeof details.runId === "string" ? details.runId : details.id;
		if (typeof runId !== "string") return;
		const index =
			typeof details.index === "number"
				? details.index
				: typeof details.taskIndex === "number"
					? details.taskIndex
					: undefined;
		const additionalLegacyChildKeys =
			typeof details.agent === "string" ? [resolveSubagentIntercomTarget(runId, details.agent, index)] : [];
		evictControlNotificationsForRunId(visibleControlNotices, runId, additionalLegacyChildKeys);
	};
	pi.registerMessageRenderer<SubagentControlMessageDetails>(
		SUBAGENT_CONTROL_MESSAGE_TYPE,
		(message, _options, theme) => {
			const details = message.details as SubagentControlMessageDetails | undefined;
			if (!details?.event) return undefined;
			const content = typeof message.content === "string" ? message.content : undefined;
			return new SubagentControlNoticeComponent(
				{ ...details, noticeText: formatSubagentControlNotice(details, content) },
				theme,
			);
		},
	);
	return { controlEventHandler, controlRunTerminalHandler };
}

export function formatSubagentControlNotice(details: SubagentControlMessageDetails, content?: string): string {
	return details.noticeText ?? content ?? formatControlNoticeMessage(details.event, controlNoticeTarget(details));
}

export class SubagentControlNoticeComponent implements Component {
	private readonly details: SubagentControlMessageDetails;
	private readonly theme: ExtensionContext["ui"]["theme"];

	constructor(details: SubagentControlMessageDetails, theme: ExtensionContext["ui"]["theme"]) {
		this.details = details;
		this.theme = theme;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const eventLabel = this.details.event.type.replaceAll("_", " ");
		if (width < 3) return [truncateToWidth(`Subagent ${eventLabel}`, width)];
		const bodyWidth = Math.max(1, Math.min(width - 2, 68));
		const borderChar = "─";
		const header = ` ⚠ Subagent ${eventLabel}: ${this.details.event.agent} `;
		const headerText = truncateToWidth(header, bodyWidth, "");
		const headerPadding = Math.max(0, bodyWidth - visibleWidth(headerText));
		// Truncation/inner styles inject ANSI resets; keep the closing border in
		// its own accent segment so a reset inside the text can't bleach it.
		const lines = [
			this.theme.fg("accent", `╭${headerText}`) + this.theme.fg("accent", `${borderChar.repeat(headerPadding)}╮`),
		];

		for (const line of wrapTextWithAnsi(formatSubagentControlNotice(this.details), bodyWidth)) {
			const text = truncateToWidth(line, bodyWidth, "…");
			const padding = Math.max(0, bodyWidth - visibleWidth(text));
			lines.push(this.theme.fg("accent", `│${text}`) + " ".repeat(padding) + this.theme.fg("accent", "│"));
		}
		lines.push(this.theme.fg("accent", `╰${borderChar.repeat(bodyWidth)}╯`));
		return lines;
	}
}
