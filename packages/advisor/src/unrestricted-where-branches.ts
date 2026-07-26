/**
 * One branching `defineShape({ where })` / `definePolicy({ when })` predicate arm
 * that returns an unrestricted predicate — the `unrestricted_where_branch` lint
 * input.
 *
 * A row predicate returns a *filter*, not a boolean, so the denial arm has to be a
 * predicate matching **no** rows: `deny()` / `{ OR: [] }`, a disjunction over zero
 * branches. The plausible-looking `{}` is its exact opposite — it matches every row,
 * so an arm meaning "this caller sees nothing" silently replicates or exposes the
 * whole table, with no error and no log line.
 *
 * Only reported for a *branching* predicate: a single-exit `where: () => ({})` is an
 * author deliberately replicating everything, which is legitimate. Produced by the
 * codegen feeder; runtime callers don't supply it, so the lint finds nothing there.
 * Structurally identical to `UnrestrictedWhereBranchIR`.
 */
export interface AdvisorUnrestrictedWhereBranch {
    /** The exported binding name of the shape / policy the predicate belongs to. */
    exportName: string;
    /** Source file relative to the lunora dir, no extension. */
    file: string;
    /** Which unrestricted form was returned. */
    form: "empty-object" | "undefined";
    /** The config key carrying the predicate (`where` for a shape, `when` for a policy). */
    key: string;
    /** 1-based line of the offending returned expression. */
    line: number;
    /** The declaring call (`defineShape` / `definePolicy`). */
    owner: string;
}
