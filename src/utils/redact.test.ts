import { describe, expect, test } from "bun:test";

import { MAX_TOOL_ARG_LENGTH, REDACTED, redactEvent, redactString, redactValue, SECRET_KEY_PATTERN } from "./redact";

describe("SECRET_KEY_PATTERN", () => {
	test("matches common secret-bearing key names", () => {
		const positives = [
			"ANTHROPIC_API_KEY",
			"OPENAI_API_KEY",
			"GITHUB_TOKEN",
			"AUTH_TOKEN",
			"DB_SECRET",
			"client_secret",
			"x-api-key",
			"X_AUTH_TOKEN",
			"ApiKey",
		];
		for (const key of positives) {
			expect(SECRET_KEY_PATTERN.test(key)).toBe(true);
		}
	});

	test("does not match unrelated keys", () => {
		const negatives = ["KEYBOARD", "TOKEN_TYPE_HINT", "user", "path", "secrets_count", "name"];
		for (const key of negatives) {
			expect(SECRET_KEY_PATTERN.test(key)).toBe(false);
		}
	});
});

describe("redactString", () => {
	test("redacts Bearer tokens", () => {
		const out = redactString("Authorization: Bearer abc.DEF-123_xyz/+=");
		expect(out).toBe("Authorization: Bearer [REDACTED]");
	});

	test("redacts sk-... API key prefixes", () => {
		const out = redactString("export ANTHROPIC_API_KEY=sk-ant-api03-AbCdEf0123456789xyz");
		expect(out).toContain(REDACTED);
		expect(out).not.toContain("AbCdEf0123456789xyz");
	});

	test("redacts key- and token- prefixes", () => {
		const out = redactString("key-AbCdEf0123456789xyz and token-AbCdEf0123456789xyz");
		expect(out).toBe(`${REDACTED} and ${REDACTED}`);
	});

	test("redacts GitHub PAT prefixes", () => {
		const out = redactString("token=ghp_AbCdEf0123456789xyzAbCdEf");
		expect(out).toContain(REDACTED);
		expect(out).not.toContain("ghp_AbCdEf");
	});

	test("does not touch short prefixed tokens (< 16 chars)", () => {
		expect(redactString("sk-short")).toBe("sk-short");
	});

	test("empty string passes through", () => {
		expect(redactString("")).toBe("");
	});

	test("is idempotent", () => {
		const once = redactString("Bearer abc.def-ghi");
		expect(redactString(once)).toBe(once);
	});
});

describe("redactValue", () => {
	test("redacts string values under secret-named keys", () => {
		const out = redactValue({
			ANTHROPIC_API_KEY: "sk-ant-abc",
			GITHUB_TOKEN: "ghp_anything",
			user: "alice",
		});
		expect(out).toEqual({
			ANTHROPIC_API_KEY: REDACTED,
			GITHUB_TOKEN: REDACTED,
			user: "alice",
		});
	});

	test("redacts strings deep inside arrays and objects", () => {
		const out = redactValue({
			cmd: ["curl", "-H", "Authorization: Bearer abc.def"],
			nested: { result: "key-AbCdEf0123456789xyz output" },
		});
		expect(out).toEqual({
			cmd: ["curl", "-H", "Authorization: Bearer [REDACTED]"],
			nested: { result: `${REDACTED} output` },
		});
	});

	test("truncates long string values when truncate option is on (default)", () => {
		const long = "x".repeat(MAX_TOOL_ARG_LENGTH + 50);
		const out = redactValue({ payload: long }) as { payload: string };
		expect(out.payload.length).toBe(MAX_TOOL_ARG_LENGTH + "…[truncated]".length);
		expect(out.payload.startsWith("xxx")).toBe(true);
		expect(out.payload.endsWith("…[truncated]")).toBe(true);
	});

	test("does not truncate at the boundary", () => {
		const boundary = "y".repeat(MAX_TOOL_ARG_LENGTH);
		const out = redactValue({ payload: boundary }) as { payload: string };
		expect(out.payload).toBe(boundary);
	});

	test("respects truncate: false", () => {
		const long = "z".repeat(MAX_TOOL_ARG_LENGTH * 4);
		const out = redactValue({ payload: long }, { truncate: false }) as { payload: string };
		expect(out.payload).toBe(long);
	});

	test("respects custom maxStringLength", () => {
		const out = redactValue({ payload: "abcdefghij" }, { maxStringLength: 3 }) as {
			payload: string;
		};
		expect(out.payload).toBe("abc…[truncated]");
	});

	test("passes null, undefined, numbers, and booleans through", () => {
		expect(redactValue(null)).toBe(null);
		expect(redactValue(undefined)).toBe(undefined);
		expect(redactValue(42)).toBe(42);
		expect(redactValue(true)).toBe(true);
	});

	test("does not mutate input", () => {
		const input = { ANTHROPIC_API_KEY: "sk-original", nested: { x: 1 } };
		redactValue(input);
		expect(input.ANTHROPIC_API_KEY).toBe("sk-original");
	});

	test("handles circular references", () => {
		const a: Record<string, unknown> = { name: "a" };
		const b: Record<string, unknown> = { name: "b", a };
		a.b = b;
		const out = redactValue(a) as { name: string; b: { a: string | Record<string, unknown> } };
		expect(out.name).toBe("a");
		expect(out.b.a).toBe("[circular]");
	});

	test("converts Error instances to plain redacted objects", () => {
		const err = new Error("Bearer abc.def-ghi-jklmnop crashed");
		const out = redactValue(err) as { name: string; message: string };
		expect(out.name).toBe("Error");
		expect(out.message).toBe("Bearer [REDACTED] crashed");
	});

	test("non-string secret-key values are still recursed into, not redacted", () => {
		const out = redactValue({ AUTH_TOKEN: { kind: "object" } }) as {
			AUTH_TOKEN: { kind: string };
		};
		expect(out.AUTH_TOKEN).toEqual({ kind: "object" });
	});
});

describe("redactEvent", () => {
	test("redacts args/input/result/output payloads", () => {
		const out = redactEvent({
			type: "tool_call",
			args: { env: { ANTHROPIC_API_KEY: "sk-abc" } },
			input: { token: "Bearer abc.def-ghi-jklmnop" },
			result: { OPENAI_API_KEY: "sk-xyz" },
			output: "key-AbCdEf0123456789xyz",
		});
		expect(out).toEqual({
			type: "tool_call",
			args: { env: { ANTHROPIC_API_KEY: REDACTED } },
			input: { token: "Bearer [REDACTED]" },
			result: { OPENAI_API_KEY: REDACTED },
			output: REDACTED,
		});
	});

	test("redacts free-form error strings", () => {
		const out = redactEvent({
			error: "Auth failed: Bearer abc.def-ghi-jklmnop",
			errorMessage: "key-AbCdEf0123456789xyz blew up",
			finalError: "no secrets here",
			crashReason: "rpc_exit error=Bearer abc.def-ghi-jklmnop",
		});
		expect(out).toEqual({
			error: "Auth failed: Bearer [REDACTED]",
			errorMessage: `${REDACTED} blew up`,
			finalError: "no secrets here",
			crashReason: "rpc_exit error=Bearer [REDACTED]",
		});
	});

	test("ignores non-object inputs", () => {
		expect(redactEvent("plain string")).toBe("plain string");
		expect(redactEvent(null)).toBe(null);
		expect(redactEvent(undefined)).toBe(undefined);
		expect(redactEvent(42)).toBe(42);
	});

	test("does not mutate input event", () => {
		const event = {
			args: { ANTHROPIC_API_KEY: "sk-original" },
			error: "Bearer abc.def-ghi-jklmnop",
		};
		redactEvent(event);
		expect(event.args.ANTHROPIC_API_KEY).toBe("sk-original");
		expect(event.error).toBe("Bearer abc.def-ghi-jklmnop");
	});
});
