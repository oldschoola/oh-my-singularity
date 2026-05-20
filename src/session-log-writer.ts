import * as fs from "node:fs";
import * as path from "node:path";

import type { AgentExitClassification } from "./agents/exit-classification";
import type { AgentInfo } from "./agents/types";
import { asRecord, logger } from "./utils";
import { redactEvent, redactString, redactValue } from "./utils/redact";

const DEFAULT_OMS_LOG_MAX_BYTES = 25 * 1024 * 1024;
const DEFAULT_AGENT_LOG_MAX_BYTES = 25 * 1024 * 1024;
const OMS_LOG_FLUSH_INTERVAL_MS = 100;
const OMS_LOG_FLUSH_MAX_LINES = 50;

type JsonRecord = Record<string, unknown>;

export type CrashLogAgentSnapshot = Pick<
	AgentInfo,
	| "id"
	| "agentType"
	| "taskId"
	| "tasksAgentId"
	| "status"
	| "spawnedAt"
	| "lastActivity"
	| "sessionId"
	| "contextWindow"
	| "contextTokens"
	| "compactionCount"
	| "exitClassification"
>;

export type CrashLogInput = {
	context: string;
	error: unknown;
	timestamp?: number;
	agent?: CrashLogAgentSnapshot;
	recentEvents?: unknown[];
	state?: unknown;
	extra?: unknown;
	classification?: AgentExitClassification;
};

function sanitizeToken(value: string, fallback: string, maxLen = 80): string {
	const normalized = value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+/, "")
		.replace(/-+$/, "");
	if (!normalized) return fallback;
	return normalized.slice(0, maxLen) || fallback;
}

function formatTimestampForFile(ts: number): string {
	return new Date(ts).toISOString().replace(/\..*$/, "").replace(/:/g, "-");
}

function normalizeError(value: unknown): {
	name: string;
	message: string;
	stack: string;
} {
	if (value instanceof Error) {
		return {
			name: value.name || "Error",
			message: value.message || String(value),
			stack: value.stack || "",
		};
	}

	if (typeof value === "string") {
		return {
			name: "Error",
			message: value,
			stack: "",
		};
	}

	const rec = asRecord(value);
	const message = rec && typeof rec.message === "string" ? rec.message : String(value);
	const stack = rec && typeof rec.stack === "string" ? rec.stack : "";
	const name = rec && typeof rec.name === "string" ? rec.name : "Error";
	return { name, message, stack };
}

function safeJsonStringify(value: unknown, spaces = 0): string {
	const seen = new WeakSet<object>();
	const out = JSON.stringify(
		value,
		(_key, raw) => {
			if (raw instanceof Error) {
				return {
					name: raw.name,
					message: raw.message,
					stack: raw.stack,
				};
			}
			if (typeof raw === "bigint") return raw.toString();
			if (typeof raw === "function") return `[function ${raw.name || "anonymous"}]`;
			if (raw && typeof raw === "object") {
				if (seen.has(raw)) return "[circular]";
				seen.add(raw);
			}
			return raw;
		},
		spaces,
	);
	if (typeof out === "string") return out;
	return JSON.stringify(String(value));
}

function formatSection(name: string, value: unknown): string {
	return `${name}:\n${safeJsonStringify(value, 2)}`;
}

export class SessionLogWriter {
	private readonly sessionDir: string;
	private readonly omsLogPath: string;
	private readonly crashesDir: string;
	private readonly omsLogMaxBytes: number;
	private readonly agentLogMaxBytes: number;
	private readonly agentsDir: string;

	private omsLogSizeBytes: number | null = null;
	private omsLogCapped = false;
	private readonly agentLogState = new Map<string, { path: string; sizeBytes: number; capped: boolean }>();
	private agentsDirEnsured = false;
	private pendingLines: string[] = [];
	private flushTimer: Timer | null = null;
	private flushInFlight: Promise<void> | null = null;
	private disposed = false;

	constructor(opts: { sessionDir: string; omsLogMaxBytes?: number; agentLogMaxBytes?: number }) {
		this.sessionDir = opts.sessionDir;
		this.omsLogPath = path.join(this.sessionDir, "oms.log");
		this.crashesDir = path.join(this.sessionDir, "crashes");
		this.agentsDir = path.join(this.sessionDir, "agents");
		this.omsLogMaxBytes = Math.max(1024, opts.omsLogMaxBytes ?? DEFAULT_OMS_LOG_MAX_BYTES);
		this.agentLogMaxBytes = Math.max(1024, opts.agentLogMaxBytes ?? DEFAULT_AGENT_LOG_MAX_BYTES);

		try {
			fs.mkdirSync(this.sessionDir, { recursive: true });
		} catch (err) {
			logger.debug(
				"session-log-writer.ts: best-effort failure after fs.mkdirSync(this.sessionDir, { recursive: true });",
				{ err },
			);
		}
	}

	appendOmsEvent(agentId: string, event: unknown): void {
		const rec = asRecord(event);
		const eventTs = rec && typeof rec.ts === "number" ? rec.ts : Date.now();

		this.appendOmsRecord({
			ts: eventTs,
			timestamp: new Date(eventTs).toISOString(),
			agentId,
			event: redactEvent(event),
		});
	}

	/**
	 * Append a single registry event for `agentId` to the per-agent JSONL log
	 * at `<sessionDir>/agents/<safe-id>.log`. Each line is one JSON object
	 * `{ ts, timestamp, agentId, event }`. Capped per file at `agentLogMaxBytes`
	 * (default 25 MiB); once capped, a single marker line is written and further
	 * events for that agent are dropped. Best-effort: filesystem failures are
	 * swallowed so diagnostic logging never breaks the loop.
	 */
	appendAgentEvent(agentId: string, event: unknown): void {
		if (this.disposed) return;
		if (typeof agentId !== "string" || agentId.length === 0) return;

		const state = this.getAgentLogState(agentId);
		if (!state || state.capped) return;

		const rec = asRecord(event);
		const eventTs = rec && typeof rec.ts === "number" ? rec.ts : Date.now();
		const line = `${safeJsonStringify({
			ts: eventTs,
			timestamp: new Date(eventTs).toISOString(),
			agentId,
			event: redactEvent(event),
		})}\n`;
		const lineBytes = Buffer.byteLength(line);

		if (state.sizeBytes + lineBytes > this.agentLogMaxBytes) {
			state.capped = true;
			const marker = `${safeJsonStringify({
				ts: Date.now(),
				timestamp: new Date().toISOString(),
				type: "agent_log_capped",
				message: `agent log reached ${this.agentLogMaxBytes} bytes; skipping subsequent entries`,
			})}\n`;
			const markerBytes = Buffer.byteLength(marker);
			if (state.sizeBytes + markerBytes <= this.agentLogMaxBytes) {
				try {
					fs.appendFileSync(state.path, marker, "utf8");
					state.sizeBytes += markerBytes;
				} catch (err) {
					logger.debug("session-log-writer.ts: failed to write agent_log_capped marker", { err, agentId });
				}
			}
			return;
		}

		try {
			fs.appendFileSync(state.path, line, "utf8");
			state.sizeBytes += lineBytes;
		} catch (err) {
			logger.debug("session-log-writer.ts: failed to append agent event", { err, agentId });
		}
	}

	private getAgentLogState(agentId: string): { path: string; sizeBytes: number; capped: boolean } | null {
		const cached = this.agentLogState.get(agentId);
		if (cached) return cached;

		if (!this.agentsDirEnsured) {
			try {
				fs.mkdirSync(this.agentsDir, { recursive: true });
				this.agentsDirEnsured = true;
			} catch (err) {
				logger.debug("session-log-writer.ts: failed to create agents/ dir", { err });
				return null;
			}
		}

		const fileName = `${sanitizeToken(agentId, "agent", 120)}.log`;
		const filePath = path.join(this.agentsDir, fileName);
		let sizeBytes = 0;
		try {
			sizeBytes = fs.statSync(filePath).size;
		} catch {
			// Fresh file — size stays 0.
		}
		const state = { path: filePath, sizeBytes, capped: false };
		this.agentLogState.set(agentId, state);
		return state;
	}

	writeCrashLog(input: CrashLogInput): string | null {
		const ts = typeof input.timestamp === "number" ? input.timestamp : Date.now();
		const isoTs = new Date(ts).toISOString();
		const contextToken = this.buildCrashContextToken(input);
		const fileName = `${formatTimestampForFile(ts)}-${contextToken}.log`;
		const filePath = path.join(this.crashesDir, fileName);

		const err = normalizeError(input.error);
		const lines: string[] = [];
		lines.push("OMS Crash Log");
		lines.push("");
		lines.push(`timestamp: ${isoTs}`);
		lines.push(`context: ${input.context}`);
		if (input.classification) {
			lines.push(`classification: ${input.classification}`);
		}
		lines.push(`pid: ${process.pid}`);
		lines.push(`cwd: ${process.cwd()}`);
		lines.push("");
		lines.push("error:");
		lines.push(`name: ${err.name}`);
		lines.push(`message: ${redactString(err.message)}`);
		if (err.stack.trim()) {
			lines.push("stack:");
			lines.push(redactString(err.stack));
		}

		if (input.agent) {
			lines.push("");
			lines.push(formatSection("agent", input.agent));
		}

		if (input.state !== undefined) {
			lines.push("");
			lines.push(formatSection("state", redactValue(input.state)));
		}

		if (Array.isArray(input.recentEvents) && input.recentEvents.length > 0) {
			lines.push("");
			lines.push(
				formatSection(
					"recentEvents",
					input.recentEvents.map(e => redactEvent(e)),
				),
			);
		}

		if (input.extra !== undefined) {
			lines.push("");
			lines.push(formatSection("extra", redactValue(input.extra)));
		}

		const payload = `${lines.join("\n").trimEnd()}\n`;
		try {
			fs.mkdirSync(this.crashesDir, { recursive: true });
			fs.writeFileSync(filePath, payload, "utf8");
			return filePath;
		} catch {
			return null;
		}
	}

	private buildCrashContextToken(input: CrashLogInput): string {
		const agent = input.agent;
		const classification = input.classification ?? agent?.exitClassification;
		const classToken = classification ? sanitizeToken(classification, "", 24) : "";
		if (agent) {
			const agentType = sanitizeToken(agent.agentType, "agent", 24);
			const idSource = agent.tasksAgentId?.trim() || agent.id?.trim() || "unknown";
			const idToken = sanitizeToken(idSource, "unknown", 48);
			return classToken ? `${agentType}-${classToken}-${idToken}` : `${agentType}-${idToken}`;
		}
		const ctx = sanitizeToken(input.context, "oms", 72);
		return classToken ? `${ctx}-${classToken}` : ctx;
	}

	private appendOmsRecord(record: JsonRecord): void {
		const line = `${safeJsonStringify(record)}\n`;
		if (this.omsLogCapped || this.disposed) return;

		if (this.omsLogSizeBytes === null) {
			this.omsLogSizeBytes = this.readOmsLogSize();
		}

		const lineBytes = Buffer.byteLength(line);
		if ((this.omsLogSizeBytes ?? 0) + lineBytes > this.omsLogMaxBytes) {
			this.omsLogCapped = true;
			const marker = `${safeJsonStringify({
				ts: Date.now(),
				timestamp: new Date().toISOString(),
				type: "oms_log_capped",
				message: `oms.log reached ${this.omsLogMaxBytes} bytes; skipping subsequent entries`,
			})}\n`;
			const markerBytes = Buffer.byteLength(marker);
			if ((this.omsLogSizeBytes ?? 0) + markerBytes <= this.omsLogMaxBytes) {
				this.queueOmsLine(marker, markerBytes);
			}
			return;
		}

		this.queueOmsLine(line, lineBytes);
	}

	private readOmsLogSize(): number {
		try {
			return fs.statSync(this.omsLogPath).size;
		} catch {
			return 0;
		}
	}

	private queueOmsLine(line: string, bytes: number): void {
		this.pendingLines.push(line);
		this.omsLogSizeBytes = (this.omsLogSizeBytes ?? 0) + bytes;
		if (this.pendingLines.length >= OMS_LOG_FLUSH_MAX_LINES) {
			void this.flushPendingOmsLog();
			return;
		}

		this.scheduleFlush();
	}

	private scheduleFlush(): void {
		if (this.flushTimer || this.disposed) return;
		this.flushTimer = setTimeout(() => {
			this.flushTimer = null;
			void this.flushPendingOmsLog();
		}, OMS_LOG_FLUSH_INTERVAL_MS);

		const timer = this.flushTimer as Timer;
		if (typeof timer.unref === "function") timer.unref();
	}

	async flushPendingOmsLog(): Promise<void> {
		if (this.flushTimer) {
			clearTimeout(this.flushTimer);
			this.flushTimer = null;
		}

		if (this.flushInFlight) {
			await this.flushInFlight;
		}
		if (this.pendingLines.length === 0) return;

		const payload = this.pendingLines.join("");
		this.pendingLines = [];

		const writePromise = (async () => {
			try {
				await fs.promises.appendFile(this.omsLogPath, payload, "utf8");
			} catch (err) {
				logger.debug(
					'session-log-writer.ts: best-effort failure after await fs.promises.appendFile(this.omsLogPath, payload, "utf8");',
					{ err },
				);
			}
		})();
		this.flushInFlight = writePromise;
		try {
			await writePromise;
		} finally {
			if (this.flushInFlight === writePromise) this.flushInFlight = null;
		}

		if (this.pendingLines.length >= OMS_LOG_FLUSH_MAX_LINES) {
			void this.flushPendingOmsLog();
			return;
		}
		if (this.pendingLines.length > 0 && !this.disposed) {
			this.scheduleFlush();
		}
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		while (this.flushInFlight || this.pendingLines.length > 0) {
			await this.flushPendingOmsLog();
			if (this.flushInFlight) {
				await this.flushInFlight;
			}
		}
	}
}
