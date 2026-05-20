import { describe, expect, test } from "bun:test";
import { BG, clipPadAnsiBg, RESET, RESET_FG, visibleWidth } from "./colors";

const ESC = "\x1b";

describe("clipPadAnsiBg", () => {
	test("returns empty string when width is zero", () => {
		expect(clipPadAnsiBg("hello", 0, BG.pane)).toBe("");
		expect(clipPadAnsiBg(`${ESC}[31mhello${ESC}[0m`, 0, BG.pane)).toBe("");
	});

	test("padding region carries BG open and trailing RESET", () => {
		const out = clipPadAnsiBg("hi", 6, BG.pane);

		// Starts with the BG open sequence.
		expect(out.startsWith(BG.pane)).toBe(true);
		// Ends with a full RESET, which terminates both FG and BG.
		expect(out.endsWith(RESET)).toBe(true);
		// Visible width must equal the requested column width — pad cells
		// must inherit the painted BG, not be emitted after a RESET.
		expect(visibleWidth(out)).toBe(6);
		// The 4 padding cells must live before the final RESET, so the only
		// RESET in the string is the closing one.
		const resets = out.match(/\x1b\[0m/g) ?? [];
		expect(resets.length).toBe(1);
	});

	test("preserves BG across mid-line RESET by replacing it with RESET_FG", () => {
		// Input embeds a mid-line full RESET (\x1b[0m) — naive emission would
		// strip the painted background for the trailing characters/padding.
		const input = `${ESC}[31mA${ESC}[0mB`;
		const out = clipPadAnsiBg(input, 4, BG.pane);

		// Mid-line full RESET must be downgraded to RESET_FG so BG persists.
		expect(out.includes(RESET_FG)).toBe(true);
		// Exactly one full RESET allowed — the terminator at the end.
		const resets = out.match(/\x1b\[0m/g) ?? [];
		expect(resets.length).toBe(1);
		expect(out.endsWith(RESET)).toBe(true);
		// Visible width still matches the requested column width.
		expect(visibleWidth(out)).toBe(4);
	});
});
