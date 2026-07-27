/**
 * **Prototype.** better-auth over a Durable Object's own SQLite, rather than D1.
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
 * ## Status and the trade it makes
 *
 * This is a prototype, not a recommended default. It puts `user` / `session` (and the
 * SCIM tables) inside **one** Durable Object, which changes the shape of the system:
 * writes serialise through a single object rather than spreading across D1, the object
 * holds them in its own SQLite, and backup/export follows the DO path instead of D1's.
 * That is a deliberate architectural choice, not a drop-in swap — measure it before
 * moving an existing deployment.
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
