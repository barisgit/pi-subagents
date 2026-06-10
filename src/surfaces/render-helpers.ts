import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/**
 * Minimal theme shape for chrome helpers: only `fg(color, text)` is required.
 * Lets the same helpers work for both `@earendil-works/pi-coding-agent` Theme and
 * any pi-tui-compatible theme.
 */
interface ChromeTheme {
	fg(color: string, text: string): string;
	bold?(text: string): string;
}

function fuzzyScore(query: string, text: string): number {
	const lq = query.toLowerCase();
	const lt = text.toLowerCase();
	if (lt.includes(lq)) return 100 + (lq.length / lt.length) * 50;
	let score = 0;
	let qi = 0;
	let consecutive = 0;
	for (let i = 0; i < lt.length && qi < lq.length; i++) {
		if (lt[i] === lq[qi]) {
			score += 10 + consecutive;
			consecutive += 5;
			qi++;
		} else {
			consecutive = 0;
		}
	}
	return qi === lq.length ? score : 0;
}

export function fuzzyFilter<T extends { name: string; description: string; model?: string }>(items: T[], query: string): T[] {
	const q = query.trim();
	if (!q) return items;
	return items
		.map((item) => ({ item, score: Math.max(fuzzyScore(q, item.name), fuzzyScore(q, item.description) * 0.8, fuzzyScore(q, item.model ?? "") * 0.6) }))
		.filter((x) => x.score > 0)
		.sort((a, b) => b.score - a.score)
		.map((x) => x.item);
}

export function pad(s: string, len: number): string {
	const vis = visibleWidth(s);
	return s + " ".repeat(Math.max(0, len - vis));
}

function normalizeRenderableText(text: string): string {
	return text
		.replaceAll("\t", "    ")
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001A\u001C-\u001F\u007F]/g, "");
}

export function row(content: string, width: number, theme: Theme): string {
	const innerW = Math.max(0, width - 2);
	const safeContent = truncateToWidth(normalizeRenderableText(content), innerW);
	return theme.fg("border", "│") + pad(safeContent, innerW) + theme.fg("border", "│");
}

export function renderHeader(text: string, width: number, theme: Theme): string {
	const innerW = Math.max(0, width - 2);
	const safeText = truncateToWidth(normalizeRenderableText(text), innerW);
	const padLen = Math.max(0, innerW - visibleWidth(safeText));
	const padLeft = Math.floor(padLen / 2);
	const padRight = padLen - padLeft;
	return (
		theme.fg("border", "╭" + "─".repeat(padLeft)) +
		theme.fg("accent", safeText) +
		theme.fg("border", "─".repeat(padRight) + "╮")
	);
}

export function formatPath(filePath: string): string {
	const home = process.env.HOME;
	if (home && filePath.startsWith(home)) return `~${filePath.slice(home.length)}`;
	return filePath;
}

export function formatScrollInfo(above: number, below: number): string {
	let info = "";
	if (above > 0) info += `↑ ${above} more`;
	if (below > 0) info += `${info ? "  " : ""}↓ ${below} more`;
	return info;
}

export function renderFooter(text: string, width: number, theme: Theme): string {
	const innerW = Math.max(0, width - 2);
	const safeText = truncateToWidth(normalizeRenderableText(text), innerW);
	const padLen = Math.max(0, innerW - visibleWidth(safeText));
	const padLeft = Math.floor(padLen / 2);
	const padRight = padLen - padLeft;
	return (
		theme.fg("border", "╰" + "─".repeat(padLeft)) +
		theme.fg("dim", safeText) +
		theme.fg("border", "─".repeat(padRight) + "╯")
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// Charter-style two-pane chrome helpers (titled top/bottom borders + body row).
// Used by `SubagentsStatusComponent` to mirror pi-charter's fullscreen picker.
// ─────────────────────────────────────────────────────────────────────────────

export interface TitledTopSegmentOptions {
	width: number;
	label: string;
	/** Plain-text tail; styled via `tailColor` (default "dim"). */
	tail?: string;
	/** Pre-rendered tail string when caller already applied ANSI; pair with `tailPlain` for length. */
	tailRendered?: string;
	/** Plain visible-width companion for `tailRendered` so dash math stays correct. */
	tailPlain?: string;
	labelColor?: string;
	tailColor?: string;
	labelBold?: boolean;
}

/**
 * Build one half of a top border with an embedded title and optional right-aligned tail.
 * Layout: `─ <label> ───…─── <tail> ─` with single dashes for spacing.
 * Returns a fragment WITHOUT corner glyphs; caller composes corners + `┬` divider.
 */
export function titledTopSegment(theme: ChromeTheme, opts: TitledTopSegmentOptions): string {
	const dash = (n: number) => theme.fg("dim", "─".repeat(Math.max(0, n)));
	const labelColor = opts.labelColor ?? "text";
	const tailColor = opts.tailColor ?? "dim";
	// Reserve at least `─ ` + label + ` ─` (4 chars) and 1 dash on each side of the tail when present.
	const labelBudget = opts.width <= 4 ? 0 : opts.width - 4;
	// Defensive: callers occasionally pass undefined labels for transient/legacy
	// runs that lack agent+mode+label; treat as empty rather than crashing pi.
	const labelText = truncateToWidth(opts.label ?? "", labelBudget);
	const labelStyled = opts.labelBold && theme.bold
		? theme.bold(theme.fg(labelColor, labelText))
		: theme.fg(labelColor, labelText);
	const tailPlain = opts.tailPlain ?? opts.tail ?? "";
	const tailRendered = opts.tailRendered ?? (opts.tail !== undefined ? theme.fg(tailColor, opts.tail) : "");
	const labelLen = visibleWidth(labelText);
	const tailLen = visibleWidth(tailPlain);
	// Layout with tail: `─ <label> ──…── <tail> ─` => fixed = 6 + labelLen + tailLen.
	// Layout without tail: `─ <label> ──…────`     => fixed = 3 + labelLen (one space + label + space).
	if (tailLen > 0) {
		const fillDashes = Math.max(1, opts.width - (labelLen + tailLen + 6));
		return `${dash(1)} ${labelStyled} ${dash(fillDashes)} ${tailRendered} ${dash(1)}`;
	}
	const fillDashes = Math.max(1, opts.width - (labelLen + 3));
	return `${dash(1)} ${labelStyled} ${dash(fillDashes)}`;
}

/**
 * Build one half of a bottom border with an embedded hint string.
 * Layout: `─ <hint> ───…─` (no tail). Empty hint renders as a solid dash run.
 */
export function titledBottomSegment(theme: ChromeTheme, width: number, hint: string, focused: boolean): string {
	const dash = (n: number) => theme.fg("dim", "─".repeat(Math.max(0, n)));
	if (width <= 0) return "";
	if (!hint) return dash(width);
	// Reserve at minimum `─ ` + hint + ` `; truncate hint to fit when narrow so we never overflow.
	const hintBudget = Math.max(0, width - 3);
	const clipped = truncateToWidth(hint, hintBudget);
	const clippedLen = visibleWidth(clipped);
	if (clippedLen === 0) return dash(width);
	const hintStyled = focused && theme.bold
		? theme.bold(theme.fg("accent", clipped))
		: theme.fg("dim", clipped);
	const fillDashes = Math.max(0, width - (clippedLen + 3));
	return `${dash(1)} ${hintStyled} ${dash(fillDashes)}`;
}

/** Pad-right to a visible width using `visibleWidth` (ANSI-aware). */
export function padRight(text: string, width: number): string {
	const vis = visibleWidth(text);
	if (vis > width) return clipText(text, width);
	return text + " ".repeat(Math.max(0, width - vis));
}

/** Slice text by character count (NOT visible width). For label text after `clipText` we then re-measure with visibleWidth. */
export function clipText(text: string, width: number): string {
	if (width <= 0) return "";
	return Array.from(text).slice(0, width).join("");
}

/**
 * Inline horizontal rule with an embedded title, NO corner/tee glyphs.
 * Used inside a pane to subdivide sections (e.g. list / legend) without
 * faking a second box border. Layout: `─ <title> ──…──`.
 */
export function flatRule(theme: ChromeTheme, title: string, width: number): string {
	if (width <= 0) return "";
	const dash = (n: number) => theme.fg("dim", "─".repeat(Math.max(0, n)));
	if (!title) return dash(width);
	const clipped = truncateToWidth(title, Math.max(0, width - 4));
	const clippedLen = visibleWidth(clipped);
	const styled = theme.fg("dim", clipped);
	const trailing = Math.max(0, width - (clippedLen + 3));
	return `${dash(1)} ${styled} ${dash(trailing)}`;
}
