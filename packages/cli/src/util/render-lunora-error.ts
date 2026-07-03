/**
 * Node/CLI-edge rendering for Lunora errors.
 *
 * `@lunora/errors` deliberately stays free of `@visulima/error`'s Node-only
 * `renderError` (so its class/catalog entry tree-shakes cleanly into browser and
 * workerd bundles). The terminal renderer therefore lives here, in the CLI, which
 * already depends on `@visulima/error`. `renderLunoraError` turns any thrown value
 * into a single terminal block — the failure line plus, when the error carries (or
 * its message matches) an actionable hint, that hint rendered underneath.
 */
import { flattenHint, isLunoraError, resolveHint } from "@lunora/errors";
import { renderError, VisulimaError } from "@visulima/error";

/** `renderError` options that suppress the (usually uninformative) internal stack. */
const NO_STACK = { filterStacktrace: () => false, hideErrorCodeView: true } as const;

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
        // `renderError` iterates `hint` as lines; the shared flattener returns one
        // string, so split it back to lines for the terminal renderer.
        hint: hint === undefined ? undefined : flattenHint(hint).split("\n"),
        message: options.reason === undefined ? message : `${options.reason}: ${message}`,
        name: error instanceof Error && error.name.length > 0 ? error.name : "Error",
    });

    rendered.stack = "";

    return renderError(rendered, NO_STACK);
};
