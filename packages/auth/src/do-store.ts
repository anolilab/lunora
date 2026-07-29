/**
 * better-auth over a Durable Object's own SQLite, rather than D1.
 *
 * ## Why this exists
 *
 * `@better-auth/scim` refuses to serve unless the adapter exposes native
 * transactions, and D1 has none: its driver rejects interactive transactions
 * outright, and `batch()` can't stand in because SCIM reads-then-conditionally-writes
 * (its decommission lease). So SCIM on D1 is not a wiring problem — it is a platform
 * limit, and the documented answer is Postgres/MySQL through `@lunora/hyperdrive`.
 *
 * A Durable Object's storage *does* have real transactions:
 * `state.storage.transaction(closure)` is async, atomic, rolled back automatically
 * when the closure throws, and isolated from concurrent dispatch — the same primitive
 * `ShardDO.runInTransaction` already relies on. Backing better-auth with DO storage
 * therefore satisfies SCIM without leaving Cloudflare's first-party stack.
 *
 * ## Status
 *
 * `@experimental`; D1 remains the recommended default. Experimental here is about the
 * signature, not the primitive: the transaction path is covered by a workerd suite over
 * the real `state.storage.transaction`, but `api-snapshots/auth.api.md` records the export
 * as untracked, so its shape can churn without failing the gate that backs this package's
 * stability guarantee.
 *
 * What makes it a deliberate choice rather than a drop-in swap:
 *
 * **Topology.** `user` / `session` and the SCIM tables live inside **one** object, so writes
 * serialise through it, its storage limits apply, and backup/export follows the DO path
 * rather than D1's.
 *
 * **No `ensureMigrated`.** better-auth's migrator is kysely-only, so the object materialises
 * its own schema (see `authDoSchemaStatements`).
 *
 * **No sharding.** There is one auth object.
 *
 * **`authAdmin` degrades.** The studio's auth admin pages read the auth tables from the
 * worker, which DO storage does not permit, so they report "not configured" rather than
 * returning data. The audit feed still works — the worker reads it back over an internal
 * route.
 *
 * Measure it before moving an existing deployment. Full picture: `docs/index.mdx`.
 *
 * ```ts
 * // Inside a Durable Object (`this.state` / `this.ctx`), with the constructor's
 * // second argument kept as `this.env`:
 * const auth = createAuth({
 *     secret: this.env.AUTH_SECRET,
 *     database: lunoraDoAdapter(this.state.storage),
 *     plugins: [scim({ connections: [...] })],
 * });
 * ```
 * @experimental
 */
import type { SqlExecutor } from "./sql-store";

/**
 * The slice of `DurableObjectStorage` this module uses.
 *
 * Structural on purpose: it keeps `@lunora/auth` free of a `@lunora/do` dependency
 * and lets tests supply a double whose `transaction` has the same semantics.
 */
export interface DoStorageLike {
    /** Synchronous SQL over the object's SQLite. */
    sql: {
        exec: (query: string, ...bindings: unknown[]) => Iterable<Record<string, unknown>>;
    };

    /**
     * The platform's async transaction primitive. Everything the closure executes
     * against `sql` joins the transaction — it is connection-scoped, so no handle is
     * threaded through — and a throw rolls the whole thing back.
     */
    transaction: <R>(closure: () => Promise<R>) => Promise<R>;
}

/**
 * A {@link SqlExecutor} over a Durable Object's SQLite.
 *
 * `storage.sql.exec` is synchronous and returns a cursor, so both methods resolve
 * immediately; the async signature exists to satisfy the shared executor seam that
 * D1 (genuinely async) also implements.
 * @experimental
 */
export const doExecutor = (storage: DoStorageLike): SqlExecutor => {
    return {
        all: (query, parameters) => Promise.resolve([...storage.sql.exec(query, ...parameters)]),
        run: (query, parameters) => {
            // The cursor is lazy in workerd: iterating is what actually runs the
            // statement, so a write that is never read would silently not happen.
            [...storage.sql.exec(query, ...parameters)];

            return Promise.resolve();
        },
    };
};

/**
 * Run `closure` inside the object's transaction.
 *
 * Handed to `lunoraAuthAdapter` as its transaction runner; it is what makes
 * `@better-auth/scim` accept the adapter at all.
 * @experimental
 */
export const doTransactionRunner =
    (storage: DoStorageLike) =>
    async <R>(closure: () => Promise<R>): Promise<R> =>
        storage.transaction(closure);
