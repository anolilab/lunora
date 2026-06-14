/**
 * One procedure (query / mutation / action) discovered in the cirrus source,
 * reduced to the facts the `mask_uncovered_pii_column` lint needs: whether the
 * procedure's builder chain includes `.use(mask(...))`, which `(table, column)`
 * pairs that mask declares, and which tables the procedure reads or writes.
 * Produced by the codegen feeder; runtime callers don't supply it, so the lint
 * finds nothing there. The column-level twin of `AdvisorRlsProcedure`.
 */
export interface AdvisorMaskProcedure {
    /** The exported binding name of the procedure (e.g. `listUsers`). */
    exportName: string;
    /** Source file relative to the cirrus dir, no extension. */
    file: string;

    /**
     * The `(table, column)` pairs declared by the `mask(policies)` object passed
     * to `.use(mask(...))` in this procedure's builder chain. Empty when the
     * policies argument is not a statically-readable object literal
     * (conservative: `usesMask` is still `true`).
     */
    maskColumns: ReadonlyArray<{ column: string; table: string }>;
    /** Tables read by the procedure via `ctx.db.query("table")` / `ctx.db.findMany(...)` etc. */
    tablesRead: ReadonlyArray<string>;
    /** Tables written by the procedure via `ctx.db.insert("table", …)` / `ctx.db.patch(...)` etc. */
    tablesWritten: ReadonlyArray<string>;

    /**
     * `true` when the procedure's builder chain includes `.use(mask(...))` — the
     * `mask` callee is identified by name from `@cirrus/server`. `false` when no
     * `.use(mask(...))` is found in the chain (or the procedure uses the bare
     * `query({...})` factory form, which never carries a builder chain at all).
     */
    usesMask: boolean;
    /** `"internal"` when the procedure uses `internalQuery` / `internalMutation` / `internalAction`. */
    visibility: "internal" | "public";
}
