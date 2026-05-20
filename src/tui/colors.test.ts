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

	test("re-asserts pane BG before padding so a content BG cannot bleed into pad cells", () => {
		// Simulate a tool block: content line opens BG.toolPending and closes
		// with a mid-line RESET. The pane bg must reappear before the pad spaces
		// so the right-side fill matches the surrounding pane, not the tool.
		const input = `${ESC}[48;2;29;33;41mTool${ESC}[0m`; // BG.toolPending + content + RESET
		const out = clipPadAnsiBg(input, 10, BG.pane);

		// BG.pane is opened once at the start and reasserted before the pad,
		// so the sequence must appear at least twice in the rendered string.
		const paneOpens = out.split(BG.pane).length - 1;
		expect(paneOpens).toBeGreaterThanOrEqual(2);

		// The BG.pane occurrence nearest the end must precede only space + RESET.
		const lastPaneIdx = out.lastIndexOf(BG.pane);
		const tail = out.slice(lastPaneIdx + BG.pane.length);
		expect(tail.replace(RESET, "")).toBe("      "); // 10 - 4 = 6 pad spaces
		expect(out.endsWith(RESET)).toBe(true);
	});
});
