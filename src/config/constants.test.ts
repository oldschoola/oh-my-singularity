import { describe, expect, test } from "bun:test";

import { AGENT_CONFIGS, getAgentSpawnConfig } from "./constants";

function toolSet(agent: string): Set<string> {
	const cfg = getAgentSpawnConfig(agent);
	if (!cfg) throw new Error(`unknown agent: ${agent}`);
	return new Set(
		cfg.defaultTools
			.split(",")
			.map(s => s.trim())
			.filter(Boolean),
	);
}

describe("AGENT_CONFIGS tool allowlists", () => {
	const COORDINATION_TOOLS = ["task", "irc", "job", "todo_write"] as const;
	const HINDSIGHT_TOOLS = ["recall", "reflect", "retain"] as const;

	test("worker can perform code edits and structural search", () => {
		const tools = toolSet("worker");
		// Core edit capability must be retained.
		expect(tools.has("edit")).toBe(true);
		expect(tools.has("write")).toBe(true);
		// Newly broadened set.
		for (const tool of ["ast_grep", "ast_edit", "debug", "calc", "github", "inspect_image", "search_tool_bm25"]) {
			expect(tools.has(tool)).toBe(true);
		}
		// eval is intentionally excluded — workers get stuck on long-running cells.
		expect(tools.has("eval")).toBe(false);
		// Subagent coordination tools must be present so workers can fan out.
		for (const tool of COORDINATION_TOOLS) {
			expect(tools.has(tool)).toBe(true);
		}
		for (const tool of HINDSIGHT_TOOLS) {
			expect(tools.has(tool)).toBe(true);
		}
	});

	test("issuer is read-only and never holds edit/write/ast_edit", () => {
		const tools = toolSet("issuer");
		expect(tools.has("edit")).toBe(false);
		expect(tools.has("write")).toBe(false);
		expect(tools.has("ast_edit")).toBe(false);
		// Read-only structural tools should be available.
		for (const tool of ["ast_grep", "inspect_image", "github"]) {
			expect(tools.has(tool)).toBe(true);
		}
		for (const tool of COORDINATION_TOOLS) {
			expect(tools.has(tool)).toBe(true);
		}
		for (const tool of HINDSIGHT_TOOLS) {
			expect(tools.has(tool)).toBe(true);
		}
	});

	test("finisher is read-only with start_tasks and shares the issuer read-only powers", () => {
		const tools = toolSet("finisher");
		expect(tools.has("edit")).toBe(false);
		expect(tools.has("write")).toBe(false);
		expect(tools.has("ast_edit")).toBe(false);
		expect(tools.has("start_tasks")).toBe(true);
		for (const tool of ["ast_grep", "inspect_image", "github"]) {
			expect(tools.has(tool)).toBe(true);
		}
		for (const tool of COORDINATION_TOOLS) {
			expect(tools.has(tool)).toBe(true);
		}
		for (const tool of HINDSIGHT_TOOLS) {
			expect(tools.has(tool)).toBe(true);
		}
	});

	test("steering is read-only with structural search", () => {
		const tools = toolSet("steering");
		expect(tools.has("edit")).toBe(false);
		expect(tools.has("write")).toBe(false);
		expect(tools.has("ast_edit")).toBe(false);
		expect(tools.has("ast_grep")).toBe(true);
		for (const tool of COORDINATION_TOOLS) {
			expect(tools.has(tool)).toBe(true);
		}
		for (const tool of HINDSIGHT_TOOLS) {
			expect(tools.has(tool)).toBe(true);
		}
	});

	test("merger allowlist stays intentionally minimal but keeps irc for coordination", () => {
		const tools = toolSet("merger");
		expect([...tools].sort()).toEqual(["bash", "find", "grep", "irc", "read"]);
	});

	test("designer and speedy share the worker allowlist", () => {
		const worker = AGENT_CONFIGS.worker.defaultTools;
		expect(AGENT_CONFIGS.designer.defaultTools).toBe(worker);
		expect(AGENT_CONFIGS.speedy.defaultTools).toBe(worker);
	});
});
