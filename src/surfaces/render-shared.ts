/**
 * Shared low-level rendering primitives used by more than one renderer seam
 * (render-result.ts, render-widget.ts). Width/ANSI helpers, agent-name tinting,
 * spinners, and the local Theme shape.
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatTokens } from "./formatters.ts";

export type Theme = Pick<ExtensionContext["ui"]["theme"], "fg"> & { bold: (value: string) => string };

export function getTermWidth(): number {
	return process.stdout.columns || 120;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Truncate a line to maxWidth, preserving ANSI styling through the ellipsis.
 *
 * pi-tui's truncateToWidth adds \x1b[0m before ellipsis which resets all styling,
 * causing background color bleed in the TUI. This implementation tracks active
 * ANSI styles and re-applies them before the ellipsis.
 *
 * Uses Intl.Segmenter for proper Unicode/emoji handling (not char-by-char).
 */
export function truncLine(text: string, maxWidth: number): string {
	if (visibleWidth(text) <= maxWidth) return text;

	const targetWidth = maxWidth - 1;
	let result = "";
	let currentWidth = 0;
	let activeStyles: string[] = [];
	let i = 0;

	while (i < text.length) {
		const ansiMatch = text.slice(i).match(/^\x1b\[[0-9;]*m/);
		if (ansiMatch) {
			const code = ansiMatch[0];
			result += code;

			if (code === "\x1b[0m" || code === "\x1b[m") {
				activeStyles = [];
			} else {
				activeStyles.push(code);
			}
			i += code.length;
			continue;
		}

		let end = i;
		while (end < text.length && !text.slice(end).match(/^\x1b\[[0-9;]*m/)) {
			end++;
		}

		const textPortion = text.slice(i, end);
		for (const seg of segmenter.segment(textPortion)) {
			const grapheme = seg.segment;
			const graphemeWidth = visibleWidth(grapheme);

			if (currentWidth + graphemeWidth > targetWidth) {
				return result + activeStyles.join("") + "…";
			}

			result += grapheme;
			currentWidth += graphemeWidth;
		}
		i = end;
	}

	return result + activeStyles.join("") + "…";
}

const SPINNER = ["-", "\\", "|", "/"];
export const WIDGET_ANIMATION_MS = 80;

function spinnerFrame(): string {
	return SPINNER[Math.floor(Date.now() / WIDGET_ANIMATION_MS) % SPINNER.length]!;
}

// Named ANSI 256 colors for agent name tinting. Picked from the xterm 256 palette
// so each color is visually distinct under both dark and light terminal themes.
// User writes `color: cyan` in agent frontmatter; missing/unknown -> no tinting.
const AGENT_COLOR_MAP: Record<string, number> = {
	red: 196,
	green: 76,
	yellow: 220,
	blue: 39,
	magenta: 201,
	cyan: 51,
	orange: 208,
	pink: 213,
	purple: 141,
	teal: 80,
	lime: 154,
	gray: 245,
	white: 231,
	brown: 130,
	gold: 178,
	sky: 117,
	mint: 121,
	coral: 209,
	lavender: 183,
	crimson: 161,
};

export function tintAgentName(name: string, color: string | undefined): string {
	if (!color) return name;
	const trimmed = color.trim().toLowerCase();
	let ansi = AGENT_COLOR_MAP[trimmed];
	if (ansi === undefined) {
		// Accept raw numeric codes too (e.g. `color: 199`).
		const n = Number(trimmed);
		if (Number.isInteger(n) && n >= 0 && n <= 255) ansi = n;
	}
	if (ansi === undefined) return name;
	return `\u001b[38;5;${ansi}m${name}\u001b[39m`;
}

// Distinctive multi-headline spinner: sparkle/star cycle (vs the ASCII '- \ | /').
// Used only on the top-level parallel/single header so the headline reads as
// "the container is alive" without making every per-agent row spin too.
const MULTI_SPINNER = [
	"\u2733",
	"\u2734",
	"\u2735",
	"\u2736",
	"\u2737",
	"\u2738",
	"\u2739",
	"\u273A",
	"\u273B",
	"\u273C",
	"\u273D",
];
export function multiSpinnerFrame(): string {
	return MULTI_SPINNER[Math.floor(Date.now() / WIDGET_ANIMATION_MS) % MULTI_SPINNER.length]!;
}

export function themeBold(theme: Theme, text: string): string {
	return (theme as { bold?: (value: string) => string }).bold?.(text) ?? text;
}

export function formatTokenStat(tokens: number): string {
	return `${formatTokens(tokens)} token`;
}
