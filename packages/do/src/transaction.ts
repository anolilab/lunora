/**
 * Why a {@link ConflictError} fired. `occ` is the true write-contention signal —
 * a compare-and-swap that touched zero rows because a concurrent write committed
 * during the mutation. `unique` (a UNIQUE-index breach), `restrict` (an
 * `onDelete: "restrict"` block), and `trigger` (trigger-recursion overflow) also
 * surface as 409s but are constraint/guard failures, not contention. The metrics
 * layer counts only `occ` as a write conflict so the contention advisor isn't
 * tripped by a legitimately-duplicate insert.
 */
export type ConflictKind = "conflict" | "occ" | "restrict" | "trigger" | "unique";

/**
 * Thrown by mutation handlers when an optimistic-concurrency check fails (or a
 * related write guard trips — see {@link ConflictKind}).
 *
 * The runtime maps this to a 409 response so clients can decide whether to
 * refetch + retry or surface the conflict. `code` / `status` / `kind` are
 * declared as own properties (not just inherited prototype state) so structural
 * callers across packages — which deliberately avoid taking a hard runtime
 * dependency on `@cirrus/do` — can recognise the shape without an `instanceof`
 * check.
 */
export class ConflictError extends Error {
    public readonly code: string = "CONFLICT";

    /** Why the conflict fired; `occ` is the contention signal the metrics layer counts. */
    public readonly kind: ConflictKind;

    public readonly status: number = 409;

    public constructor(message: string = "Optimistic concurrency conflict", kind: ConflictKind = "conflict") {
        super(message);
        this.name = "ConflictError";
        this.kind = kind;
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
