/**
 * Shared terminal rendering for codegen failures across the CLI's three
 * surfaces — the `lunora dev` watch loop, `lunora prepare`, and `lunora verify`.
 * Each matches the thrown error's message against `@lunora/codegen`'s shared
 * solution table and renders the actionable fix through `@visulima/error` (the
 * same renderer cerebro uses for thrown CLI errors), so the terminal fix and
 * the Vite overlay's solution panel stay in lockstep.
 */
import type { LunoraSolution } from "@lunora/codegen";
import { findLunoraSolution } from "@lunora/codegen";
import { renderError, VisulimaError } from "@visulima/error";

/**
 * Flatten a Lunora solution's Markdown body into plain terminal text: drop
 * code-fence markers and strip inline `**bold**` / `` `code` `` emphasis. The
 * Markdown is authored for the Vite overlay's browser renderer; `renderError`
 * lays the text out and colors it for the terminal, so here we only flatten the
 * content it can't render.
 */
const flattenSolutionBody = (solution: LunoraSolution): string =>
    solution.body
        .split("\n")
        .filter((line) => !line.startsWith("```"))
        .join("\n")
        .replaceAll(/\*\*(.+?)\*\*/gu, "$1")
        .replaceAll(/`([^`]+)`/gu, "$1");

/** Shared `renderError` options that suppress the (uninformative) codegen stack. */
const NO_STACK = { filterStacktrace: () => false, hideErrorCodeView: true } as const;

/**
 * Render a failed codegen run as a single block: the failure line plus, when the
 * message is recognized, the matched Lunora fix as the error's `hint`. Used where
 * the failure is the only thing being reported (the `lunora dev` watch loop and
 * `lunora prepare`). `reason` tags the failure with its trigger (e.g. `startup`,
 * `change: schema.ts`); omit it when there is no distinct trigger. The internal
 * stack is suppressed — the message and the fix are what help.
 */
const renderCodegenFailure = (error: unknown, reason?: string): string => {
    const message = error instanceof Error ? error.message : String(error);
    const solution = findLunoraSolution(message);

    const rendered = new VisulimaError({
        hint: solution ? [solution.header, "", flattenSolutionBody(solution)] : undefined,
        message: reason === undefined ? `codegen failed: ${message}` : `codegen failed (${reason}): ${message}`,
        name: "CodegenError",
    });

    rendered.stack = "";

    return renderError(rendered, NO_STACK);
};

/**
 * Render *only* the matched Lunora fix for a codegen-error message, or
 * `undefined` when the message isn't recognized. Used where the failure itself
 * is already reported separately (e.g. `lunora verify`, which collects the error
 * string for its `--format json` output) and only the fix needs surfacing.
 */
const renderCodegenHint = (message: string): string | undefined => {
    const solution = findLunoraSolution(message);

    if (solution === undefined) {
        return undefined;
    }

    const rendered = new VisulimaError({
        hint: [flattenSolutionBody(solution)],
        message: solution.header,
        name: "Hint",
    });

    rendered.stack = "";

    return renderError(rendered, NO_STACK);
};

export { renderCodegenFailure, renderCodegenHint };
