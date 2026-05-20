import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { SessionLogWriter } from "./session-log-writer";

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oms-sl-writer-"));
});

afterEach(() => {
	try {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		// best-effort
	}
});

function readJsonLines(filePath: string): Array<Record<string, unknown>> {
	const raw = fs.readFileSync(filePath, "utf8");
	return raw
		.split(/\r?\n/)
		.filter(line => line.length > 0)
		.map(line => JSON.parse(line) as Record<string, unknown>);
}

describe("SessionLogWriter.appendAgentEvent", () => {
	test("writes a JSONL line to <sessionDir>/agents/<safe-id>.log", () => {
		const writer = new SessionLogWriter({ sessionDir: tmpDir });
		writer.appendAgentEvent("worker:task-1:worker-abcd", {
			type: "tool_call",
			ts: 1_700_000_000_000,
			toolName: "eval",
			input: { language: "py", code: "1+1" },
		});

		const logPath = path.join(tmpDir, "agents", "worker-task-1-worker-abcd.log");
		const records = readJsonLines(logPath);
		expect(records).toHaveLength(1);
		const record = records[0] as {
			agentId: string;
			ts: number;
			timestamp: string;
			event: { type: string; toolName: string };
		};
		expect(record.agentId).toBe("worker:task-1:worker-abcd");
		expect(record.ts).toBe(1_700_000_000_000);
		expect(record.event.type).toBe("tool_call");
		expect(record.event.toolName).toBe("eval");
	});

	test("appends multiple events for the same agent to one file", () => {
		const writer = new SessionLogWriter({ sessionDir: tmpDir });
		writer.appendAgentEvent("agent-x", { type: "a", ts: 1 });
		writer.appendAgentEvent("agent-x", { type: "b", ts: 2 });
		writer.appendAgentEvent("agent-x", { type: "c", ts: 3 });

		const logPath = path.join(tmpDir, "agents", "agent-x.log");
		const records = readJsonLines(logPath);
		expect(records.map(r => (r.event as { type: string }).type)).toEqual(["a", "b", "c"]);
	});

	test("separate agents get separate files", () => {
		const writer = new SessionLogWriter({ sessionDir: tmpDir });
		writer.appendAgentEvent("alpha", { type: "ping", ts: 1 });
		writer.appendAgentEvent("beta", { type: "pong", ts: 2 });

		expect(fs.existsSync(path.join(tmpDir, "agents", "alpha.log"))).toBe(true);
		expect(fs.existsSync(path.join(tmpDir, "agents", "beta.log"))).toBe(true);
	});

	test("ignores empty / non-string agent ids without throwing or creating files", () => {
		const writer = new SessionLogWriter({ sessionDir: tmpDir });
		writer.appendAgentEvent("", { type: "x" });
		writer.appendAgentEvent(undefined as unknown as string, { type: "x" });

		const agentsDir = path.join(tmpDir, "agents");
		const exists = fs.existsSync(agentsDir);
		// Directory may exist from prior sessions but should be empty when only invalid ids used.
		if (exists) {
			expect(fs.readdirSync(agentsDir)).toEqual([]);
		}
	});

	test("caps per-agent log at agentLogMaxBytes and writes a marker, then drops further events", () => {
		// 1 KiB cap so we can blow past it with a few events.
		const writer = new SessionLogWriter({ sessionDir: tmpDir, agentLogMaxBytes: 1024 });
		const filler = "x".repeat(300);
		for (let i = 0; i < 10; i += 1) {
			writer.appendAgentEvent("noisy", { type: "noise", ts: i, payload: filler });
		}

		const logPath = path.join(tmpDir, "agents", "noisy.log");
		const records = readJsonLines(logPath);
		// At least one event before the cap, and the capped marker.
		expect(records.length).toBeGreaterThanOrEqual(2);
		const types = records.map(r => {
			if (typeof r.type === "string") return r.type;
			const evt = r.event as { type?: string } | undefined;
			return evt?.type ?? "";
		});
		expect(types).toContain("agent_log_capped");

		// File never exceeds the cap.
		const sizeBytes = fs.statSync(logPath).size;
		expect(sizeBytes).toBeLessThanOrEqual(1024);

		// Further events stay dropped — line count stable.
		const before = records.length;
		writer.appendAgentEvent("noisy", { type: "noise", ts: 99, payload: filler });
		expect(readJsonLines(logPath)).toHaveLength(before);
	});
});
