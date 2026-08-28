/**
 * Doubles shared by the REST edge-cache tests (`rest-edge-cache.test.ts`, which
 * tests the module directly, and `rest-routes.test.ts`, which tests it wired
 * through `createWorker`). Not a `*.test.ts`, so vitest's `__tests__/*.test.ts`
 * include pattern does not collect it.
 */
import type { HttpCacheLike } from "@lunora/platform";

import type { ExecutionContextLike } from "../../../../shared/execution-context";

/** An in-memory `HttpCacheLike` keyed by the cache-key request's URL, plus the raw entry map for assertions. */
const fakeCache = (): { cache: HttpCacheLike; entries: Map<string, Response> } => {
    const entries = new Map<string, Response>();
    const cache: HttpCacheLike = {
        delete: async (request) => entries.delete(typeof request === "string" ? request : request.url),
        match: async (request) => {
            const stored = entries.get(typeof request === "string" ? request : request.url);

            return stored?.clone();
        },
        put: async (request, response) => {
            entries.set(typeof request === "string" ? request : request.url, response);
        },
    };

    return { cache, entries };
};

/** A context whose `waitUntil` collects promises, so a test can await the deferred `put`. */
const contextWith = (overrides: Partial<ExecutionContextLike> = {}): { context: ExecutionContextLike; settled: () => Promise<void> } => {
    const pending: Promise<unknown>[] = [];

    return {
        context: { waitUntil: (promise: Promise<unknown>) => pending.push(promise), ...overrides },
        settled: async () => {
            await Promise.all(pending);
        },
    };
};

export { contextWith, fakeCache };
