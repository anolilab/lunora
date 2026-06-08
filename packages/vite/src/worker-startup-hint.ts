import type { Plugin } from "vite";

/**
 * When a module under `cirrus/` throws while the Worker entry is first
 * evaluated, `@cloudflare/vite-plugin` surfaces the failure from deep inside
 * its `runner-worker` running in `workerd`. The real error crosses a workerd
 * RPC boundary on the way out, which drops the user-code stack frames — so all
 * the dev server sees is a bare, file-less message like:
 *
 *     TypeError: Cannot read properties of undefined (reading 'string')
 *         at runInRunnerObject (workers/runner-worker/index.js:107:3)
 *         at getWorkerEntryExportTypes (workers/runner-worker/index.js:246:24)
 *
 * The classic cause is a **circular import**: a `cirrus/` query/mutation/action
 * module runs `mutation({ args: { x: v.string() } })` at the top level while the
 * module it imported `v`/`query`/`mutation` from is still mid-initialization, so
 * those bindings read as `undefined`. The message names a validator method
 * (`'string'`, `'id'`, …) but never the file.
 *
 * We can't recover the dropped frames at this layer, but we can recognise the
 * shape of the failure and append an actionable hint pointing at the likely
 * cause — turning a dead-end stack into something a user can act on.
 */
export const WORKER_STARTUP_HINT: string = [
    "",
    "  ┌─ Cirrus ──────────────────────────────────────────────────────────────",
    "  │ Your Worker entry threw while loading, so the dev server couldn't read",
    "  │ its exports. The TypeError above comes from inside the Cloudflare",
    "  │ runtime and hides the file that actually failed. It is almost always:",
    "  │",
    "  │   • A circular import in cirrus/. A query/mutation/action module ran at",
    "  │     the top level before `v`/`query`/`mutation` finished initializing,",
    "  │     so they were `undefined` (hence `reading 'string'`/`'id'`/…).",
    "  │     → Import `v`/`query`/`mutation` only from `cirrus/_generated/server`,",
    "  │       and don't import one cirrus/ function module from another at the",
    "  │       top level.",
    "  │",
    "  │   • Stale or missing generated files.",
    "  │     → Re-run `cirrus codegen`, then restart the dev server.",
    "  │",
    "  │ Tip: check the cirrus/ files you edited most recently — the throw is at",
    "  │ their module top level.",
    "  └───────────────────────────────────────────────────────────────────────",
].join("\n");

/**
 * True when `error` looks like a Worker-entry evaluation failure routed through
 * `@cloudflare/vite-plugin`'s runner worker (the stack references the runner
 * worker / export-types probe). Kept narrow so we only annotate this specific
 * class of dev-startup error.
 */
export const isWorkerEntryEvalError = (error: unknown): boolean => {
    if (!(error instanceof Error)) {
        return false;
    }

    const haystack = `${error.stack ?? ""}\n${error.message}`;

    return /runner-worker[/\\]index\.js/u.test(haystack) || /getWorkerEntryExportTypes/u.test(haystack);
};

/** Sentinel so we never append the hint twice if the error is rethrown through several wrapped hooks. */
const HINTED = Symbol.for("cirrus.workerStartupHintApplied");

/**
 * Append {@link WORKER_STARTUP_HINT} to a recognised Worker-entry eval error
 * (idempotently). Any other value is returned untouched.
 */
export const augmentWorkerStartupError = (error: unknown): unknown => {
    if (!isWorkerEntryEvalError(error)) {
        return error;
    }

    const flagged = error as Error & { [HINTED]?: boolean };

    if (flagged[HINTED]) {
        return error;
    }

    flagged[HINTED] = true;
    flagged.message = `${flagged.message}\n${WORKER_STARTUP_HINT}`;

    // Vite's CLI prints startup failures with `util.inspect(error)`, which renders
    // the *stack* (captured at throw time) rather than the live `message`. Append
    // the hint there too so it is actually shown.
    if (typeof flagged.stack === "string") {
        flagged.stack = `${flagged.stack}\n${WORKER_STARTUP_HINT}`;
    }

    return error;
};

type HookFunction = (...arguments_: never[]) => unknown;

/** A Vite hook is either a bare function or an object with a `handler`. Wrap whichever shape it is. */
const wrapHook = (hook: unknown): unknown => {
    if (typeof hook === "function") {
        const original = hook as HookFunction;

        return async (...arguments_: never[]): Promise<unknown> => {
            try {
                return await original(...arguments_);
            } catch (error) {
                throw augmentWorkerStartupError(error);
            }
        };
    }

    if (hook !== null && typeof hook === "object" && "handler" in hook && typeof (hook as { handler: unknown }).handler === "function") {
        return { ...hook, handler: wrapHook((hook as { handler: unknown }).handler) };
    }

    return hook;
};

/** Startup hooks that can throw the Worker-entry eval error before the server is listening. */
const WRAPPED_HOOKS = ["configureServer", "buildStart"] as const;

/**
 * Wrap the startup hooks of `@cloudflare/vite-plugin`'s plugins so a Worker-entry
 * evaluation failure carries the Cirrus hint. Returns a new array; the input
 * plugins are shallow-cloned (never mutated in place) so re-using the cloudflare
 * plugin instances elsewhere stays safe.
 */
export const withWorkerStartupHint = (plugins: ReadonlyArray<Plugin>): Plugin[] =>
    plugins.map((plugin) => {
        let next = plugin;

        for (const hookName of WRAPPED_HOOKS) {
            const hook = (plugin as unknown as Record<string, unknown>)[hookName];

            if (hook !== undefined) {
                next = { ...next, [hookName]: wrapHook(hook) };
            }
        }

        return next;
    });
