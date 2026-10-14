import emit from "../../finding";
import type { Lint } from "../../types";

/**
 * `.commitOrdered()` gives a table `_commitSeq`, and the point of `_commitSeq` is
 * that a consumer can page `where _commitSeq > cursor` and be sure it missed
 * nothing. That guarantee holds for inserts and updates. It does **not** hold for
 * a hard delete: the sequence lives ON the row, so a physically removed row takes
 * its sequence with it. The row stops appearing in the feed, but no event ever
 * says it went away — a consumer holding a materialized copy keeps serving it
 * forever.
 *
 * Pairing the table with `.softDelete()` closes it: the tombstone flip is
 * mechanically an UPDATE, so it advances `_commitSeq` and pages through like any
 * other change.
 *
 * `WARN`, not `ERROR`, because the combination is legitimate for a genuinely
 * append-only table — an event log, an audit trail, a ledger — where nothing is
 * ever deleted and there is no delete to express. The lint exists because the
 * failure mode is silent and permanent, so it should be a decision rather than
 * an oversight.
 */
const commitOrderedHardDelete: Lint = {
    categories: ["SCHEMA"],
    description:
        "A `.commitOrdered()` table without `.softDelete()` cannot express a delete in its `_commitSeq` feed: the sequence lives on the row, so a hard-deleted row vanishes with no event a consumer can observe.",
    facing: "INTERNAL",
    level: "WARN",
    name: "commit_ordered_hard_delete",
    remediation:
        "Add `.softDelete()` so the tombstone flip advances `_commitSeq` and pages through the feed — or, if the table is genuinely append-only and nothing is ever deleted from it, leave it as-is.",
    run: (context) => {
        const findings = [];

        for (const table of context.schema.tables) {
            // The codegen feeder always supplies `commitOrdered`; a feeder that
            // does not track it leaves the field absent, and an absent flag must
            // not be read as "opted in".
            if (table.commitOrdered !== true || table.softDelete !== undefined) {
                continue;
            }

            findings.push(
                emit(commitOrderedHardDelete, {
                    cacheKey: `commit_ordered_hard_delete:${table.name}`,
                    detail: `Table "${table.name}" is \`.commitOrdered()\` but not \`.softDelete()\`. A hard delete removes the row and its \`_commitSeq\` together, so a changefeed paging on the sequence never learns the row is gone.`,
                    metadata: { table: table.name },
                }),
            );
        }

        return findings;
    },
    source: "static",
    title: "Commit-ordered table cannot express deletes",
};

export default commitOrderedHardDelete;
