/**
 * Per-execution dependency tracker for the reactive query cache.
 *
 * The tracker stamps a dep key for every row a query reads, then surfaces the
 * collected set so the cache can index the result by its inputs. The hooks in
 * `ctx-db.ts` call {@link DependencyTracker.recordRead} on `get` / `findFirst`
 * / `findFirstOrThrow` / `findMany` (one stamp per row) and emit the special
 * `*scan` marker for any read that doesn't go through an index — those entries
 * MUST invalidate on every write to the table because a patch can flip a row
 * from "matches the scan" to "doesn't" without changing the row id set.
 *
 * Why ctx-threaded instead of `AsyncLocalStorage`? Two reasons:
 *
 * 1. `workerd` only enables ALS under the `nodejs_compat` flag, and Lunora
 * shard DOs run under the slimmer `sqlite_compat` profile. Threading the
 * tracker explicitly avoids dragging in `nodejs_compat` just for the
 * reactive-cache wiring.
 *
 * 2. The tracker has one well-defined entry point — `cache.run(...)` calls
 * its callback synchronously after creating the tracker, and reads
 * either happen on the same microtask chain or they do not happen at
 * all (returning the awaited result closes the dep set). Explicit ctx
 * passing makes that lifetime visible at every call-site.
 */

/**
 * Reserved marker for full-table scans — every write to the table invalidates
 * cache entries that depend on this key. Exported as a constant so call-sites
 * can avoid typo-sensitive string literals.
 */
export const SCAN_DEP = "*scan";

/**
 * Build a stable dep key from a table name and a row id (or the {@link SCAN_DEP}
 * sentinel). Encoded as `${table}:${id}` so the cache's invalidation index can
 * key by the same string both sides emit.
 */
export const depKey = (table: string, idOrScan: string): string => `${table}:${idOrScan}`;

/**
 * Inverse of {@link depKey}: recover the table name from a dep key. Table names
 * are SQL identifiers (never contain `:`), so the FIRST colon is always the
 * separator — the id / `*scan` suffix may itself contain colons, so splitting on
 * the LAST colon would truncate a colon-bearing row id into a bogus table name.
 * A key with no colon (defensive) is returned whole.
 */
export const tableFromDepKey = (dep: string): string => {
    const colon = dep.indexOf(":");

    return colon === -1 ? dep : dep.slice(0, colon);
};

export interface DependencyTracker {
    /**
     * Snapshot the dep set collected so far. Returns the live `Set` (no
     * defensive copy) — callers that hand the set to the cache MUST NOT keep
     * mutating it afterwards. The cache stores the returned reference verbatim
     * so it can pass it to its invalidation index later without re-scanning.
     */
    collect: () => Set<string>;

    /**
     * Stamp `(table, id)` as a dependency of the in-flight query. Idempotent:
     * recording the same key twice is a no-op (backed by a `Set`).
     */
    recordRead: (table: string, idOrScan: string) => void;
}

/**
 * Allocate a fresh tracker. The returned object closes over a single `Set`;
 * one tracker per query execution is the intended lifetime.
 */
export const createDependencyTracker = (): DependencyTracker => {
    const deps = new Set<string>();

    return {
        collect() {
            return deps;
        },
        recordRead(table, idOrScan) {
            deps.add(depKey(table, idOrScan));
        },
    };
};
