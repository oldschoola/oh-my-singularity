import { describe, expect, test } from "bun:test";
import { Ellipsis, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "./native-text";

describe("native-text shim", () => {
	test("truncateToWidth returns input unchanged when it fits", () => {
		expect(truncateToWidth("hello", 10)).toBe("hello");
	});

	test("truncateToWidth truncates with default ellipsis", () => {
		expect(truncateToWidth("helloworld", 5)).toBe("hell…");
	});

	test("truncateToWidth honors Ellipsis.Ascii", () => {
		expect(truncateToWidth("helloworld", 6, Ellipsis.Ascii)).toBe("hel...");
	});

	test("wrapTextWithAnsi splits to the requested width", () => {
		expect(wrapTextWithAnsi("a longer string", 5)).toEqual(["a", "longe", "r", "strin", "g"]);
	});

	test("visibleWidth ignores ANSI escape codes", () => {
		expect(visibleWidth("hello\x1b[31mred\x1b[0m")).toBe(8);
	});
});
