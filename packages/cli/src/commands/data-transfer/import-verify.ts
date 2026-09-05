/**
 * What `--verify` checks after an import: that every source row is accounted
 * for, and that every storage reference resolved.
 */
import type { Logger } from "../../util/logger";
import { IMPORT_CONVEX_MAPPING_FILE } from "./storage-mapping";
import type { StorageRemapReport, UnresolvedStorageReference } from "./storage-remap";

/** How many unresolved storage references to name individually before summarising. */
const UNRESOLVED_REPORT_LIMIT = 20;

/**
 * Compare what the reader emitted against what the endpoint says it wrote,
 * returning the number of failed checks.
 *
 * A row that conflicts is a row that is already there, which is exactly what a
 * re-run produces — and re-running is the documented way to resume an
 * interrupted migration. Counting only inserts would fail `--verify` on every
 * second run. The endpoint reports conflicts as a run total rather than per
 * table, so per-table parity is only exact when there are none; otherwise the
 * run-level total is the honest check.
 */
const checkRowParity = (logger: Logger, sourceRows: ReadonlyMap<string, number>, totals: { conflicts: number; inserted: Record<string, number> }): number => {
    let mismatches = 0;

    if (totals.conflicts === 0) {
        for (const [table, sourceCount] of sourceRows) {
            const insertedCount = totals.inserted[table] ?? 0;

            if (insertedCount < sourceCount) {
                mismatches += 1;
                logger.error(
                    `verify: ${table} inserted ${String(insertedCount)} of ${String(sourceCount)} source rows (${String(sourceCount - insertedCount)} missing)`,
                );
            }
        }
    } else {
        const sourceTotal = [...sourceRows.values()].reduce((a, b) => a + b, 0);
        const accountedFor = Object.values(totals.inserted).reduce((a, b) => a + b, 0) + totals.conflicts;

        if (accountedFor < sourceTotal) {
            mismatches += 1;
            logger.error(
                `verify: ${String(accountedFor)} of ${String(sourceTotal)} source rows accounted for across all tables (${String(sourceTotal - accountedFor)} missing; ${String(totals.conflicts)} already present)`,
            );
        }
    }

    if (mismatches > 0) {
        logger.error(`verify: ${String(mismatches)} row-parity check(s) failed`);
    } else {
        logger.success("verify: all source rows accounted for");
    }

    return mismatches;
};

/**
 * List unresolved storage references, capped so a wholly-unmigrated import does
 * not bury its own summary under one line per document.
 *
 * No dedup here any more: the report itself now holds one entry per DISTINCT
 * `(table, column, storageId)` (see `import-rows.ts`). Deduping only for display
 * is what made the counts printed beside this list disagree with it.
 */
const listUnresolved = (
    logger: Logger,
    references: ReadonlyArray<UnresolvedStorageReference>,
    describe: (reference: UnresolvedStorageReference) => string,
): void => {
    for (const reference of references.slice(0, UNRESOLVED_REPORT_LIMIT)) {
        logger.warn(describe(reference));
    }

    if (references.length > UNRESOLVED_REPORT_LIMIT) {
        logger.warn(`… and ${String(references.length - UNRESOLVED_REPORT_LIMIT)} more`);
    }
};

/**
 * Report what the storage rewrite could not resolve, returning whether the run
 * should fail.
 *
 * `unmigrated` is broken data — the blob does not exist, and no mapping can
 * conjure it — so under `--verify` it fails. `ambiguous` is a string that matches
 * a blob that *did* migrate, sitting in a column the mapping does not name: it
 * may be a forgotten reference, or user text that happens to equal an id.
 * Failing a run on a coincidence the operator cannot disprove is not a verdict
 * this command is entitled to make, so that one warns and names the column to
 * add.
 */
const reportStorageOutcome = (logger: Logger, report: StorageRemapReport, verify: boolean): boolean => {
    logger.info(
        `storage refs: ${String(report.rewritten)} rewritten, ${String(report.unmigrated.length)} unmigrated, ${String(report.ambiguous.length)} ambiguous`,
    );

    listUnresolved(
        logger,
        report.unmigrated,
        (reference) =>
            `unmigrated storage reference ${reference.table}.${reference.column}: ${reference.storageId} has no exported blob — re-export with \`npx convex export --include-file-storage\``,
    );

    listUnresolved(
        logger,
        report.ambiguous,
        (reference) =>
            `unrewritten storage id in ${reference.table}.${reference.column}: ${reference.storageId} — if that column holds storage references, add it to ${IMPORT_CONVEX_MAPPING_FILE} and re-import`,
    );

    if (verify && report.unmigrated.length > 0) {
        logger.error(`verify: ${String(report.unmigrated.length)} storage reference(s) resolved to no migrated blob`);

        return true;
    }

    return false;
};

/**
 * Report provider-side storage paths the transfer never moved.
 *
 * Left as-is in the document rather than guessed at: a path with no transferred
 * object is either a stale row or a bucket the run did not cover, and only the
 * operator can tell which.
 */
const reportUntransferredPaths = (logger: Logger, paths: ReadonlySet<string>, verify: boolean): boolean => {
    for (const reference of [...paths].slice(0, UNRESOLVED_REPORT_LIMIT)) {
        logger.warn(`storage path never transferred: ${reference} — left as-is`);
    }

    if (paths.size > UNRESOLVED_REPORT_LIMIT) {
        logger.warn(`… and ${String(paths.size - UNRESOLVED_REPORT_LIMIT)} more untransferred storage paths`);
    }

    return verify && paths.size > 0;
};

export { checkRowParity, reportStorageOutcome, reportUntransferredPaths, UNRESOLVED_REPORT_LIMIT };
