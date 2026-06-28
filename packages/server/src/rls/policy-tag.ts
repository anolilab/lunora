/**
 * Tag the `rls()` middleware with the policy + role lists it carries so the
 * procedure builder can surface them on the registered function (`fn.rls`)
 * without re-running the chain.
 *
 * The local-first replication path reads these to AND-compose a `defineShape`
 * predicate with the table's RLS read base-where (see `shape-read-base.ts`): a
 * shape never runs a procedure, so its membership reads would otherwise bypass
 * RLS entirely. Tagging the middleware (rather than introducing a separate
 * project-wide policy registry) keeps the policies' live `when` closures
 * reachable through the same `LUNORA_FUNCTIONS` import codegen already emits.
 *
 * The tag is a non-enumerable, well-known-keyed property so it never leaks into
 * a spread/serialization of the middleware and two independently-bundled copies
 * of `@lunora/server` still agree on the key (`Symbol.for`).
 */

import type { Policy, Role } from "./types";

const RLS_TAG = Symbol.for("lunora.rls.middleware-policies");

/** Policies + roles a single `.use(rls(...))` step carries. */
interface RlsTag {
    readonly policies: ReadonlyArray<Policy>;
    readonly roles: ReadonlyArray<Role>;
}

/** Attach an {@link RlsTag} to a middleware function. Returns the same reference. */
const tagRlsMiddleware = <M extends object>(middleware: M, tag: RlsTag): M => {
    Object.defineProperty(middleware, RLS_TAG, { configurable: true, enumerable: false, value: tag });

    return middleware;
};

/** Read the {@link RlsTag} a middleware carries, or `undefined` for a non-RLS middleware. */
const readRlsTag = (middleware: unknown): RlsTag | undefined => {
    if (middleware === null || (typeof middleware !== "function" && typeof middleware !== "object")) {
        return undefined;
    }

    return (middleware as Record<PropertyKey, unknown>)[RLS_TAG] as RlsTag | undefined;
};

export type { RlsTag };
export { readRlsTag, tagRlsMiddleware };
