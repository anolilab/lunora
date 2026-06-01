/**
 * Thrown by mutation handlers when an optimistic-concurrency check fails.
 *
 * The runtime maps this to a 409 response so clients can decide whether to
 * refetch + retry or surface the conflict. `code` / `status` are declared as
 * own properties (not just inherited prototype state) so structural callers
 * across packages — which deliberately avoid taking a hard runtime dependency
 * on `@cirrus/do` — can recognise the shape without an `instanceof` check.
 */
export class ConflictError extends Error {
    public readonly code: string = "CONFLICT";

    public readonly status: number = 409;

    public constructor(message: string = "Optimistic concurrency conflict") {
        super(message);
        this.name = "ConflictError";
    }
}

/**
 * Thrown by `findFirstOrThrow` when no document matches the query.
 *
 * Like {@link ConflictError}, `code` / `status` are declared as own properties
 * so the cross-package structural error mapper maps it to a 404 without an
 * `instanceof` check against `@cirrus/do`.
 */
export class NotFoundError extends Error {
    public readonly code: string = "NOT_FOUND";

    public readonly status: number = 404;

    public constructor(message: string = "Document not found") {
        super(message);
        this.name = "NotFoundError";
    }
}

/**
 * Minimal projection of the SQLite handle that the transaction helper needs.
 * `state.storage.sql` in the Workers runtime exposes a query runner for
 * BEGIN / COMMIT / ROLLBACK; declared structurally so unit tests can pass a
 * stub without depending on the workers runtime.
 */
export interface TransactionSqlLike {
    exec: (query: string) => unknown;
}
