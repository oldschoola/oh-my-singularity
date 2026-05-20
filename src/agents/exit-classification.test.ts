import { describe, expect, test } from "bun:test";

import {
	type AgentExitClassification,
	classifyRpcExit,
	isRetryableExit,
	RETRYABLE_EXIT_CLASSIFICATIONS,
} from "./exit-classification";

describe("RETRYABLE_EXIT_CLASSIFICATIONS", () => {
	test("contains only transient transport-layer failures", () => {
		expect([...RETRYABLE_EXIT_CLASSIFICATIONS].sort()).toEqual([
			"api_error",
			"context_overflow",
			"rpc_protocol_error",
		]);
	});
});

describe("isRetryableExit", () => {
	test("matches RETRYABLE set", () => {
		const retryable: AgentExitClassification[] = ["api_error", "context_overflow", "rpc_protocol_error"];
		for (const c of retryable) expect(isRetryableExit(c)).toBe(true);
	});

	test("non-retryable classifications return false", () => {
		const nonRetryable: AgentExitClassification[] = [
			"completed",
			"user_killed",
			"spawn_failure",
			"process_crash",
			"session_vanished",
			"unknown",
		];
		for (const c of nonRetryable) expect(isRetryableExit(c)).toBe(false);
	});

	test("undefined is not retryable", () => {
		expect(isRetryableExit(undefined)).toBe(false);
	});
});

describe("classifyRpcExit", () => {
	test("clean exit → completed", () => {
		expect(classifyRpcExit({ exitCode: 0 })).toBe("completed");
		expect(classifyRpcExit({ exitCode: 0, rpcExitError: "" })).toBe("completed");
	});

	test("non-zero exit, no error → process_crash", () => {
		expect(classifyRpcExit({ exitCode: 1 })).toBe("process_crash");
		expect(classifyRpcExit({ exitCode: 137 })).toBe("process_crash");
	});

	test("rate-limit error → api_error", () => {
		expect(classifyRpcExit({ exitCode: 1, rpcExitError: "anthropic rate-limit exceeded" })).toBe("api_error");
		expect(classifyRpcExit({ exitCode: 1, rpcExitError: "HTTP 429 Too Many Requests" })).toBe("api_error");
		expect(classifyRpcExit({ exitCode: 1, rpcExitError: "model is overloaded" })).toBe("api_error");
		expect(classifyRpcExit({ exitCode: 1, rpcExitError: "credit balance is too low" })).toBe("api_error");
		expect(classifyRpcExit({ exitCode: 1, rpcExitError: "401 Unauthorized" })).toBe("api_error");
		expect(classifyRpcExit({ exitCode: 1, rpcExitError: "invalid api key" })).toBe("api_error");
		expect(classifyRpcExit({ exitCode: 1, rpcExitError: "insufficient_quota" })).toBe("api_error");
	});

	test("HTTP 503/529 → api_error", () => {
		expect(classifyRpcExit({ exitCode: 1, rpcExitError: "HTTP 503 service unavailable" })).toBe("api_error");
		expect(classifyRpcExit({ exitCode: 1, rpcExitError: "status_code=529" })).toBe("api_error");
	});

	test("RPC parse failures → rpc_protocol_error", () => {
		expect(classifyRpcExit({ exitCode: 1, rpcExitError: "unexpected end of JSONL stream" })).toBe(
			"rpc_protocol_error",
		);
		expect(classifyRpcExit({ exitCode: 1, rpcExitError: "JSONL parse error: bad token" })).toBe("rpc_protocol_error");
		expect(classifyRpcExit({ exitCode: 1, rpcExitError: "malformed rpc payload" })).toBe("rpc_protocol_error");
	});

	test("context-overflow phrasing → context_overflow", () => {
		expect(classifyRpcExit({ exitCode: 1, rpcExitError: "context_length exceeded" })).toBe("context_overflow");
		expect(classifyRpcExit({ exitCode: 1, rpcExitError: "prompt is too long" })).toBe("context_overflow");
		expect(classifyRpcExit({ exitCode: 1, rpcExitError: "context window exceeded" })).toBe("context_overflow");
	});

	test("many compactions + non-zero exit → context_overflow heuristic", () => {
		expect(classifyRpcExit({ exitCode: 1, rpcExitError: "", compactionCount: 5 })).toBe("context_overflow");
		// Threshold is 3
		expect(classifyRpcExit({ exitCode: 1, rpcExitError: "", compactionCount: 2 })).toBe("process_crash");
	});

	test("no agent_end seen + non-zero exit → session_vanished beats process_crash when exitCode is null", () => {
		expect(classifyRpcExit({ exitCode: null, sawAgentEnd: false })).toBe("session_vanished");
	});

	test("unknown exitCode and no signal → unknown", () => {
		expect(classifyRpcExit({ exitCode: null })).toBe("unknown");
	});

	test("api_error wins over process_crash when both signals present", () => {
		expect(classifyRpcExit({ exitCode: 137, rpcExitError: "rate limit hit" })).toBe("api_error");
	});

	test("rpc_protocol_error wins over context_overflow on error text", () => {
		// Construct a string that matches protocol but not context patterns
		expect(classifyRpcExit({ exitCode: 1, rpcExitError: "JSONL parse failure at offset 42" })).toBe(
			"rpc_protocol_error",
		);
	});

	test("empty errText with exitCode 0 returns completed regardless of other signals", () => {
		expect(
			classifyRpcExit({
				exitCode: 0,
				rpcExitError: "",
				sawAgentEnd: false,
				compactionCount: 10,
			}),
		).toBe("completed");
	});
});
