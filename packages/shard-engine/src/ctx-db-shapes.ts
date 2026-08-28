/**
 * Shape membership queries for declarative partial replication (Phase 3).
 *
 * A shape is a named, RLS-composed partial view of one table: the DO resolves
 * its predicate to an `effectiveWhere` (the shape's `where(ctx, args)` AND the
 * caller's RLS read base-where) and this module runs that predicate against the
 * shard's SQLite to answer two questions over the JSON-blob store:
 *
 * - **Seed** ({@link selectShapeRows}): the full current rowset a fresh
 * subscription replicates — one insert poke.
 * - **Per-flush membership + enrichment** ({@link selectShapeMembers}): of the
 * rows a write just changed, those that still satisfy the predicate, WITH their
 * current documents — so the poke emits an upsert for in-set ids and a delete
 * for the rest (a row that left the set, or a delete whose membership is
 * unknowable from the op alone), and never decodes a document it may not ship.
 *
 * Both go through the single `compileWhereSql` compiler the query/RLS paths
 * already use (`json_extract` field refs, `serializeSqlValue` literals), so a
 * shape's filter has ZERO semantic drift from an equivalent `query`/`rls`
 * predicate — there is no second, hand-rolled WHERE implementation.
 */

/* eslint-disable no-restricted-syntax -- every `dsql\`…\`` here is a drizzle tagged-template SQL builder binding a value, not a string conversion; the rule misfires on the inner TemplateLiteral (see where-sql.ts). */
/* eslint-disable unicorn/prevent-abbreviations -- "ctx-db-shapes" mirrors its parent "ctx-db.ts" (the established public module name). */

import type { SQL } from "drizzle-orm";
import { sql as dsql } from "drizzle-orm";

import type { SqlExec } from "./ctx-db";
import { runDrizzle } from "./do-exec";
import { DOC_COLUMN, jsonPathSql, rowToDocument, serializeSqlValue } from "./do-sql";
import { sqliteInList } from "./drizzle";
import type { WhereSqlStrategy } from "./where-sql";
import { compileWhereSql } from "./where-sql";
import type { WhereInput } from "./where-types";

/** Flat JSON-blob `where` strategy: fields via `json_extract`, values via `serializeSqlValue`. Mirrors the query path's `doWhereSqlStrategy`. */
const shapeWhereStrategy: WhereSqlStrategy = { fieldRef: jsonPathSql, serialize: serializeSqlValue };

/** Build the `id IN (...)` restriction for a non-empty id list, or `undefined` to leave the query unrestricted. */
const idInClause = (ids: ReadonlyArray<string>): SQL | undefined => {
    if (ids.length === 0) {
        return undefined;
    }

    return sqliteInList(dsql`${dsql.identifier("id")}`, ids, false);
};

/** AND-compose an optional id restriction with the compiled `effectiveWhere`, returning the trailing `WHERE …` fragment (empty when unconstrained). */
const composeWhere = (effectiveWhere: WhereInput | undefined, idRestriction: SQL | undefined): SQL => {
    const conditions: SQL[] = [];

    if (idRestriction) {
        conditions.push(idRestriction);
    }

    const compiled = compileWhereSql(effectiveWhere, shapeWhereStrategy);

    if (compiled) {
        conditions.push(compiled);
    }

    if (conditions.length === 0) {
        return dsql``;
    }

    return dsql` WHERE ${dsql.join(conditions, dsql` AND `)}`;
};

/** One shape member: its `_id` key plus the decoded document (id + creationTime merged in). */
export interface ShapeRow {
    doc: Record<string, unknown>;
    id: string;
}

/**
 * The full current rowset of `table` satisfying `effectiveWhere` — the shape's
 * seed snapshot. Returns each member's `_id` + decoded document.
 */
export const selectShapeRows = (sql: SqlExec, table: string, effectiveWhere: WhereInput | undefined): ShapeRow[] => {
    const whereClause = composeWhere(effectiveWhere, undefined);

    const rows = runDrizzle(sql, dsql`SELECT id, _creationTime, ${dsql.identifier(DOC_COLUMN)} FROM ${dsql.identifier(table)}${whereClause}`).toArray();

    const result: ShapeRow[] = [];

    for (const row of rows) {
        const doc = rowToDocument(row);
        const { id } = row;

        if (doc !== undefined && typeof id === "string") {
            result.push({ doc, id });
        }
    }

    return result;
};

/**
 * Of the rows identified by `ids`, those that still satisfy `effectiveWhere`,
 * keyed by id and carrying the decoded document — the per-flush membership
 * probe AND the diff's late-enrichment read in one statement.
 *
 * The two used to be separate: the poke builder read every changed row's full
 * post-image out of the op-log first, then ran an id-only probe to decide which
 * of those documents it was allowed to ship. That decoded N documents to keep
 * the M ≤ N that survived, and the surviving values came from the op-log while
 * their membership came from this table — two sources for one row. Selecting the
 * document here settles both from the same read: a row absent from the result
 * is out of the set (upsert nothing, `delete` the key), and a row present is a
 * member whose current value is right here, already filtered by the predicate
 * the caller is allowed to see through.
 *
 * An empty `ids` short-circuits to an empty map (a flush that changed nothing
 * this shape cares about) without touching the store.
 */
export const selectShapeMembers = (
    sql: SqlExec,
    table: string,
    effectiveWhere: WhereInput | undefined,
    ids: ReadonlyArray<string>,
): Map<string, Record<string, unknown>> => {
    const members = new Map<string, Record<string, unknown>>();

    if (ids.length === 0) {
        return members;
    }

    const whereClause = composeWhere(effectiveWhere, idInClause(ids));

    const rows = runDrizzle(sql, dsql`SELECT id, _creationTime, ${dsql.identifier(DOC_COLUMN)} FROM ${dsql.identifier(table)}${whereClause}`).toArray();

    for (const row of rows) {
        const doc = rowToDocument(row);
        const { id } = row;

        if (doc !== undefined && typeof id === "string") {
            members.set(id, doc);
        }
    }

    return members;
};
