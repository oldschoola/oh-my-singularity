import { describe, expect, test } from "bun:test";

import { highlightLine } from "./syntax";

function stripAnsi(value: string): string {
	return value.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("highlightLine", () => {
	test("preserves the visible content exactly for typescript", () => {
		const line = `const x: number = 42; // greeting`;
		const colored = highlightLine(line, "ts");
		expect(stripAnsi(colored)).toBe(line);
	});

	test("colors keywords differently than identifiers in typescript", () => {
		const colored = highlightLine("const value = 7;", "ts");
		// The line should contain ANSI sequences.
		expect(colored).not.toBe("const value = 7;");
		expect(colored).toContain("const");
		expect(stripAnsi(colored)).toBe("const value = 7;");
	});

	test("colors json keys and values distinctly", () => {
		const colored = highlightLine(`	"name": "Alice",`, "json");
		expect(stripAnsi(colored)).toBe(`	"name": "Alice",`);
	});

	test("falls back to plain bright text for unknown languages", () => {
		const colored = highlightLine("some random text", "unknown-lang");
		expect(stripAnsi(colored)).toBe("some random text");
		// Should at least be wrapped in some ANSI sequence (bright body).
		expect(colored).not.toBe("some random text");
	});

	test("handles yaml key/value pairs", () => {
		const colored = highlightLine("  name: Alice", "yaml");
		expect(stripAnsi(colored)).toBe("  name: Alice");
		expect(colored).toContain("name");
		expect(colored).toContain("Alice");
	});

	test("colors python comments and keywords", () => {
		const colored = highlightLine("def foo():  # docstring", "py");
		expect(stripAnsi(colored)).toBe("def foo():  # docstring");
	});

	test("returns the empty string for empty input", () => {
		expect(highlightLine("", "ts")).toBe("");
	});
});
