import { FG, RESET_FG } from "../colors";

/**
 * Minimal, dependency-free ANSI syntax highlighter for code blocks rendered inside
 * the TUI. The goal is *visual differentiation*, not full lexical correctness: we
 * recognise strings, comments, numbers, and a per-language keyword table, then
 * fall back to bright body text (`FG.text`) for everything else.
 *
 * Languages currently covered: ts/tsx/js/jsx, json, yaml, md/markdown, bash/sh,
 * python/py, cs/csharp, rs/rust. Unknown languages render in `FG.text`.
 */

const KEYWORDS: Record<string, ReadonlySet<string>> = {
	ts: new Set([
		"abstract",
		"as",
		"async",
		"await",
		"break",
		"case",
		"catch",
		"class",
		"const",
		"continue",
		"declare",
		"default",
		"delete",
		"do",
		"else",
		"enum",
		"export",
		"extends",
		"false",
		"finally",
		"for",
		"from",
		"function",
		"get",
		"if",
		"implements",
		"import",
		"in",
		"instanceof",
		"interface",
		"is",
		"keyof",
		"let",
		"namespace",
		"new",
		"null",
		"of",
		"private",
		"protected",
		"public",
		"readonly",
		"return",
		"set",
		"static",
		"super",
		"switch",
		"this",
		"throw",
		"true",
		"try",
		"type",
		"typeof",
		"undefined",
		"var",
		"void",
		"while",
		"yield",
	]),
	js: new Set([
		"async",
		"await",
		"break",
		"case",
		"catch",
		"class",
		"const",
		"continue",
		"default",
		"delete",
		"do",
		"else",
		"export",
		"extends",
		"false",
		"finally",
		"for",
		"from",
		"function",
		"if",
		"import",
		"in",
		"instanceof",
		"let",
		"new",
		"null",
		"of",
		"return",
		"static",
		"super",
		"switch",
		"this",
		"throw",
		"true",
		"try",
		"typeof",
		"undefined",
		"var",
		"void",
		"while",
		"yield",
	]),
	py: new Set([
		"and",
		"as",
		"assert",
		"async",
		"await",
		"break",
		"class",
		"continue",
		"def",
		"del",
		"elif",
		"else",
		"except",
		"False",
		"finally",
		"for",
		"from",
		"global",
		"if",
		"import",
		"in",
		"is",
		"lambda",
		"None",
		"nonlocal",
		"not",
		"or",
		"pass",
		"raise",
		"return",
		"True",
		"try",
		"while",
		"with",
		"yield",
	]),
	cs: new Set([
		"abstract",
		"as",
		"async",
		"await",
		"base",
		"bool",
		"break",
		"byte",
		"case",
		"catch",
		"char",
		"checked",
		"class",
		"const",
		"continue",
		"decimal",
		"default",
		"delegate",
		"do",
		"double",
		"else",
		"enum",
		"event",
		"explicit",
		"extern",
		"false",
		"finally",
		"fixed",
		"float",
		"for",
		"foreach",
		"goto",
		"if",
		"implicit",
		"in",
		"int",
		"interface",
		"internal",
		"is",
		"lock",
		"long",
		"namespace",
		"new",
		"null",
		"object",
		"operator",
		"out",
		"override",
		"params",
		"private",
		"protected",
		"public",
		"readonly",
		"ref",
		"return",
		"sbyte",
		"sealed",
		"short",
		"sizeof",
		"stackalloc",
		"static",
		"string",
		"struct",
		"switch",
		"this",
		"throw",
		"true",
		"try",
		"typeof",
		"uint",
		"ulong",
		"unchecked",
		"unsafe",
		"ushort",
		"using",
		"var",
		"virtual",
		"void",
		"volatile",
		"while",
		"yield",
	]),
	rs: new Set([
		"as",
		"async",
		"await",
		"break",
		"const",
		"continue",
		"crate",
		"dyn",
		"else",
		"enum",
		"extern",
		"false",
		"fn",
		"for",
		"if",
		"impl",
		"in",
		"let",
		"loop",
		"match",
		"mod",
		"move",
		"mut",
		"pub",
		"ref",
		"return",
		"self",
		"Self",
		"static",
		"struct",
		"super",
		"trait",
		"true",
		"type",
		"union",
		"unsafe",
		"use",
		"where",
		"while",
		"yield",
	]),
	sh: new Set([
		"if",
		"then",
		"else",
		"elif",
		"fi",
		"case",
		"esac",
		"for",
		"while",
		"until",
		"do",
		"done",
		"in",
		"function",
		"return",
		"break",
		"continue",
		"exit",
		"export",
		"local",
		"readonly",
		"set",
		"unset",
		"echo",
		"printf",
	]),
};

const SHEBANGS_TO_LANG: Record<string, string> = {
	typescript: "ts",
	tsx: "ts",
	javascript: "js",
	jsx: "js",
	json: "json",
	yaml: "yaml",
	yml: "yaml",
	md: "md",
	markdown: "md",
	bash: "sh",
	shell: "sh",
	zsh: "sh",
	sh: "sh",
	python: "py",
	py: "py",
	csharp: "cs",
	cs: "cs",
	rust: "rs",
	rs: "rs",
};

function normalizeLang(lang: string | null | undefined): string {
	const cleaned = (lang ?? "").trim().toLowerCase();
	if (!cleaned) return "";
	return SHEBANGS_TO_LANG[cleaned] ?? cleaned;
}

/**
 * Highlight a single line of code in the given language. Returns the line with
 * embedded ANSI color codes; visible width matches the input (sans ANSI).
 *
 * The implementation is intentionally small: one regex pass emits tokens by
 * priority (comment → string → number → keyword → identifier → other) and
 * inserts the appropriate color before each token, resetting after.
 */
export function highlightLine(line: string, lang: string): string {
	if (!line) return line;
	const normalized = normalizeLang(lang);

	// Markdown: leave content as text; markdown is mostly prose.
	if (normalized === "md") return wrapPlain(line);
	if (normalized === "json") return highlightJsonLine(line);
	if (normalized === "yaml") return highlightYamlLine(line);

	const keywords = KEYWORDS[normalized];
	if (!keywords) return wrapPlain(line);

	return highlightGenericLine(line, keywords, normalized);
}

function wrapPlain(line: string): string {
	return `${FG.text}${line}${RESET_FG}`;
}

const STRING_RE = /"([^"\\]|\\.)*"|'([^'\\]|\\.)*'|`([^`\\]|\\.)*`/y;
const LINE_COMMENT_RE_BY_LANG: Record<string, RegExp> = {
	ts: /\/\/[^\n]*/y,
	js: /\/\/[^\n]*/y,
	cs: /\/\/[^\n]*/y,
	rs: /\/\/[^\n]*/y,
	py: /#[^\n]*/y,
	sh: /#[^\n]*/y,
};
const NUMBER_RE = /(?:0[xX][0-9a-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|\d+(?:_\d+)*(?:\.\d+(?:_\d+)*)?(?:[eE][+-]?\d+)?)/y;
const IDENT_RE = /[A-Za-z_$][A-Za-z0-9_$]*/y;

function highlightGenericLine(line: string, keywords: ReadonlySet<string>, lang: string): string {
	const commentRe = LINE_COMMENT_RE_BY_LANG[lang];
	const parts: string[] = [];
	let i = 0;
	const N = line.length;

	while (i < N) {
		const ch = line[i]!;

		if (commentRe) {
			commentRe.lastIndex = i;
			const m = commentRe.exec(line);
			if (m && m.index === i) {
				parts.push(`${FG.muted}${m[0]}${RESET_FG}`);
				i += m[0].length;
				continue;
			}
		}

		if (ch === '"' || ch === "'" || ch === "`") {
			STRING_RE.lastIndex = i;
			const m = STRING_RE.exec(line);
			if (m && m.index === i) {
				parts.push(`${FG.accent}${m[0]}${RESET_FG}`);
				i += m[0].length;
				continue;
			}
			// Unterminated string — color the rest of the line as a string.
			parts.push(`${FG.accent}${line.slice(i)}${RESET_FG}`);
			i = N;
			continue;
		}

		if (ch >= "0" && ch <= "9") {
			NUMBER_RE.lastIndex = i;
			const m = NUMBER_RE.exec(line);
			if (m && m.index === i) {
				parts.push(`${FG.warning}${m[0]}${RESET_FG}`);
				i += m[0].length;
				continue;
			}
		}

		if (isIdentStart(ch)) {
			IDENT_RE.lastIndex = i;
			const m = IDENT_RE.exec(line);
			if (m && m.index === i) {
				const word = m[0];
				if (keywords.has(word)) {
					parts.push(`${FG.success}${word}${RESET_FG}`);
				} else {
					parts.push(`${FG.text}${word}${RESET_FG}`);
				}
				i += word.length;
				continue;
			}
		}

		// Single non-identifier character: emit as text to keep contrast bright.
		parts.push(`${FG.text}${ch}${RESET_FG}`);
		i += 1;
	}

	return parts.join("");
}

function isIdentStart(ch: string): boolean {
	const code = ch.charCodeAt(0);
	return (
		(code >= 0x41 && code <= 0x5a) || // A-Z
		(code >= 0x61 && code <= 0x7a) || // a-z
		code === 0x5f || // _
		code === 0x24 // $
	);
}

function highlightJsonLine(line: string): string {
	const parts: string[] = [];
	let i = 0;
	const N = line.length;
	while (i < N) {
		const ch = line[i]!;
		if (ch === '"') {
			STRING_RE.lastIndex = i;
			const m = STRING_RE.exec(line);
			if (m && m.index === i) {
				// Distinguish keys (followed by ':') from values.
				let j = i + m[0].length;
				while (j < N && line[j] === " ") j += 1;
				const isKey = line[j] === ":";
				parts.push(`${isKey ? FG.accent : FG.warning}${m[0]}${RESET_FG}`);
				i += m[0].length;
				continue;
			}
		}
		if ((ch >= "0" && ch <= "9") || ch === "-") {
			NUMBER_RE.lastIndex = ch === "-" ? i + 1 : i;
			const m = NUMBER_RE.exec(line);
			if (m && m.index === (ch === "-" ? i + 1 : i)) {
				const span = (ch === "-" ? "-" : "") + m[0];
				parts.push(`${FG.warning}${span}${RESET_FG}`);
				i += span.length;
				continue;
			}
		}
		if (line.startsWith("true", i) || line.startsWith("null", i)) {
			const word = line.startsWith("true", i) ? "true" : "null";
			parts.push(`${FG.success}${word}${RESET_FG}`);
			i += word.length;
			continue;
		}
		if (line.startsWith("false", i)) {
			parts.push(`${FG.success}false${RESET_FG}`);
			i += 5;
			continue;
		}
		parts.push(`${FG.text}${ch}${RESET_FG}`);
		i += 1;
	}
	return parts.join("");
}

function highlightYamlLine(line: string): string {
	// Match leading whitespace, optional list dash, optional key followed by colon.
	const m = line.match(/^(\s*)(-\s+)?([^\s][^:]*?)(\s*:\s*)(.*)$/);
	if (m) {
		const [, indent, dash, key, colon, rest] = m;
		return (
			(indent ?? "") +
			(dash ? `${FG.muted}${dash}${RESET_FG}` : "") +
			`${FG.accent}${key}${RESET_FG}` +
			`${FG.muted}${colon}${RESET_FG}` +
			(rest ? `${FG.text}${rest}${RESET_FG}` : "")
		);
	}
	// Comment line.
	const c = line.match(/^(\s*)(#.*)$/);
	if (c) {
		return `${c[1] ?? ""}${FG.muted}${c[2]}${RESET_FG}`;
	}
	return wrapPlain(line);
}
