/**
 * Pure full-pull membership diff for external-source ingest (plan 077).
 *
 * A sourced table's poll loop reads the full tenant membership from Hyperdrive,
 * then must bring the DO's local SQLite to match. This helper turns the freshly
 * pulled membership + the current local baseline (`id → projected-value JSON`)
 * into the ordered `CdcChange[]` that `applyCdcChanges` replays through the
 * validated writer, plus the next baseline the following tick diffs from: a new
 * key → `insert`, a changed projected value → `update`, a vanished key →
 * `delete`. Seeding is the same call with an empty baseline (every row an insert).
 *
 * It is the writer-side mirror of `diffGlobalMembership` (which emits client
 * poke-ops) and reuses the same {@link projectColumns} so the two never drift. The
 * `applyCdcChanges` replay reads only `op`/`id`/`table`/`doc`, so `seq`/`ts` are
 * stamped 0 here — the real `__cdc_log` entry (with a monotonic cursor) is appended
 * by the writer when the change is applied, which is also what makes the
 * materialized rows live-pokeable to `defineShape` subscribers.
 *
 * Pure and transport-agnostic on purpose: the same diff serves the Hyperdrive poll
 * loop today and a future DO-consumes-DO shape consumer (plan 077 §8.6) — only the
 * "pulled" source changes, never this diff.
 *
 * Caller contract: each pulled row is the *mapped* document and MUST carry `_id`
 * (the external primary key projected onto Lunora's id). `_creationTime` handling
 * on the update path lives in `applyCdcChange`, not here.
 */

import type { CdcChange } from "./ctx-db-cdc";
import { projectColumns } from "./shape-global-diff";

/** The result of {@link diffExternalSource}: the changes to replay, and the baseline the next tick diffs from. */
interface ExternalSourceDiffResult {
    /** Ordered for `applyCdcChanges`: upserts in pulled order, then deletes in baseline order. */
    changes: CdcChange[];
    /** `id → projected-value JSON` — pass back as the `baseline` next tick (or persist for an incremental cursor). */
    nextBaseline: Map<string, string>;
}

/**
 * Diff a sourced table's freshly-pulled membership against the local baseline.
 * Returns the `CdcChange[]` to apply (in stable order: upserts in pulled order,
 * then deletes in baseline order) and the next baseline (`id → projected JSON`).
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
        const value = projectColumns(source, columns);
        const id = String(value._id);
        const json = JSON.stringify(value);

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

export { diffExternalSource };
export type { ExternalSourceDiffResult };
