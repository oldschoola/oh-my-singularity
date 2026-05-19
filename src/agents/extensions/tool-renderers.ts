import { Ellipsis, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "./native-text";
import { sanitizeRenderableText } from "../../tui/components/text-formatter";
import type {
	ToolParams,
	ToolRenderCallOptions,
	ToolRenderComponent,
	ToolRenderResultOptions,
	ToolResultWithError,
	ToolTheme,
} from "./types";

const MAX_ARG_PREVIEW = 80;
const COLLAPSED_LINES = 3;
const EXPANDED_LINES = 20;
const BODY_INDENT = "  ";
const MIN_WIDTH = 1;
const ELLIPSIS_UNICODE = Ellipsis.Unicode;
const NO_PADDING = false;

/**
 * renderCall: status icon + tool label + key args.
 *
 * - Streaming: header line + per-arg body lines.
 * - Non-streaming: concise one-line header.
 */
export function renderToolCall(
	toolLabel: string | (() => string),
	args: readonly unknown[] | (() => readonly unknown[]),
	theme: ToolTheme,
	options?: ToolRenderCallOptions,
): ToolRenderComponent {
	const separator = theme.sep?.dot ? ` ${theme.sep.dot} ` : " · ";
	const resolveArgs = () => {
		const resolved = typeof args === "function" ? args() : args;
		if (!Array.isArray(resolved)) return [];
		return resolved
			.filter((arg): arg is string => typeof arg === "string")
			.map(arg => sanitizeRenderableText(arg).trim())
			.filter(Boolean);
	};
	const makeTitle = () => {
		const resolved = typeof toolLabel === "function" ? toolLabel() : toolLabel;
		return theme.fg("toolTitle", theme.bold ? theme.bold(resolved) : resolved);
	};
	return {
		render(width: number): string[] {
			const renderWidth = normalizeWidth(width);
			const hasResult = Boolean(options?.result);
			const isStreaming = !hasResult || options?.isPartial === true;
			const status =
				options?.isPartial === true
					? "running"
					: hasResult
						? options?.result?.isError === true
							? "error"
							: "success"
						: "pending";
			const icon = styledIcon(status, theme, options?.spinnerFrame);
			const header = `${icon} ${makeTitle()}`;
			const visibleArgs = resolveArgs();
			if (isStreaming && visibleArgs.length > 0) {
				const lines = [truncateToWidth(header, renderWidth, ELLIPSIS_UNICODE, NO_PADDING)];
				const wrappedWidth = Math.max(MIN_WIDTH, renderWidth - BODY_INDENT.length);
				for (const arg of visibleArgs) {
					const wrapped = wrapTextWithAnsi(arg, wrappedWidth);
					if (wrapped.length === 0) continue;
					for (const line of wrapped) {
						lines.push(
							truncateToWidth(
								`${BODY_INDENT}${theme.fg("muted", line)}`,
								renderWidth,
								ELLIPSIS_UNICODE,
								NO_PADDING,
							),
						);
					}
				}
				return lines;
			}

			const argsPreview = visibleArgs.join(separator);
			const previewText = argsPreview || extractSummaryLine(options?.result);
			const preview = truncateToWidth(
				normalizeText(previewText),
				MAX_ARG_PREVIEW,
				ELLIPSIS_UNICODE,
				NO_PADDING,
			);
			const summaryScope = !argsPreview && options?.result?.isError === true ? "error" : "muted";
			const suffix = preview ? `${separator}${theme.fg(summaryScope, preview)}` : "";
			return [truncateToWidth(`${header}${suffix}`, renderWidth, ELLIPSIS_UNICODE, NO_PADDING)];
		},
	};
}

/**
 * renderResult: expandable body lines only.
 * Short single-line results are suppressed here because they already
 * appear in the renderCall header suffix.
 */
export function renderToolResult(
	_toolLabel: string,
	result: ToolResultWithError,
	options: ToolRenderResultOptions,
	theme: ToolTheme,
): ToolRenderComponent {
	const isError = result.isError === true;
	const allLines = extractTextLines(result);

	const maxBody = options.expanded ? EXPANDED_LINES : COLLAPSED_LINES;
	const visibleBody = allLines.slice(0, maxBody);
	const hasMore = allLines.length > maxBody;
	const singleShortLine =
		allLines.length <= 1 && visibleWidth((allLines[0] ?? "").trim()) <= MAX_ARG_PREVIEW;

	return {
		render(width: number): string[] {
			const renderWidth = normalizeWidth(width);
			// Short single-line results appear in the header suffix; skip body unless
			// the render width is too narrow for the suffix to actually fit the text.
			if (singleShortLine && visibleWidth((allLines[0] ?? "").trim()) <= renderWidth) {
				return [];
			}
			const lines: string[] = [];
			const wrappedWidth = Math.max(MIN_WIDTH, renderWidth - BODY_INDENT.length);
			for (const line of visibleBody) {
				const wrapped = wrapTextWithAnsi(line, wrappedWidth);
				if (wrapped.length === 0) {
					lines.push(truncateToWidth(BODY_INDENT, renderWidth, ELLIPSIS_UNICODE, NO_PADDING));
					continue;
				}
				for (const bodyLine of wrapped) {
					lines.push(
						truncateToWidth(
							`${BODY_INDENT}${theme.fg(isError ? "error" : "toolOutput", bodyLine)}`,
							renderWidth,
							ELLIPSIS_UNICODE,
							NO_PADDING,
						),
					);
				}
			}
			if (!options.expanded && hasMore) {
				lines.push(
					truncateToWidth(
						`${BODY_INDENT}${theme.fg("dim", "(Ctrl+O for more)")}`,
						renderWidth,
						ELLIPSIS_UNICODE,
						NO_PADDING,
					),
				);
			}
			return lines;
		},
	};
}

function normalizeText(value: unknown): string {
	if (typeof value === "string") return sanitizeRenderableText(value);
	if (value === null || value === undefined) return "";
	return sanitizeRenderableText(String(value));
}

export function normalizeWidth(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return MAX_ARG_PREVIEW;
	return Math.max(MIN_WIDTH, Math.trunc(value));
}

function styledIcon(
	status: "success" | "error" | "pending" | "running",
	theme: ToolTheme,
	spinnerFrame?: number,
): string {
	if (status === "running" && Array.isArray(theme.spinnerFrames) && typeof spinnerFrame === "number") {
		return theme.spinnerFrames[spinnerFrame % theme.spinnerFrames.length] ?? "…";
	}
	if (theme.styledSymbol) {
		const map: Record<string, [string, string]> = {
			success: ["status.success", "success"],
			error: ["status.error", "error"],
			pending: ["status.pending", "muted"],
			running: ["status.running", "accent"],
		};
		const entry = map[status];
		if (entry) return theme.styledSymbol(entry[0], entry[1]);
	}
	switch (status) {
		case "success":
			return "✓";
		case "error":
			return "✗";
		case "pending":
			return "…";
		case "running":
			return "⏳";
	}
}

function extractTextLines(result: ToolResultWithError): string[] {
	const content = result.content;
	if (!Array.isArray(content)) return [];
	for (const block of content) {
		if (block.type === "text" && typeof block.text === "string") {
			return sanitizeRenderableText(block.text)
				.split("\n")
				.map(line => line.trimEnd());
		}
	}
	return [];
}

function extractSummaryLine(result: ToolResultWithError | undefined): string {
	if (!result) return "";
	const lines = extractTextLines(result);
	for (const line of lines) {
		const normalized = line.trim();
		if (normalized.length > 0) return normalized;
	}
	return "";
}

/**
 * Label config for createToolRenderers.
 * - string: static label for both pending and done states.
 * - { pending, done }: different labels per state; done may be a function
 *   that receives the call args so it can vary by action.
 */
export type ToolLabelConfig =
	| string
	| {
			pending: string | ((args: ToolParams) => string);
			done: string | ((args: ToolParams, result?: ToolResultWithError) => string);
	  };

/**
 * Create linked renderCall / renderResult pair with shared state.
 *
 * renderResult feeds result data back into renderCall's options so the
 * call header automatically switches from a pending icon to a
 * success/error icon with a result summary — no mergeCallAndResult needed.
 */
export function createToolRenderers(
	label: ToolLabelConfig,
	formatArgs: (args: ToolParams) => string[],
): {
	renderCall: (args: ToolParams, options: ToolRenderResultOptions, theme: ToolTheme) => ToolRenderComponent;
	renderResult: (
		result: ToolResultWithError,
		options: ToolRenderResultOptions,
		theme: ToolTheme,
		args?: ToolParams,
	) => ToolRenderComponent;
} {
	const state: ToolRenderCallOptions = {};
	return {
		renderCall: (args, options, theme) => {
			const renderState: ToolRenderCallOptions = {
				get isPartial() {
					return options.isPartial;
				},
				get spinnerFrame() {
					return options.spinnerFrame;
				},
				get result() {
					return state.result;
				},
			};
			const resolveLabel =
				typeof label === "string"
					? label
					: () => {
							if (!state.result || options.isPartial) {
								return typeof label.pending === "function" ? label.pending(args) : label.pending;
							}
							return typeof label.done === "function" ? label.done(args, state.result) : label.done;
						};
			return renderToolCall(resolveLabel, () => formatArgs(args), theme, renderState);
		},
		renderResult: (result, options, theme) => {
			state.result = result;
			const resultLabel = typeof label === "string" ? label : label.done;
			return renderToolResult(typeof resultLabel === "function" ? "" : resultLabel, result, options, theme);
		},
	};
}
