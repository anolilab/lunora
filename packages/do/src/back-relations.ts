/**
 * Per-row reverse-relation counts for the Studio data browser.
 *
 * A row's FORWARD relations are already visible: a `v.id("users")` column renders
 * as a link. The reverse direction — "how many messages does this user have" —
 * is not derivable from the row itself, because the foreign key lives on the
 * OTHER table. This resolves those counts for one loaded page.
 *
 * **One grouped query per relation, never one per row.** For a 50-row page with
 * two reverse relations that is 2 queries, not 100 — the same
 * `GROUP BY :fk … WHERE :fk IN (values)` shape `relations.ts` uses for the
 * forward fan-out, and for the same reason: the per-row form is the N+1 that
 * makes the feature unusable on a real page.
 *
 * **Opt-in, and this is why.** Resolving these is proportional to
 * `relations × page size`, and most sessions never look at them, so the Studio
 * asks only for the relations the operator switched on rather than every reverse
 * edge the schema happens to have.
 *
 * The FK column is resolved through the same physical-vs-`__doc__` path the
 * filter builder uses, so a doc-stored foreign key works exactly like a physical
 * one and the JSON path is bound, never interpolated.
 */

import type { SqlExec } from "@lunora/shard-engine";
import { DOC_COLUMN } from "@lunora/shard-engine";

import { quoteIdentifier } from "../../../shared/quote-identifier";

/** One reverse edge to count: `table.column` points back at the browsed table. */
interface BackRelationRequest {
    /** The foreign-key column on `table` holding the parent id. */
    column: string;
    /** The CHILD table — the one carrying the foreign key. */
    table: string;
}

/** Counts for one reverse edge, keyed by parent id. Absent ids have no children. */
interface BackRelationCounts {
    column: string;
    counts: Record<string, number>;
    table: string;
}

/** What `__lunora_admin__:backRelationCounts` returns. */
interface BackRelationCountsResult {
    relations: BackRelationCounts[];
}

/**
 * Most parent ids counted in one call. A page is capped well below this
 * server-side, so the bound only matters for a hand-built request.
 */
const MAX_BACK_RELATION_IDS = 500;

/** Most reverse edges resolved in one call, so a pathological request can't fan out. */
const MAX_BACK_RELATIONS = 8;

/** Resolve a column to its SQL expression: a physical column, or a bound `__doc__` JSON path. */
const columnExpression = (column: string, physical: string[]): undefined | { expression: string; params: unknown[] } => {
    if (physical.includes(column)) {
        return { expression: quoteIdentifier(column), params: [] };
    }

    if (!physical.includes(DOC_COLUMN)) {
        return undefined;
    }

    return { expression: `json_extract(${quoteIdentifier(DOC_COLUMN)}, ?)`, params: [`$."${column.replaceAll('"', '""')}"`] };
};

/**
 * Count children per parent id for each requested reverse relation.
 *
 * Every unresolvable request — a table that does not exist, a column the child
 * table does not have — is SKIPPED rather than throwing: the Studio derives
 * these edges from schema metadata that can legitimately lag the live database
 * (a table dropped since the page loaded), and a whole page should not fail
 * because one optional column cannot be resolved.
 */
const readBackRelationCounts = (
    sql: SqlExec,
    options: { ids: ReadonlyArray<string>; relations: ReadonlyArray<BackRelationRequest> },
): BackRelationCountsResult => {
    const ids = [...new Set(options.ids.filter((id) => typeof id === "string" && id !== ""))].slice(0, MAX_BACK_RELATION_IDS);
    const relations = options.relations.slice(0, MAX_BACK_RELATIONS);

    if (ids.length === 0 || relations.length === 0) {
        return { relations: [] };
    }

    const resolved: BackRelationCounts[] = [];

    for (const relation of relations) {
        let physical: string[];

        try {
            physical = sql
                .exec<{ name: string }>(`PRAGMA table_info(${quoteIdentifier(relation.table)})`)
                .toArray()
                .map((column) => column.name);
        } catch {
            continue;
        }

        if (physical.length === 0) {
            continue;
        }

        const expression = columnExpression(relation.column, physical);

        if (expression === undefined) {
            continue;
        }

        const placeholders = ids.map(() => "?").join(", ");
        const counts: Record<string, number> = {};

        try {
            const rows = sql
                .exec<{ n: number; parent: unknown }>(
                    `SELECT ${expression.expression} AS parent, COUNT(*) AS n
                     FROM ${quoteIdentifier(relation.table)}
                     WHERE ${expression.expression} IN (${placeholders})
                     GROUP BY parent`,
                    // The JSON path is bound once per occurrence of the expression.
                    ...expression.params,
                    ...expression.params,
                    ...ids,
                )
                .toArray();

            for (const row of rows) {
                if (typeof row.parent === "string") {
                    counts[row.parent] = row.n;
                }
            }
        } catch {
            continue;
        }

        resolved.push({ column: relation.column, counts, table: relation.table });
    }

    return { relations: resolved };
};

export { MAX_BACK_RELATIONS, readBackRelationCounts };
export type { BackRelationCounts, BackRelationCountsResult, BackRelationRequest };
