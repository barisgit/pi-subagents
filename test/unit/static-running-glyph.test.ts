import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RUNNING_GLYPH, WIDGET_ANIMATION_MS } from "../../src/surfaces/render-shared.ts";
import { stopWidgetAnimation } from "../../src/surfaces/render-widget.ts";

// Locks in the anti-flashing decision (task #6): liveness is a single static
// glyph, and the live-widget repaint cadence is coarse (>= 1s), so running rows
// no longer force ~12 repaints/sec.
describe("static running glyph + coarse repaint cadence", () => {
	it("exposes a stable, non-animated running glyph (no Date.now dependency)", () => {
		// Same value across calls and across time -> rendering it does not by
		// itself invalidate the widget every frame.
		const first = RUNNING_GLYPH;
		const second = RUNNING_GLYPH;
		assert.equal(first, second);
		assert.equal(typeof RUNNING_GLYPH, "string");
		assert.ok(RUNNING_GLYPH.length > 0);
	});

	it("uses a coarse (>= 1s) live repaint cadence, not a sub-100ms spinner tick", () => {
		assert.ok(WIDGET_ANIMATION_MS >= 1000, `expected coarse cadence >= 1000ms, got ${WIDGET_ANIMATION_MS}`);
		stopWidgetAnimation();
	});
});
