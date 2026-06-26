/**
 * Builds the Lunora-flavored context handed to a `defineQueue` push handler.
 * Node-safe (no `cloudflare:workers` import) so the dispatcher and context
 * assembly are unit-testable. Mirrors `@lunora/workflow`'s run context: to touch
 * data, a handler calls a Lunora function via `ctx.run` — the dispatch POSTs to
 * the same `/_lunora/scheduler/dispatch` endpoint the SchedulerDO and workflows
 * use, authenticated with the admin bearer.
 *
 * NOTE — deliberate parallel of `@lunora/workflow/src/run-context.ts`'s
 * `createWorkflowRunner`. The runner is near-identical (only the package label in
 * error/log strings differs), but the two packages are intentionally
 * **independent installs with no shared `@lunora/*` dependency** (the framework's
 * decoupling convention — `FunctionReference` is hand-redeclared per package on
 * purpose, not shared). Consolidating the runner + the
 * `FunctionReference`/`ArgsOf`/`RunFunctionOptions` triple into one module is a
 * worthwhile follow-up, but it's a cross-cutting refactor of shipped packages
 * (`@lunora/workflow`, `@lunora/scheduler`) that belongs in its own change, not
 * bolted onto this feature. If you change the dispatch contract here (origin/
 * bearer/body or the `fetch.bind` receiver workaround), update the workflow twin.
 */
import type { ArgsOf, FunctionReference, QueueLogger, QueueRunContext, QueueRunFunction, RunFunctionOptions } from "./types";

/** Strip trailing slashes from an origin so the dispatch path joins cleanly. */
const trimTrailingSlashes = (value: string): string => {
    let end = value.length;

    while (end > 0 && value[end - 1] === "/") {
        end -= 1;
    }

    return value.slice(0, end);
};

interface RunnerOptions {
    /** Worker `env` — read `LUNORA_ORIGIN_URL` + `LUNORA_ADMIN_TOKEN` at call time. */
    env: Record<string, unknown>;
    /** Injectable fetch (tests); defaults to the global. */
    fetchImpl?: typeof fetch;
}

/**
 * Build a {@link QueueRunFunction} that invokes a Lunora function by POSTing to
 * the Worker's `/_lunora/scheduler/dispatch` endpoint, authenticated with the
 * admin bearer. The parsed JSON body (the function's return value) is resolved;
 * an empty/non-JSON body resolves to `undefined`.
 */
const createQueueRunner = (options: RunnerOptions): QueueRunFunction => {
    const globalFetch = (globalThis as { fetch?: typeof fetch }).fetch;
    // Bind the global `fetch` to `globalThis` so calling it through a captured
    // reference cannot trip "Illegal invocation" in receiver-strict runtimes.
    const fetchImpl = options.fetchImpl ?? (typeof globalFetch === "function" ? globalFetch.bind(globalThis) : undefined);

    return async <F extends FunctionReference>(function_: F, args?: ArgsOf<F>, runOptions: RunFunctionOptions = {}): Promise<unknown> => {
        if (typeof fetchImpl !== "function") {
            throw new TypeError("@lunora/queue: no fetch implementation available — pass fetchImpl or run on a platform with global fetch");
        }

        const origin = options.env.LUNORA_ORIGIN_URL;

        if (typeof origin !== "string" || origin.length === 0) {
            throw new Error("@lunora/queue: `LUNORA_ORIGIN_URL` must be set on the Worker env so a queue handler can call back into Lunora functions");
        }

        const token = options.env.LUNORA_ADMIN_TOKEN;

        if (typeof token !== "string" || token.length === 0) {
            throw new Error("@lunora/queue: `LUNORA_ADMIN_TOKEN` must be set on the Worker env to authenticate queue function dispatch");
        }

        const url = `${trimTrailingSlashes(origin)}/_lunora/scheduler/dispatch`;
        const response = await fetchImpl(url, {
            body: JSON.stringify({ args: args ?? {}, functionPath: function_.__lunoraRef, shardKey: runOptions.shardKey }),
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            method: "POST",
        });

        if (!response.ok) {
            throw new Error(`@lunora/queue: function dispatch failed (${String(response.status)}): ${await response.text()}`);
        }

        const text = await response.text();

        if (text.length === 0) {
            return undefined;
        }

        try {
            return JSON.parse(text);
        } catch {
            return text;
        }
    };
};

/** Console-backed logger, prefixed with the queue name for log correlation. */
const createQueueLogger = (exportName: string): QueueLogger => {
    const prefix = `[queue:${exportName}]`;

    /* eslint-disable no-console -- this logger's whole job is to write to the console; the runtime routes it to wrangler tail / Studio. */
    return {
        debug: (message, ...rest) => {
            console.debug(prefix, message, ...rest);
        },
        error: (message, ...rest) => {
            console.error(prefix, message, ...rest);
        },
        info: (message, ...rest) => {
            console.info(prefix, message, ...rest);
        },
        warn: (message, ...rest) => {
            console.warn(prefix, message, ...rest);
        },
    };
    /* eslint-enable no-console */
};

interface RunContextOptions {
    env: Record<string, unknown>;
    exportName: string;
    fetchImpl?: typeof fetch;
}

/** Assemble the {@link QueueRunContext} passed to a `defineQueue` handler. */
const createQueueRunContext = (options: RunContextOptions): QueueRunContext => {
    return {
        env: options.env,
        log: createQueueLogger(options.exportName),
        run: createQueueRunner({ env: options.env, fetchImpl: options.fetchImpl }),
    };
};

export { createQueueLogger, createQueueRunContext, createQueueRunner };
