/**
 * Structured classification for why an agent process ended.
 *
 * Used alongside {@link AgentStatus} to drive retry / resume / defer decisions
 * and to give crash logs a searchable taxonomy.
 *
 * - {@link AgentStatus} is the lifecycle state ("done", "stopped", "dead", ...).
 * - {@link AgentExitClassification} is *why* the agent transitioned to that
 *   terminal state. It is only set on transition to a terminal status.
 */

export type AgentExitClassification =
	/** `agent_end` arrived with no error and exitCode 0. */
	| "completed"
	/** Explicit stop via TUI keypress, shutdown, or supervisor replace. */
	| "user_killed"
	/** `Bun.spawn` threw, omp binary missing, replica setup failed, etc. */
	| "spawn_failure"
	/** Non-zero exit code with no API-style error indicators. */
	| "process_crash"
	/** Rate limit, overload, auth failure, or credit-balance error from the model. */
	| "api_error"
	/** Repeated auto-compaction failures or runaway context usage. */
	| "context_overflow"
	/** Malformed JSONL / unparseable RPC traffic from the agent process. */
	| "rpc_protocol_error"
	/** Process exited without an `agent_end` event ever being observed. */
	| "session_vanished"
	/** Could not be classified — investigate via crash log. */
	| "unknown";

/**
 * Classifications that warrant retrying / resuming the agent.
 *
 * Everything outside this set is treated as a hard failure: the supervisor
 * should stop retrying and surface the problem to the user.
 *
 * Tuned per plan: only transient transport-layer or context-budget failures
 * are retried. Process crashes, spawn failures, and user-initiated stops are
 * deliberately excluded — retrying those wastes resources and hides bugs.
 */
export const RETRYABLE_EXIT_CLASSIFICATIONS: ReadonlySet<AgentExitClassification> = new Set([
	"api_error",
	"context_overflow",
	"rpc_protocol_error",
] satisfies AgentExitClassification[]);

/** Convenience predicate. */
export function isRetryableExit(classification: AgentExitClassification | undefined): boolean {
	if (!classification) return false;
	return RETRYABLE_EXIT_CLASSIFICATIONS.has(classification);
}

/**
 * Heuristic regexes for matching API-side failure strings emitted by the
 * model providers and surfaced via `rpc_exit error=...`.
 *
 * Anchored loosely (case-insensitive) so wrapping prose around the indicator
 * still matches. Tests freeze the canonical phrases.
 */
const API_ERROR_PATTERNS = [
	/\brate[ _-]?limit(ed)?\b/i,
	/\boverloaded?\b/i,
	/\bhttp[ _-]?(429|503|529)\b/i,
	/\bstatus(?:_| )?code[ =:]?\s*(?:429|503|529)/i,
	/\bcredit[ _-]?balance\b/i,
	/\b(?:invalid|missing|expired)[ _-](?:api[ _-]?)?key\b/i,
	/\b401\b.*\bunauth/i,
	/\bunauthorized\b/i,
	/\binsufficient[ _-]quota\b/i,
	/\banthropic[-_ ]rate[-_ ]limit/i,
];

const PROTOCOL_PATTERNS = [
	/\bunexpected end of jsonl?\b/i,
	/\bjsonl?[ _-]?parse[ _-]?(error|failure)\b/i,
	/\bmalformed rpc\b/i,
	/\binvalid rpc message\b/i,
];

const CONTEXT_OVERFLOW_PATTERNS = [
	/\bcontext[ _-](length|window)[ _-]exceeded\b/i,
	/\btoo many tokens?\b/i,
	/\bprompt is too long\b/i,
	/\bmax(imum)? context\b/i,
];

export interface ClassifyExitInput {
	/** Process exit code, if known. `null` when not yet observed. */
	exitCode: number | null;
	/** Free-form error text from the `rpc_exit` event payload. */
	rpcExitError?: string | null;
	/**
	 * Whether the agent had ever emitted an `agent_end` event. When false and
	 * the process exited, the session "vanished" mid-flight.
	 */
	sawAgentEnd?: boolean;
	/**
	 * Number of successful compactions observed for this agent. High values
	 * combined with non-zero exits hint at context overflow.
	 */
	compactionCount?: number;
}

/**
 * Classify an `rpc_exit`-style exit event.
 *
 * Order of precedence:
 * 1. Clean exit  → `completed`
 * 2. Error text matches API failure patterns → `api_error`
 * 3. Error text matches RPC parse-failure patterns → `rpc_protocol_error`
 * 4. Error text matches context-overflow patterns → `context_overflow`
 * 5. Many compactions + non-zero exit → `context_overflow` (heuristic)
 * 6. Process exited without ever emitting `agent_end` → `session_vanished`
 * 7. Otherwise → `process_crash`
 *
 * Callers that already know the cause (e.g. spawn try/catch, explicit stop)
 * should not pass through this function — they should label the
 * classification directly.
 */
export function classifyRpcExit(input: ClassifyExitInput): AgentExitClassification {
	const { exitCode, rpcExitError, sawAgentEnd, compactionCount } = input;
	const errText = (rpcExitError ?? "").trim();

	if (!errText && exitCode === 0) return "completed";

	if (errText) {
		if (API_ERROR_PATTERNS.some(re => re.test(errText))) return "api_error";
		if (PROTOCOL_PATTERNS.some(re => re.test(errText))) return "rpc_protocol_error";
		if (CONTEXT_OVERFLOW_PATTERNS.some(re => re.test(errText))) return "context_overflow";
	}

	if ((compactionCount ?? 0) >= 3 && (exitCode === null || exitCode !== 0)) {
		return "context_overflow";
	}

	if (sawAgentEnd === false) return "session_vanished";

	if (exitCode !== null && exitCode !== 0) return "process_crash";

	return "unknown";
}
