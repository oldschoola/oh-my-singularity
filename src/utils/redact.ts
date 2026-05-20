/**
 * Redact sensitive data from telemetry, log payloads, and TUI displays.
 *
 * Goals:
 * - Never persist secrets (API keys, bearer tokens, PATs) to disk.
 * - Bound the size of tool args/results in observable telemetry.
 * - Preserve structural shape so downstream renderers and JSON consumers
 *   keep working — keys are not removed, only values are rewritten.
 */

/**
 * Regex matching object keys that carry secrets.
 * Matches names ending with `_KEY`, `_TOKEN`, or `_SECRET` (case-insensitive),
 * plus a few common spellings without separators.
 */
export const SECRET_KEY_PATTERN = /(?:[_-]KEY|[_-]TOKEN|[_-]SECRET|APIKEY|APITOKEN)$/i;

/**
 * Default maximum length for string values when truncation is enabled.
 */
export const MAX_TOOL_ARG_LENGTH = 500;

/**
 * Sentinel string written in place of redacted values.
 */
export const REDACTED = "[REDACTED]";

/**
 * Marker appended after truncation.
 */
const TRUNCATED_SUFFIX = "…[truncated]";

export interface RedactOptions {
	/**
	 * When true (default), strings longer than {@link maxStringLength} are
	 * truncated. The TUI typically disables this because the renderer applies
	 * its own per-block length budget.
	 */
	truncate?: boolean;
	/**
	 * Truncation threshold; defaults to {@link MAX_TOOL_ARG_LENGTH}.
	 */
	maxStringLength?: number;
}

const BEARER_PATTERN = /Bearer\s+[A-Za-z0-9._\-~+/]+=*/gi;
const PREFIXED_TOKEN_PATTERN = /\b(?:sk-|key-|token-|gh[oprsuv]_|github_pat_|pat-)[A-Za-z0-9_-]{16,}/gi;

/**
 * Redact bearer tokens and prefixed API-key patterns from a string.
 *
 * Idempotent: applying twice yields the same result.
 */
export function redactString(input: string): string {
	if (!input) return input;
	let out = input.replace(BEARER_PATTERN, "Bearer [REDACTED]");
	out = out.replace(PREFIXED_TOKEN_PATTERN, REDACTED);
	return out;
}

/**
 * Recursively redact secrets from a value.
 *
 * - Objects: keys matching {@link SECRET_KEY_PATTERN} have their string values
 *   replaced with `[REDACTED]`. Other values are recursed into.
 * - Arrays: each element is recursed into.
 * - Strings: pattern-redacted; optionally truncated.
 * - Other primitives (numbers, booleans, null, undefined, bigint): returned
 *   as-is.
 *
 * Returns a new value; input is not mutated.
 *
 * Circular references are handled by returning the sentinel string
 * `"[circular]"` for any object already visited along the current branch.
 */
export function redactValue<T>(value: T, opts: RedactOptions = {}): T {
	const seen = new WeakSet<object>();
	return walk(value, opts, seen) as T;
}

function walk(value: unknown, opts: RedactOptions, seen: WeakSet<object>): unknown {
	if (value === null || value === undefined) return value;
	const t = typeof value;
	if (t === "string") return redactStringWithTruncation(value as string, opts);
	if (t !== "object") return value;

	// Skip well-known non-plain objects that should not be recursed.
	if (value instanceof Date) return value;
	if (value instanceof RegExp) return value;
	if (value instanceof Error) {
		return {
			name: value.name,
			message: redactStringWithTruncation(value.message ?? "", opts),
			stack: value.stack ? redactStringWithTruncation(value.stack, opts) : "",
		};
	}

	const obj = value as object;
	if (seen.has(obj)) return "[circular]";
	seen.add(obj);

	if (Array.isArray(value)) {
		return value.map(item => walk(item, opts, seen));
	}

	const out: Record<string, unknown> = {};
	for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
		if (SECRET_KEY_PATTERN.test(key) && typeof v === "string") {
			out[key] = REDACTED;
		} else {
			out[key] = walk(v, opts, seen);
		}
	}
	return out;
}

function redactStringWithTruncation(value: string, opts: RedactOptions): string {
	const truncate = opts.truncate ?? true;
	const max = opts.maxStringLength ?? MAX_TOOL_ARG_LENGTH;
	let s = value;
	if (truncate && s.length > max) {
		s = s.slice(0, max) + TRUNCATED_SUFFIX;
	}
	return redactString(s);
}

/**
 * Keys on event-shaped records that may carry tool input/output payloads.
 * Each is redacted as a value graph; non-objects are passed through to
 * {@link redactValue}.
 */
const EVENT_PAYLOAD_KEYS = ["args", "input", "result", "output"] as const;

/**
 * Keys on event-shaped records that carry free-form error text.
 */
const EVENT_ERROR_KEYS = ["error", "errorMessage", "finalError", "crashReason"] as const;

/**
 * Redact a sidecar/oms event record before it is persisted.
 *
 * Returns a new object; input is not mutated. Non-object inputs are returned
 * as-is so callers can pipe through unconditionally.
 */
export function redactEvent<T>(event: T, opts: RedactOptions = {}): T {
	if (!event || typeof event !== "object") return event;
	const src = event as Record<string, unknown>;
	const out: Record<string, unknown> = { ...src };

	for (const key of EVENT_PAYLOAD_KEYS) {
		if (key in out && out[key] !== undefined) {
			out[key] = redactValue(out[key], opts);
		}
	}

	for (const key of EVENT_ERROR_KEYS) {
		const v = out[key];
		if (typeof v === "string") {
			out[key] = redactStringWithTruncation(v, opts);
		}
	}

	return out as T;
}
