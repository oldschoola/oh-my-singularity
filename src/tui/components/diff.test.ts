import { describe, expect, test } from "bun:test";

import { computeDiffStats, formatDiffBadge, renderUnifiedDiff, renderUnifiedPatch } from "./diff";

function stripAnsi(value: string): string {
	return value.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("renderUnifiedDiff", () => {
	test("emits a hunk header and gutter-marked +/- lines for a single-line change", () => {
		const { lines, stats } = renderUnifiedDiff({
			oldText: "alpha\nbeta\ngamma\n",
			newText: "alpha\nBETA\ngamma\n",
		});

		expect(stats).toEqual({ added: 1, removed: 1, hunks: 1 });
		const plain = lines.map(stripAnsi);
		expect(plain[0]).toMatch(/@@ -1,3 \+1,3 @@/);
		expect(plain.some(l => l.startsWith("   1   alpha"))).toBe(true);
		expect(plain.some(l => l.includes("- beta"))).toBe(true);
		expect(plain.some(l => l.includes("+ BETA"))).toBe(true);
	});

	test("returns zero stats for identical inputs", () => {
		const stats = computeDiffStats({ oldText: "x\ny\nz\n", newText: "x\ny\nz\n" });
		expect(stats).toEqual({ added: 0, removed: 0, hunks: 0 });
	});

	test("handles pure-addition (empty oldText)", () => {
		const { lines, stats } = renderUnifiedDiff({ oldText: "", newText: "first\nsecond\n" });
		expect(stats.added).toBe(2);
		expect(stats.removed).toBe(0);
		expect(stats.hunks).toBe(1);
		const plain = lines.map(stripAnsi);
		expect(plain.filter(l => l.includes("+ first")).length).toBe(1);
		expect(plain.filter(l => l.includes("+ second")).length).toBe(1);
	});

	test("handles pure-deletion (empty newText)", () => {
		const { stats } = renderUnifiedDiff({ oldText: "drop\nthis\n", newText: "" });
		expect(stats.added).toBe(0);
		expect(stats.removed).toBe(2);
	});

	test("colors line gutters with the expected ANSI sequences", () => {
		const { lines } = renderUnifiedDiff({ oldText: "a\n", newText: "a\nB\n" });
		// We expect at least one line carrying FG.added (#00ff88 bright green) ANSI.
		const hasGreen = lines.some(l => l.includes("\x1b[38;2;0;255;136m"));
		const hasHunk = lines.some(l => l.includes("\x1b[38;2;105;180;255m"));
		expect(hasGreen).toBe(true);
		expect(hasHunk).toBe(true);
	});

	test("respects maxLines truncation", () => {
		const oldText = "a\nb\nc\nd\ne\nf\ng\nh\ni\n";
		const newText = "A\nB\nC\nD\nE\nF\nG\nH\nI\n";
		const { lines } = renderUnifiedDiff({ oldText, newText, maxLines: 5 });
		expect(lines.length).toBe(6); // 5 truncated lines + "… N more" footer
		expect(lines[lines.length - 1]).toContain("more lines");
	});
});

describe("renderUnifiedPatch", () => {
	test("colorizes a pre-formatted unified patch without re-diffing", () => {
		const patch = ["@@ -1,3 +1,3 @@", " context", "-removed line", "+added line", " trailing context", ""].join("\n");

		const { lines, stats } = renderUnifiedPatch(patch);
		expect(stats).toEqual({ added: 1, removed: 1, hunks: 1 });
		const plain = lines.map(stripAnsi);
		expect(plain[0]).toContain("@@ -1,3 +1,3 @@");
		expect(plain.some(l => l.includes("+ added line"))).toBe(true);
		expect(plain.some(l => l.includes("- removed line"))).toBe(true);
	});
});

describe("formatDiffBadge", () => {
	test("returns empty string for zero changes", () => {
		expect(formatDiffBadge({ added: 0, removed: 0, hunks: 0 })).toBe("");
	});

	test("pluralizes hunk count correctly", () => {
		expect(formatDiffBadge({ added: 2, removed: 1, hunks: 1 })).toBe("+2 -1 1 hunk");
		expect(formatDiffBadge({ added: 5, removed: 3, hunks: 2 })).toBe("+5 -3 2 hunks");
	});
});
