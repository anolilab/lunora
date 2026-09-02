/**
 * The op-log shape diff: metadata scan first, documents last.
 *
 * Host-neutral by construction — it reads through `SqlExec` and nothing else, so
 * it lives here rather than on the Durable Object class that used to own it.
 * That placement was not cosmetic: on the DO the whole pipeline was three methods
 * that touched no instance state (each carrying a lint suppression saying so),
 * the per-flush cache's internals had to become cross-package public API for
 * them to reach it, and benchmarking a pure function needed a subclass and a
 * double cast through `unknown`.
 */

import type { SqlExec } from "./ctx-db";
import type { CdcChangeKey } from "./ctx-db-cdc";
import { readCdcChangeKeys } from "./ctx-db-cdc";
import { selectShapeMembers } from "./ctx-db-shapes";
import type { ShapeDiffCache } from "./shape-diff-cache";
import { shapeRangeKey } from "./shape-diff-cache";
import type { ShapeRowOp } from "./shape-global-diff";
import { projectColumns } from "./shape-global-diff";
import type { ResolvedShape } from "./types";

/** How a shape diff reads changed keys — injectable so a host can wrap the single changelog read (and a test can count it). */

/**
 * The changed-key read {@link buildShapeDiff} runs, injectable so a host can
 * route it through its own seam. Exported for the two in-repo callers and
 * deliberately NOT re-exported from the package barrel: it is a parameter type,
 * not a surface anyone outside builds against.
 */
type ReadShapeCdcKeys = (sql: SqlExec, table: string, sinceSeq: number, upTo: number) => CdcChangeKey[];

/**
 * Build the row-ops for a shape over the op range `(sinceSeq, upTo]` — the
 * two-stage pipeline: a metadata scan of the changed keys
 * ({@link readCdcChangeKeys}), then ONE membership probe
 * ({@link selectShapeMembers}) that both filters those keys by the shape's
 * predicate and returns the surviving documents to ship.
 *
 * A key the probe returned is a member, so its current document is upserted
 * (projected to the shape's columns). A key it did not return is either a row
 * that left the set or a row that is gone: emit `delete(key)` — except for a key
 * whose op is `insert`, which {@link readCdcChangeKeys} reports only for a key
 * whose insert was its SOLE op in the range. Such a key was created and never
 * matched the predicate, so it was never replicated to anyone, and emitting a
 * delete for it would spam every subscriber on the table with a no-op key. (A
 * key that was deleted and re-inserted in one range comes back as `update`
 * precisely so it does not land in that exemption — it HAD been replicated.)
 *
 * **The `value` shipped is the row's CURRENT one, not its post-image at `seq`.**
 * That is a real change from the drain this replaced, which read values out of
 * the op-log. A poke stamped with checkpoint `upTo` can therefore carry a value
 * written after `upTo`. It converges — the later write pokes again — and it is
 * the more useful answer (one read, one source of truth for membership and
 * value), but it is a different invariant, and a caller reasoning about "the
 * state at cursor N" should know it holds for the KEY SET and not the values.
 *
 * Both reads go through the caller's per-flush `cache`, keyed by the op range
 * and the resolved predicate rather than by the socket asking — so N subscribers
 * of one shape cost one scan and one probe, not N of each.
 */
const buildShapeDiff = (
    sql: SqlExec,
    resolved: ResolvedShape,
    sinceSeq: number,
    upTo: number,
    cache: ShapeDiffCache,
    readKeys: ReadShapeCdcKeys = readCdcChangeKeys,
): ShapeRowOp[] => {
    const rangeKey = shapeRangeKey(resolved.table, sinceSeq, upTo);
    const changed = cache.changedKeys(rangeKey, () => readKeys(sql, resolved.table, sinceSeq, upTo));

    if (changed.length === 0) {
        return [];
    }

    const members = cache.members(resolved, rangeKey, () =>
        selectShapeMembers(
            sql,
            resolved.table,
            resolved.effectiveWhere,
            changed.map((change) => change.id),
        ),
    );

    const ops: ShapeRowOp[] = [];

    for (const change of changed) {
        const memberDocument = members.get(change.id);

        if (memberDocument === undefined) {
            // Not a member now. An `insert` — which `readCdcChangeKeys` reports
            // only when it was the key's sole op in the range — never matched the
            // predicate and was never replicated to anyone, so emit nothing. An
            // `update` that left the set, or a `delete`, DOES need a delete: we
            // conservatively tell the client to drop the key (a no-op if it never
            // held it).
            if (change.op !== "insert") {
                ops.push({ key: change.id, op: "delete", table: resolved.table });
            }

            continue;
        }

        // Still a member ⇒ the row exists and this is the value the predicate
        // admits. `op` rides along as the client-facing kind; a `delete` op can
        // never be in the live membership set, so it can never reach here with a
        // document.
        ops.push({ key: change.id, op: change.op, table: resolved.table, value: projectColumns(memberDocument, resolved.columns) });
    }

    return ops;
};

export type { ReadShapeCdcKeys };
export { buildShapeDiff };
