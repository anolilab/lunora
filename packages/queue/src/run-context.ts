/**
 * Builds the Lunora-flavored context handed to a `defineQueue` push handler.
 * Node-safe (no `cloudflare:workers` import) so the dispatcher and context
 * assembly are unit-testable. To touch data, a handler calls a Lunora function
 * via `ctx.run` — the dispatch is the shared `@lunora/dispatch` runner (the same
 * one `@lunora/workflow` uses), POSTing to `/_lunora/scheduler/dispatch` with the
 * admin bearer.
 */
import { createDispatchLogger, createDispatchRunner } from "@lunora/dispatch";

import type { QueueRunContext } from "./types";

interface RunContextOptions {
    env: Record<string, unknown>;
    exportName: string;
    fetchImpl?: typeof fetch;
}

/** Assemble the {@link QueueRunContext} passed to a `defineQueue` handler. */
const createQueueRunContext = (options: RunContextOptions): QueueRunContext => {
    return {
        env: options.env,
        log: createDispatchLogger(`[queue:${options.exportName}]`),
        run: createDispatchRunner({ env: options.env, fetchImpl: options.fetchImpl, label: "@lunora/queue" }),
    };
};

// eslint-disable-next-line import/prefer-default-export -- named export by package convention; index.ts re-exports it
export { createQueueRunContext };
