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

import type { DatabaseWriterLike, SqlExec } from "./ctx-db";
import { applyCdcChanges } from "./ctx-db-cdc";
import { selectShapeRows } from "./ctx-db-shapes";
import { diffExternalSource, projectExternalSourceRow } from "./external-source-diff";
import { stableStringify } from "./reactive-cache";

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

/**
 * Read the materialized table's current membership as the canonical full-pull
 * baseline (`id → canonical JSON`). Reuses the shape scanner (`selectShapeRows`)
 * and the SAME {@link projectExternalSourceRow} + {@link stableStringify} the diff
 * uses, so a stored row (with `_creationTime` + arbitrary key order) compares
 * byte-identical to its freshly-pulled source counterpart — an unchanged row
 * produces no spurious update.
 */
const readExternalSourceBaseline = (sql: SqlExec, table: string, columns?: ReadonlyArray<string>): Map<string, string> => {
    const baseline = new Map<string, string>();

    for (const { doc, id } of selectShapeRows(sql, table, undefined)) {
        baseline.set(id, stableStringify(projectExternalSourceRow({ ...doc, _id: id }, columns)));
    }

    return baseline;
};

/**
 * Run one full-pull materialize tick: read the table's current membership as the
 * baseline, diff the freshly-pulled rows against it, and apply the delta. This is
 * the system-driven loop body the DO poll alarm calls — the table IS the baseline
 * (design §1 Fact A), so no separate snapshot is kept. Pass both the read handle
 * (`sql`) and the validated `writer` (the DO has both); they must address the same
 * table.
 */
const runExternalSourceTick = async (
    sql: SqlExec,
    writer: DatabaseWriterLike,
    pulled: ReadonlyArray<Record<string, unknown>>,
    options: { columns?: ReadonlyArray<string>; table: string },
): Promise<MaterializeResult> => {
    const baseline = readExternalSourceBaseline(sql, options.table, options.columns);

    return materializeExternalRows(writer, pulled, baseline, options);
};

export { materializeExternalRows, readExternalSourceBaseline, runExternalSourceTick };
export type { MaterializeResult };
