/**
 * One `query`/`mutation` handler that gates a `ctx.db.get`/`patch`/`delete` on a
 * null-checked `ctx.db.normalizeId(table, id)` result — the shared input for the
 * `normalize_id_used_as_authorization` lint. `normalizeId` validates an id's
 * structural shape only (it never reads the database), so a non-null result proves
 * the id is well-formed, never that the caller owns the row; gating access on it is
 * an IDOR. The lint keeps only public procedures with no `.use(rls(...))` and no
 * ownership/identity mention (`mentionsOwnership`), then joins `table` against the
 * schema's RLS mode before flagging. Produced by the codegen feeder; runtime callers
 * don't supply it, so the lint finds nothing there. Structurally identical to
 * `@lunora/codegen`'s `NormalizeIdAuthorizationIR`.
 */
export interface AdvisorNormalizeIdAuthorization {
    /** The exported binding name of the procedure performing the normalize-then-access. */
    exportName: string;
    /** Source file relative to the lunora dir, no extension. */
    file: string;
    /** 1-based line of the `ctx.db.normalizeId(...)` call the access is gated on. */
    line: number;
    /** `true` when the handler anywhere reads an ownership-named identifier or `ctx.auth`/`ctx.identity`/… — an intervening ownership signal. */
    mentionsOwnership: boolean;
    /** The id-first `ctx.db` sink the normalized id reaches. */
    sinkMethod: "delete" | "get" | "patch";
    /** Table named in the `normalizeId` call, or `""` when its table argument wasn't a string literal. */
    table: string;
    /** `true` when the procedure's builder chain carries a `.use(rls(...))` step. */
    usesRls: boolean;
    /** `"internal"` for `internalQuery`/`internalMutation`; `"public"` for `query`/`mutation`. */
    visibility: "internal" | "public";
}
