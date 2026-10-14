/**
 * A replication shape declared via `defineShape({ table, where, columns? })` in
 * `lunora/shapes.ts` (the local-first sync engine's partial-replication unit).
 * The `shape_*` lints cross-reference each shape's {@link AdvisorShape.table}
 * against the declared schema to flag a shape targeting an unknown table or a
 * `.global()` table (which replicates through the latency-tiered D1 poll path,
 * not the poke-live op-log). Supplied by the codegen feeder, which lifts only
 * the export name + the static `table` literal; absent for runtime callers,
 * where the shape lints find nothing.
 */
export interface AdvisorShape {
    /** Export binding name — the shape's registry key (e.g. `channelMessages`). */
    exportName: string;
    /** File the shape is declared in (relative, for the operator to open). */
    file: string;

    /**
     * The `table` string literal the shape replicates from, or `undefined` when
     * the feeder could not read it as a plain string literal — tier-sensitive
     * lints skip a shape with no resolvable table rather than guessing.
     */
    table?: string;
}
