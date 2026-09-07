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

/* eslint-disable no-restricted-syntax -- every `dsql`…`` here is a drizzle tagged-template SQL builder binding a value, not a string conversion; the rule misfires on the inner TemplateLiteral. */
import type { SqlExec } from "@lunora/shard-engine";
import { DOC_COLUMN, renderSql, sqliteInList } from "@lunora/shard-engine";
import type { SQL } from "drizzle-orm";
import { sql as dsql } from "drizzle-orm";

import { jsonPathSegment } from "../../../shared/json-path-segment";

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
 * Most parent ids counted in one call.
 *
 * The Studio's largest page size is 100, so a normal request is well under this;
 * the bound only matters for a hand-built one. It is NOT a placeholder budget —
 * the id list goes through `sqliteInList`, which switches a list wider than half
 * of workerd's 100-parameter statement cap to a single bound `json_each(?)`
 * argument. A literal `IN (?, ?, …)` over a 100-row page would exceed that cap
 * and fail to prepare with `SQLITE_ERROR` on a Durable Object, while passing
 * locally against stock SQLite's 500,000-variable build.
 */
const MAX_BACK_RELATION_IDS = 500;

/** Most reverse edges resolved in one call, so a pathological request can't fan out. */
const MAX_BACK_RELATIONS = 8;

/** Resolve a column to its SQL expression: a physical column, or a bound `__doc__` JSON path. */
const columnExpression = (column: string, physical: string[]): SQL | undefined => {
    if (physical.includes(column)) {
        return dsql`${dsql.identifier(column)}`;
    }

    if (!physical.includes(DOC_COLUMN)) {
        return undefined;
    }

    // `jsonPathSegment`, never a hand-rolled quoter: a JSON path is not a SQL
    // identifier, so doubling `"` (the identifier rule) emits `$."a""b"`, which
    // SQLite reads as NULL instead of the column's value.
    return dsql`json_extract(${dsql.identifier(DOC_COLUMN)}, ${`$.${jsonPathSegment(column)}`})`;
};

/**
 * Count children per parent id for each requested reverse relation.
 *
 * Every unresolvable request — a table that does not exist, a column the child
 * table does not have — is SKIPPED rather than throwing: the Studio derives
 * these edges from schema metadata that can legitimately lag the live database
 * (a table dropped since the page loaded), and a whole page should not fail
 * because one optional column cannot be resolved. A skip is logged, never
 * silent: a blank count cell with no error and no log is indistinguishable from
 * "this row genuinely has no children", which is how a statement that failed to
 * prepare went unnoticed.
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
                .exec<{ name: string }>(renderSql("sqlite", dsql`PRAGMA table_info(${dsql.identifier(relation.table)})`).sql)
                .toArray()
                .map((column) => column.name);
        } catch (error: unknown) {
            // eslint-disable-next-line no-console -- intentional operational notice: a skipped edge renders as a blank count cell, which is indistinguishable from "no children" unless the reason is logged
            console.warn(`[@lunora/do] backRelationCounts: skipping "${relation.table}.${relation.column}" — cannot read its columns:`, error);
            continue;
        }

        if (physical.length === 0) {
            continue;
        }

        const expression = columnExpression(relation.column, physical);

        if (expression === undefined) {
            continue;
        }

        const counts: Record<string, number> = {};

        try {
            // `sqliteInList` keeps the statement inside workerd's 100-bound-parameter
            // cap: a short list renders as `IN (?, …)`, a wide one as a single
            // `json_each(?)` argument. The FK expression is repeated (SELECT, WHERE and
            // GROUP BY) and carries a bound JSON path when the column is doc-stored, so its
            // three copies plus the list must fit that budget together. `GROUP BY`
            // repeats the expression rather than naming the `parent` alias: a child
            // table with a real column called `parent` would otherwise bind the
            // grouping to that column instead of the alias.
            const rendered = renderSql(
                "sqlite",
                dsql`SELECT ${expression} AS ${dsql.identifier("parent")}, COUNT(*) AS ${dsql.identifier("n")}
                     FROM ${dsql.identifier(relation.table)}
                     WHERE ${sqliteInList(expression, ids, false)}
                     GROUP BY ${expression}`,
            );

            const rows = sql.exec<{ n: number; parent: unknown }>(rendered.sql, ...rendered.params).toArray();

            for (const row of rows) {
                if (typeof row.parent === "string") {
                    counts[row.parent] = row.n;
                }
            }
        } catch (error: unknown) {
            // eslint-disable-next-line no-console -- intentional operational notice: this is the failure the silent `catch` used to hide, and it blanks the column for the whole page
            console.warn(`[@lunora/do] backRelationCounts: skipping "${relation.table}.${relation.column}" — the count query failed:`, error);
            continue;
        }

        resolved.push({ column: relation.column, counts, table: relation.table });
    }

    return { relations: resolved };
};

export { MAX_BACK_RELATION_IDS, MAX_BACK_RELATIONS, readBackRelationCounts };
export type { BackRelationCounts, BackRelationCountsResult, BackRelationRequest };
