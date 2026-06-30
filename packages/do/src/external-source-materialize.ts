/**
 * Materialize a sourced table's freshly-pulled membership into the DO's SQLite
 * (plan 077). The thin composition the Phase 1 manual bridge and the Phase 2 poll
 * loop both call: diff the pulled rows against the local baseline, then replay the
 * resulting `CdcChange[]` through the validated writer.
 *
 * `applyCdcChanges` is the single legitimate ingress for external data (design
 * §1, Fact B): it routes every upsert/delete through `DatabaseWriterLike` — so the
 * materialized rows get index/companion maintenance and a `__cdc_log` append (which
 * is what makes them live-pokeable to `defineShape` subscribers), and no
 * deterministic query/mutation handler ever touches raw external rows.
 *
 * The caller owns the baseline read: for full-pull mode it is the table's current
 * membership (the table IS the baseline, design §1 Fact A); the returned
 * `nextBaseline` is what the following tick diffs against. The apply runs inside the
 * caller's storage transaction so a partial failure leaves the prior state and the
 * next tick retries (design §3.4).
 */

import type { DatabaseWriterLike } from "./ctx-db";
import { applyCdcChanges } from "./ctx-db-cdc";
import { diffExternalSource } from "./external-source-diff";

/** The outcome of one materialize pass: how many changes were applied, and the baseline the next tick diffs from. */
interface MaterializeResult {
    /** Number of `CdcChange`s applied (inserts + updates + deletes). Zero on a steady-state tick. */
    applied: number;
    /** `id → projected-value JSON` — the post-tick membership, to feed back as `baseline` next tick. */
    nextBaseline: Map<string, string>;
}

/**
 * Diff `pulled` against `baseline` and apply the delta to `writer`. Returns the
 * applied count and the next baseline. A steady-state tick (membership unchanged)
 * applies nothing and returns `applied: 0`.
 */
const materializeExternalRows = async (
    writer: DatabaseWriterLike,
    pulled: ReadonlyArray<Record<string, unknown>>,
    baseline: ReadonlyMap<string, string>,
    options: { columns?: ReadonlyArray<string>; table: string },
): Promise<MaterializeResult> => {
    const { changes, nextBaseline } = diffExternalSource(pulled, baseline, options);

    await applyCdcChanges(writer, changes);

    return { applied: changes.length, nextBaseline };
};

export { materializeExternalRows };
export type { MaterializeResult };
