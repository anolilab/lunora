/**
 * Node/CLI-edge rendering for Lunora errors. This is the **only** entry that
 * pulls `@visulima/error`'s `renderError` (which reads source files for code
 * frames and is Node-only), so it lives on the `@lunora/errors/render` subpath —
 * never imported by the browser client or the workerd runtime. The main
 * `@lunora/errors` entry stays free of this subgraph.
 *
 * `renderLunoraError` turns any thrown value into a single terminal block: the
 * failure line plus, when the error carries (or its message matches) an
 * actionable hint, that hint rendered underneath. It generalizes the former
 * `packages/cli/src/util/codegen-error.ts` renderer so every CLI surface shares
 * one hint presentation.
 */
import { renderError, VisulimaError } from "@visulima/error";

import type { ErrorHint } from "../catalog";
import { resolveHint } from "../catalog";
import { isLunoraError } from "../guards";

/** `renderError` options that suppress the (usually uninformative) internal stack. */
const NO_STACK = { filterStacktrace: () => false, hideErrorCodeView: true } as const;

/**
 * Flatten a Markdown hint into plain terminal lines: drop code-fence markers and
 * strip inline `**bold**` / `` `code` `` emphasis. `renderError` lays the lines
 * out and colors them for the terminal; here we only flatten what it can't render.
 */
const flattenHint = (hint: ErrorHint): string[] => {
    const text = Array.isArray(hint) ? hint.join("\n") : hint;

    return text
        .split("\n")
        .filter((line) => !line.startsWith("```"))
        .join("\n")
        .replaceAll(/\*\*(.+?)\*\*/gu, "$1")
        .replaceAll(/`([^`]+)`/gu, "$1")
        .split("\n");
};

export interface RenderLunoraErrorOptions {
    /** Tag the failure with its trigger (e.g. `startup`, `change: schema.ts`). */
    reason?: string;
}

/**
 * Render a thrown value as a terminal block (message + actionable hint). The
 * internal stack is suppressed — the message and the fix are what help.
 */
export const renderLunoraError = (error: unknown, options: RenderLunoraErrorOptions = {}): string => {
    const message = error instanceof Error ? error.message : String(error);
    const hint = resolveHint(isLunoraError(error) ? { code: error.code, hint: error.hint, message } : message);

    const rendered = new VisulimaError({
        hint: hint === undefined ? undefined : flattenHint(hint),
        message: options.reason === undefined ? message : `${options.reason}: ${message}`,
        name: error instanceof Error && error.name.length > 0 ? error.name : "Error",
    });

    rendered.stack = "";

    return renderError(rendered, NO_STACK);
};

export { renderError, VisulimaError } from "@visulima/error";
