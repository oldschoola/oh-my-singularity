/**
 * Thin shim over the ANSI-aware text helpers in `@oh-my-pi/pi-natives`.
 *
 * Why this exists:
 * - `@oh-my-pi/pi-natives` ships a TS shim (`src/text/index.ts`) that
 *   supplies default args before the napi-rs binding. The shim's wrapper
 *   takes 4 args for `truncateToWidth`, 2 for `wrapTextWithAnsi`, etc.
 * - `omp`'s `legacy-pi-compat` loader rewrites `@oh-my-pi/...` import
 *   specifiers to point at the *resolved* package on disk. In production,
 *   that resolves to the globally installed `@oh-my-pi/pi-natives@>=15.x`,
 *   whose `package.json` `"main"` is `./native/index.js` — the raw napi-rs
 *   re-exports with no shim.
 * - The raw bindings added a mandatory `tabWidth: number` argument in
 *   the 15.x series. Calling the old (4-arg / 2-arg) signatures yields:
 *     "Failed to convert napi value Undefined into rust type `u32`"
 *
 * This shim re-exports the helpers with `tabWidth` injected, so the rest
 * of the extension can keep using the legacy call shapes regardless of
 * which `pi-natives` major version `omp` resolves to. `tabWidth` matches
 * the upstream `DEFAULT_TAB_WIDTH` constant (3 columns); the values
 * rendered through this path are tool args / status lines that rarely
 * contain literal tabs, so per-user `display.tabWidth` skew is acceptable.
 */

import {
	Ellipsis,
	extractSegments as nativeExtractSegments,
	sliceWithWidth as nativeSliceWithWidth,
	truncateToWidth as nativeTruncateToWidth,
	visibleWidth as nativeVisibleWidth,
	wrapTextWithAnsi as nativeWrapTextWithAnsi,
} from "@oh-my-pi/pi-natives";

export { Ellipsis } from "@oh-my-pi/pi-natives";
export type { ExtractSegmentsResult, SliceWithWidthResult } from "@oh-my-pi/pi-natives";

/** Mirror of `DEFAULT_TAB_WIDTH` in `@oh-my-pi/pi-utils` (3 columns). */
const TAB_WIDTH = 3;

/**
 * Detect whether the resolved `pi-natives` binding requires the post-15.x
 * `tabWidth` trailing argument. Probed once at module load; we feed it a
 * harmless `truncateToWidth("", 0, Ellipsis.Unicode, false)` call and watch
 * for the napi `u32`-conversion failure. Modules predating 15.x will
 * succeed without the extra arg, and we skip injecting it.
 */
const requiresTabWidth = (() => {
	try {
		// biome-ignore lint/suspicious/noExplicitAny: probing variadic native arity.
		(nativeTruncateToWidth as any)("", 0, Ellipsis.Unicode, false);
		return false;
	} catch {
		return true;
	}
})();

export function truncateToWidth(
	text: string,
	maxWidth: number,
	ellipsisKind: Ellipsis = Ellipsis.Unicode,
	pad = false,
): string {
	return requiresTabWidth
		? // biome-ignore lint/suspicious/noExplicitAny: variadic native signature.
			(nativeTruncateToWidth as any)(text, maxWidth, ellipsisKind, pad, TAB_WIDTH)
		: nativeTruncateToWidth(text, maxWidth, ellipsisKind, pad);
}

export function wrapTextWithAnsi(text: string, width: number): string[] {
	return requiresTabWidth
		? // biome-ignore lint/suspicious/noExplicitAny: variadic native signature.
			(nativeWrapTextWithAnsi as any)(text, width, TAB_WIDTH)
		: nativeWrapTextWithAnsi(text, width);
}

export function visibleWidth(text: string): number {
	return requiresTabWidth
		? // biome-ignore lint/suspicious/noExplicitAny: variadic native signature.
			(nativeVisibleWidth as any)(text, TAB_WIDTH)
		: nativeVisibleWidth(text);
}

export function sliceWithWidth(line: string, startCol: number, length: number, strict = false) {
	return requiresTabWidth
		? // biome-ignore lint/suspicious/noExplicitAny: variadic native signature.
			(nativeSliceWithWidth as any)(line, startCol, length, strict, TAB_WIDTH)
		: nativeSliceWithWidth(line, startCol, length, strict);
}

export function extractSegments(
	line: string,
	beforeEnd: number,
	afterStart: number,
	afterLen: number,
	strictAfter: boolean,
) {
	return requiresTabWidth
		? // biome-ignore lint/suspicious/noExplicitAny: variadic native signature.
			(nativeExtractSegments as any)(line, beforeEnd, afterStart, afterLen, strictAfter, TAB_WIDTH)
		: nativeExtractSegments(line, beforeEnd, afterStart, afterLen, strictAfter);
}
