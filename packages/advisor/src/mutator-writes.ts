/**
 * One whole-row `ctx.db.replace(id, document)` write discovered inside a custom
 * mutator's authoritative `server` impl (`lunora/mutators.ts`) — the input the
 * `mutator_full_row_replace` lint consumes.
 *
 * In the local-first sync engine a `replace` overwrites the entire row, so a
 * concurrent edit to a *different* column (committed between this mutator's read
 * and its write) is silently clobbered. `patch(id, { onlyTheField })` merges at
 * the column level instead, letting independent field edits coexist — the
 * blessed pattern for mutators on a synced (poke-live) table. Produced by the
 * codegen feeder, which attributes each `replace` to the mutator export
 * performing it; runtime callers don't supply it, so the lint finds nothing
 * there.
 */
export interface AdvisorMutatorWrite {
    /** The mutator export whose `server` impl performs the replace (e.g. `renameChannel`). */
    exportName: string;
    /** Openable source path the replace appears in — always `lunora/mutators.ts`. */
    file: string;
    /** 1-based line of the `replace(...)` call, or `0` when unknown. */
    line: number;
}
