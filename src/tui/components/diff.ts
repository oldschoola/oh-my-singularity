import { FG, RESET_FG } from "../colors";

/**
 * Minimal unified-diff renderer with ANSI coloring. Two entry points:
 *
 * - `renderUnifiedDiff({ oldText, newText, ... })` computes a fresh diff between
 *   two strings using a simple LCS-based hunker.
 * - `renderUnifiedPatch(patchText)` parses an already-formatted unified patch
 *   (the `apply_patch` shape) and applies coloring without re-diffing.
 *
 * Output is an array of ANSI-colored lines, one per source line, ready to be
 * embedded in the tool-renderer box body. Each line includes a fixed-width
 * line-number gutter so the reader can follow the change in the file.
 */

export type DiffStats = { added: number; removed: number; hunks: number };

export type RenderedDiff = {
	lines: string[];
	stats: DiffStats;
};

export type RenderUnifiedDiffInput = {
	oldText: string;
	newText: string;
	contextLines?: number;
	maxLines?: number;
};

const DEFAULT_CONTEXT_LINES = 2;
const GUTTER_WIDTH = 4;

function formatGutter(value: number | null): string {
	if (value == null) return " ".repeat(GUTTER_WIDTH);
	const s = String(value);
	return s.length >= GUTTER_WIDTH ? s.slice(-GUTTER_WIDTH) : s.padStart(GUTTER_WIDTH, " ");
}

type Op =
	| { kind: "ctx"; oldLine: number; newLine: number; text: string }
	| { kind: "add"; newLine: number; text: string }
	| { kind: "del"; oldLine: number; text: string };

/**
 * Compute an edit script between `oldLines` and `newLines` using an LCS DP.
 * Returns a list of context/add/del ops in source order.
 *
 * The DP runs in O(n * m) time and memory. We accept that cost because the
 * inputs are individual file edits, not whole-tree diffs.
 */
function computeEditScript(oldLines: readonly string[], newLines: readonly string[]): Op[] {
	const N = oldLines.length;
	const M = newLines.length;

	// LCS length table.
	const dp: Uint32Array = new Uint32Array((N + 1) * (M + 1));
	const stride = M + 1;
	for (let i = N - 1; i >= 0; i -= 1) {
		for (let j = M - 1; j >= 0; j -= 1) {
			if (oldLines[i] === newLines[j]) {
				dp[i * stride + j] = dp[(i + 1) * stride + (j + 1)] + 1;
			} else {
				const a = dp[(i + 1) * stride + j] ?? 0;
				const b = dp[i * stride + (j + 1)] ?? 0;
				dp[i * stride + j] = a >= b ? a : b;
			}
		}
	}

	const ops: Op[] = [];
	let i = 0;
	let j = 0;
	while (i < N && j < M) {
		if (oldLines[i] === newLines[j]) {
			ops.push({ kind: "ctx", oldLine: i + 1, newLine: j + 1, text: oldLines[i]! });
			i += 1;
			j += 1;
		} else if ((dp[(i + 1) * stride + j] ?? 0) >= (dp[i * stride + (j + 1)] ?? 0)) {
			ops.push({ kind: "del", oldLine: i + 1, text: oldLines[i]! });
			i += 1;
		} else {
			ops.push({ kind: "add", newLine: j + 1, text: newLines[j]! });
			j += 1;
		}
	}
	while (i < N) {
		ops.push({ kind: "del", oldLine: i + 1, text: oldLines[i]! });
		i += 1;
	}
	while (j < M) {
		ops.push({ kind: "add", newLine: j + 1, text: newLines[j]! });
		j += 1;
	}

	return ops;
}

type Hunk = { oldStart: number; newStart: number; ops: Op[] };

function chunkIntoHunks(ops: readonly Op[], contextLines: number): Hunk[] {
	const hunks: Hunk[] = [];
	if (ops.length === 0) return hunks;

	let i = 0;
	while (i < ops.length) {
		// Skip over leading pure-context runs of length >= 2 * contextLines.
		while (i < ops.length && ops[i]!.kind === "ctx") {
			// Find next non-ctx.
			let j = i;
			while (j < ops.length && ops[j]!.kind === "ctx") j += 1;
			const ctxRun = j - i;
			if (j >= ops.length) {
				// Trailing context only — no more hunks.
				return hunks;
			}
			if (ctxRun > contextLines) {
				i = j - contextLines;
				break;
			}
			break;
		}

		// Now ops[i] is either a change or recent context. Walk forward gathering
		// ops until we see (contextLines * 2) consecutive context lines, which marks
		// the end of the current hunk.
		const start = i;
		let lastChange = i;
		let k = i;
		while (k < ops.length) {
			if (ops[k]!.kind !== "ctx") {
				lastChange = k;
				k += 1;
				continue;
			}
			// Look ahead for a run of context.
			let r = k;
			while (r < ops.length && ops[r]!.kind === "ctx") r += 1;
			const ctxRun = r - k;
			if (ctxRun >= contextLines * 2 || r >= ops.length) {
				// Cut hunk at lastChange + contextLines (capped).
				const cut = Math.min(ops.length, lastChange + 1 + contextLines);
				const slice = ops.slice(start, cut);
				const first = slice[0]!;
				const oldStart = first.kind === "ctx" || first.kind === "del" ? first.oldLine : first.newLine;
				const newStart = first.kind === "ctx" || first.kind === "add" ? first.newLine : first.oldLine;
				hunks.push({ oldStart, newStart, ops: slice });
				i = cut;
				break;
			}
			k = r;
		}
		if (k >= ops.length) {
			// Final hunk extends to EOF.
			const cut = Math.min(ops.length, lastChange + 1 + contextLines);
			const slice = ops.slice(start, cut);
			const first = slice[0]!;
			const oldStart = first.kind === "ctx" || first.kind === "del" ? first.oldLine : first.newLine;
			const newStart = first.kind === "ctx" || first.kind === "add" ? first.newLine : first.oldLine;
			hunks.push({ oldStart, newStart, ops: slice });
			i = cut;
		}
	}

	return hunks;
}

function colorOp(op: Op): string {
	switch (op.kind) {
		case "ctx":
			return `${FG.dim}${formatGutter(op.oldLine)}   ${op.text}${RESET_FG}`;
		case "add":
			return `${FG.added}${formatGutter(op.newLine)} + ${op.text}${RESET_FG}`;
		case "del":
			return `${FG.removed}${formatGutter(op.oldLine)} - ${op.text}${RESET_FG}`;
	}
}

function colorHunkHeader(hunk: Hunk): string {
	const oldCount = hunk.ops.reduce((n, op) => n + (op.kind === "ctx" || op.kind === "del" ? 1 : 0), 0);
	const newCount = hunk.ops.reduce((n, op) => n + (op.kind === "ctx" || op.kind === "add" ? 1 : 0), 0);
	return `${FG.hunk}${" ".repeat(GUTTER_WIDTH)} @@ -${hunk.oldStart},${oldCount} +${hunk.newStart},${newCount} @@${RESET_FG}`;
}

function splitLines(text: string): string[] {
	if (text === "") return [];
	const out = text.split(/\r?\n/);
	// Trailing newline produces an empty final entry; drop it so line counts match.
	if (out.length > 0 && out[out.length - 1] === "") out.pop();
	return out;
}

export function computeDiffStats(input: RenderUnifiedDiffInput): DiffStats {
	const oldLines = splitLines(input.oldText);
	const newLines = splitLines(input.newText);
	const ops = computeEditScript(oldLines, newLines);
	const hunks = chunkIntoHunks(ops, input.contextLines ?? DEFAULT_CONTEXT_LINES);
	let added = 0;
	let removed = 0;
	for (const op of ops) {
		if (op.kind === "add") added += 1;
		else if (op.kind === "del") removed += 1;
	}
	return { added, removed, hunks: hunks.length };
}

export function renderUnifiedDiff(input: RenderUnifiedDiffInput): RenderedDiff {
	const oldLines = splitLines(input.oldText);
	const newLines = splitLines(input.newText);
	const ops = computeEditScript(oldLines, newLines);
	const hunks = chunkIntoHunks(ops, input.contextLines ?? DEFAULT_CONTEXT_LINES);

	let added = 0;
	let removed = 0;
	for (const op of ops) {
		if (op.kind === "add") added += 1;
		else if (op.kind === "del") removed += 1;
	}

	const lines: string[] = [];
	for (const hunk of hunks) {
		lines.push(colorHunkHeader(hunk));
		for (const op of hunk.ops) lines.push(colorOp(op));
	}

	const maxLines = input.maxLines ?? Number.POSITIVE_INFINITY;
	if (lines.length > maxLines) {
		const truncated = lines.slice(0, maxLines);
		truncated.push(`${FG.dim}… ${lines.length - maxLines} more lines${RESET_FG}`);
		return { lines: truncated, stats: { added, removed, hunks: hunks.length } };
	}

	return { lines, stats: { added, removed, hunks: hunks.length } };
}

const PATCH_HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Color an existing unified-patch text (e.g. what `apply_patch` was given). No
 * diffing is performed — we just tokenize each line and apply colors.
 */
export function renderUnifiedPatch(patchText: string, opts?: { maxLines?: number }): RenderedDiff {
	const rawLines = patchText.split(/\r?\n/);
	if (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") rawLines.pop();
	const out: string[] = [];
	let added = 0;
	let removed = 0;
	let hunks = 0;
	let oldLine = 0;
	let newLine = 0;

	for (const raw of rawLines) {
		const headerMatch = raw.match(PATCH_HUNK_HEADER_RE);
		if (headerMatch) {
			hunks += 1;
			oldLine = Number.parseInt(headerMatch[1] ?? "0", 10) || 0;
			newLine = Number.parseInt(headerMatch[3] ?? "0", 10) || 0;
			out.push(`${FG.hunk}${" ".repeat(GUTTER_WIDTH)} ${raw}${RESET_FG}`);
			continue;
		}
		if (raw.startsWith("+++") || raw.startsWith("---") || raw.startsWith("diff ")) {
			out.push(`${FG.muted}${" ".repeat(GUTTER_WIDTH)} ${raw}${RESET_FG}`);
			continue;
		}
		const sigil = raw[0];
		const body = raw.slice(1);
		if (sigil === "+") {
			added += 1;
			out.push(`${FG.added}${formatGutter(newLine)} + ${body}${RESET_FG}`);
			newLine += 1;
		} else if (sigil === "-") {
			removed += 1;
			out.push(`${FG.removed}${formatGutter(oldLine)} - ${body}${RESET_FG}`);
			oldLine += 1;
		} else {
			// Context (leading space) or empty line.
			const text = sigil === " " ? body : raw;
			out.push(`${FG.dim}${formatGutter(oldLine)}   ${text}${RESET_FG}`);
			oldLine += 1;
			newLine += 1;
		}
	}

	const maxLines = opts?.maxLines ?? Number.POSITIVE_INFINITY;
	if (out.length > maxLines) {
		const truncated = out.slice(0, maxLines);
		truncated.push(`${FG.dim}… ${out.length - maxLines} more lines${RESET_FG}`);
		return { lines: truncated, stats: { added, removed, hunks } };
	}

	return { lines: out, stats: { added, removed, hunks } };
}

/**
 * Compact `+N / -M` badge for the box header. Returns the empty string when
 * there is no net change to advertise.
 */
export function formatDiffBadge(stats: DiffStats): string {
	if (stats.added === 0 && stats.removed === 0 && stats.hunks === 0) return "";
	const hunkLabel = stats.hunks === 1 ? "hunk" : "hunks";
	return `+${stats.added} -${stats.removed} ${stats.hunks} ${hunkLabel}`;
}
