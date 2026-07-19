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

import type { CdcChange, DatabaseWriterLike, SqlExec } from "./ctx-db";
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

/** The outcome of one incremental materialize pass. No baseline: incremental applies only the pulled slice, never a full-membership diff. */
interface IncrementalMaterializeResult {
    /** Number of `CdcChange`s applied (upserts + tombstone deletes) for the pulled slice. */
    applied: number;
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
 * Apply an **incremental** slice (plan 136): the freshly-pulled rows changed since
 * the watermark, upsert-only. Unlike {@link materializeExternalRows} this reads no
 * baseline and never diffs the full membership — an absent row means "unchanged
 * since the watermark", NOT "deleted". Each pulled row is projected with the SAME
 * {@link projectExternalSourceRow} full-pull uses, so an incrementally-upserted row
 * is byte-identical to how the next reconcile sweep's full-pull would store it (no
 * spurious update on reconcile).
 *
 * Delete visibility comes from `deletedIds` — the ids the caller resolved from the
 * source's soft-delete tombstone column. Every other pulled row is an `insert`,
 * which {@link applyCdcChanges} upserts (insert, or replace on conflict), so a
 * changed existing row is updated and a genuinely new row is inserted without the
 * caller tracking which is which.
 *
 * **Content short-circuit.** An incremental cursor query uses `>= watermark` (so
 * rows sharing the boundary value are never skipped), which means a steady-state
 * tick re-pulls the boundary row(s) unchanged. Blindly upserting them would append
 * a `__cdc_log` entry, broadcast a spurious `update` to every `defineShape`
 * subscriber, re-run search/aggregate/rank sync, and fire `onWrite` (a Vectorize
 * re-embed = real cost) on every tick — and `replace` would reset `_creationTime`.
 * So each row is diffed against its stored projection (the SAME
 * {@link projectExternalSourceRow} + {@link stableStringify} full-pull uses) and
 * skipped when byte-identical — mirroring the full-pull diff's steady-state no-op.
 */
const materializeExternalRowsIncremental = async (
    writer: DatabaseWriterLike,
    pulled: ReadonlyArray<Record<string, unknown>>,
    options: { columns?: ReadonlyArray<string>; deletedIds?: ReadonlySet<string>; table: string },
): Promise<IncrementalMaterializeResult> => {
    const { columns, deletedIds, table } = options;
    const changes: CdcChange[] = [];

    for (const source of pulled) {
        const value = projectExternalSourceRow(source, columns);
        const id = String(value._id);

        if (deletedIds?.has(id)) {
            // eslint-disable-next-line no-await-in-loop -- one point read per pulled row; the slice is small and the read gates the delete/CDC append below.
            const existing = await writer.get(id, table);

            // Skip a re-pulled boundary tombstone whose row is already absent
            // locally (mirrors the upsert path's byte-identical short-circuit
            // below) — otherwise a steady-state re-pull of the same tombstoned
            // boundary row re-emits a delete (and its CDC/broadcast) every tick.
            if (existing) {
                changes.push({ id, op: "delete", seq: 0, table, ts: 0 });
            }

            continue;
        }

        // eslint-disable-next-line no-await-in-loop -- one point read per pulled row; the slice is small and the read gates the far more expensive upsert/broadcast below.
        const stored = await writer.get(id, table);

        // Skip a re-pulled boundary row whose stored content is byte-identical (no
        // change since the watermark) — avoids the spurious broadcast/CDC/re-embed.
        if (stored && stableStringify(projectExternalSourceRow({ ...stored, _id: id }, columns)) === stableStringify(value)) {
            continue;
        }

        changes.push({ doc: value, id, op: "insert", seq: 0, table, ts: 0 });
    }

    await applyCdcChanges(writer, changes);

    return { applied: changes.length };
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

export { materializeExternalRows, materializeExternalRowsIncremental, readExternalSourceBaseline, runExternalSourceTick };
export type { IncrementalMaterializeResult, MaterializeResult };
