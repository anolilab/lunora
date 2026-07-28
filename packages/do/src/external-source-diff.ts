/**
 * Pure full-pull membership diff for external-source ingest (plan 077).
 *
 * A sourced table's poll loop reads the full tenant membership from Hyperdrive,
 * then must bring the DO's local SQLite to match. This helper turns the freshly
 * pulled membership + the current local baseline (`id → canonical-value JSON`)
 * into the ordered `CdcChange[]` that `applyCdcChanges` replays through the
 * validated writer, plus the next baseline the following tick diffs from: a new
 * key → `insert`, a changed projected value → `update`, a vanished key →
 * `delete`. Seeding is the same call with an empty baseline (every row an insert).
 *
 * **Canonical comparison.** The diff serializes with {@link stableStringify}
 * (key-sorted, `undefined`-skipping) and projects via {@link projectExternalSourceRow},
 * which drops `_creationTime`. That is essential, not cosmetic: the freshly-pulled
 * source rows never carry `_creationTime` (the writer assigns it on insert) and a
 * locally-stored row's keys come back in arbitrary order — so a naive
 * `JSON.stringify` would report every row "changed" on every steady-state tick. The
 * baseline a caller supplies MUST be built with the same canonicalization (see
 * `readExternalSourceBaseline`), so the two sides compare equal when the row is
 * unchanged.
 *
 * The `applyCdcChanges` replay reads only `op`/`id`/`table`/`doc`, so `seq`/`ts` are
 * stamped 0 here — the real `__cdc_log` entry (with a monotonic cursor) is appended
 * by the writer when the change is applied, which is also what makes the
 * materialized rows live-pokeable to `defineShape` subscribers.
 *
 * Pure and transport-agnostic on purpose: the same diff serves the Hyperdrive poll
 * loop today and a future DO-consumes-DO shape consumer (plan 077 §8.6) — only the
 * "pulled" source changes, never this diff.
 *
 * Caller contract: each pulled row is the *mapped* document and MUST carry `_id`.
 */

import type { CdcChange } from "@lunora/shard-engine";
import { stableStringify } from "@lunora/shard-engine";

/** The result of {@link diffExternalSource}: the changes to replay, and the baseline the next tick diffs from. */
interface ExternalSourceDiffResult {
    /** Ordered for `applyCdcChanges`: upserts in pulled order, then deletes in baseline order. */
    changes: CdcChange[];
    /** `id → canonical-value JSON` — pass back as the `baseline` next tick (or persist for an incremental cursor). */
    nextBaseline: Map<string, string>;
}

/**
 * Project a row to the document the ingest loop stores + compares on: `_id` plus
 * either the `columns` allow-list or every field except the framework-assigned
 * `_creationTime` (which the source never supplies). Returned as a plain object;
 * key order is irrelevant because {@link stableStringify} sorts keys. Used for BOTH
 * the pulled side here and the local baseline, so the two are byte-identical for an
 * unchanged row.
 */
const projectExternalSourceRow = (row: Record<string, unknown>, columns: ReadonlyArray<string> | undefined): Record<string, unknown> => {
    const projected: Record<string, unknown> = { _id: row._id };

    if (columns) {
        for (const key of columns) {
            if (Object.hasOwn(row, key)) {
                projected[key] = row[key];
            }
        }

        return projected;
    }

    for (const [key, value] of Object.entries(row)) {
        if (key !== "_id" && key !== "_creationTime") {
            projected[key] = value;
        }
    }

    return projected;
};

/**
 * Diff a sourced table's freshly-pulled membership against the local baseline.
 * Returns the `CdcChange[]` to apply (in stable order: upserts in pulled order,
 * then deletes in baseline order) and the next baseline (`id → canonical JSON`).
 */
const diffExternalSource = (
    pulled: ReadonlyArray<Record<string, unknown>>,
    baseline: ReadonlyMap<string, string>,
    options: { columns?: ReadonlyArray<string>; table: string },
): ExternalSourceDiffResult => {
    const { columns, table } = options;
    const changes: CdcChange[] = [];
    const nextBaseline = new Map<string, string>();

    for (const source of pulled) {
        const value = projectExternalSourceRow(source, columns);
        const id = String(value._id);
        const json = stableStringify(value);

        nextBaseline.set(id, json);

        const before = baseline.get(id);

        if (before === undefined) {
            changes.push({ doc: value, id, op: "insert", seq: 0, table, ts: 0 });
        } else if (before !== json) {
            changes.push({ doc: value, id, op: "update", seq: 0, table, ts: 0 });
        }
    }

    for (const id of baseline.keys()) {
        if (!nextBaseline.has(id)) {
            changes.push({ id, op: "delete", seq: 0, table, ts: 0 });
        }
    }

    return { changes, nextBaseline };
};

export { diffExternalSource, projectExternalSourceRow };
export type { ExternalSourceDiffResult };
