/**
 * One procedure (query / mutation / action) discovered in the cirrus source,
 * reduced to the facts the `rls_uncovered_table` lint needs: whether the
 * procedure's builder chain includes `.use(rls(...))`, and which tables the
 * procedure reads or writes. Produced by the codegen feeder; runtime callers
 * don't supply it, so the lint finds nothing there.
 */
export interface AdvisorRlsProcedure {
    /** The exported binding name of the procedure (e.g. `listDocuments`). */
    exportName: string;
    /** Source file relative to the cirrus dir, no extension. */
    file: string;
    /** Tables read by the procedure via `ctx.db.query("table")` / `ctx.db.findMany(...)` etc. */
    tablesRead: ReadonlyArray<string>;
    /** Tables written by the procedure via `ctx.db.insert("table", …)` / `ctx.db.patch(...)` etc. */
    tablesWritten: ReadonlyArray<string>;
    /**
     * Tables explicitly named in the `rls(policies)` array passed to `.use(rls(...))`
     * in this procedure's builder chain. Empty when the policies argument is not a
     * statically-readable array literal (conservative: `usesRls` is still `true`).
     */
    rlsTables: ReadonlyArray<string>;
    /**
     * `true` when the procedure's builder chain includes `.use(rls(...))` — the
     * `rls` callee is identified by name from `@cirrus/server`. `false` when no
     * `.use(rls(...))` is found in the chain (or the procedure uses the bare
     * `query({...})` factory form, which never carries a builder chain at all).
     */
    usesRls: boolean;
    /** `"internal"` when the procedure uses `internalQuery` / `internalMutation` / `internalAction`. */
    visibility: "internal" | "public";
}
