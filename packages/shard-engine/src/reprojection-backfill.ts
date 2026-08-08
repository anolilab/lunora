/**
 * Backfill for rows the `v.bigint()` / `v.bytes()` storage codec left
 * unqueryable.
 *
 * Between `ab0afaf00` and the SQL-comparable projection (`sql-projection.ts`),
 * the row store wrote both kinds as a **wire-tagged array left in place** at
 * `$.field`. Such a row still READS correctly — `decodeDocJson` accepts every
 * format this store has written — but the stored text is an array, so
 * `json_extract` never matches it: `filter`/`withIndex` miss it, `ORDER BY`
 * sorts it as text, `SUM` counts it as zero.
 *
 * Any write through the writer heals a row, because `encodeDocJson` re-encodes
 * the whole document. **So what is left is the rows nobody rewrites** — for
 * `@lunora/payment`'s `paymentSessions`, precisely the settled sessions, which
 * are the ones most likely to be queried by amount and least likely to be
 * written again.
 *
 * There is no runner here, and there should not be: `runDataMigration`
 * (`data-migration.ts`) already provides keyset batching through the normal
 * writer, resumability, idempotence, `dryRun`, and — the property this needs —
 * cursor stability, since `replace` preserves `_id`/`_creationTime` so a
 * rewritten row never moves relative to the cursor. This module contributes
 * only the three things that are specific to the defect: which tables can be
 * affected, whether a given row is one of them, and a transform that re-encodes.
 */

import { quoteIdentifier } from "../../../shared/quote-identifier";
import { reprojectionMigrationTable } from "../../../shared/reprojection-id";
import { encodeWire } from "../../../shared/wire-codec";
import type { SqlExec } from "./ctx-db";
import type { DataMigrationLike } from "./data-migration";
import { runSql } from "./do-exec";
import { DOC_COLUMN, encodeDocJson as encodeDocumentJson } from "./do-sql";
import type { SchemaLike, TableDefinitionLike } from "./schema-types";
import { mayHoldProjectedValue } from "./sql-projection";

/**
 * The wire codec's sentinel, derived from the codec rather than copied out of
 * it. `shared/wire-codec.ts` does not export the constant and must not be
 * edited (it is wire-protocol surface), and a hand-copied `"$lunora.wire$"`
 * here would be a second definition free to drift from the first. Encoding a
 * `bigint` yields `[TAG, "bigint", "0"]`, so element 0 IS the sentinel.
 */
const WIRE_TAG = (encodeWire(0n) as unknown[])[0] as string;

/**
 * One JSON-path object key, quoted so SQLite's path grammar reads it as a single
 * segment. Without this a field named `amount.minor` becomes `$.amount.minor`,
 * which resolves to a *nested* key and silently matches nothing.
 *
 * Known gap, deliberately not widened here: `documentPath` in `do-sql.ts` does
 * not quote either, so such a field is already unaddressable everywhere in this
 * store. Fixing it there is the root-cause edit, but it changes the expression
 * text of every `CREATE INDEX`, so it needs a rebuild story of its own.
 */
const jsonPathSegment = (field: string): string => `"${field.replaceAll('"', String.raw`\"`)}"`;

/**
 * Field names on `definition` that could hold a projected value.
 *
 * Reads the **effective** kind (`mayHoldProjectedValue`), so
 * `v.optional(v.bigint())` counts. Dispatching on the declared `kind` missed it,
 * which made `countLegacyRows` report 0 for an affected table — a completeness
 * check telling an operator their data was clean when it was not. It also counts
 * `v.any()` / `v.union()` / `v.from()`, which commit to no type and can hold a
 * `bigint` the projection then projects on runtime type.
 *
 * Over-including a field is safe because {@link legacyRowPredicate} tests the
 * tagged value's TYPE slot rather than merely the sentinel, so a `Date` under a
 * `v.any()` field — legitimately tagged under the current projection — is not
 * matched. Under-including one is silent data loss.
 *
 * `.global()` tables are excluded outright — their rows live in the sql-store
 * backend, which has its own per-column codec and was never affected.
 * @returns the field names worth scanning, or an empty array when the table cannot be affected
 */
const reprojectableFields = (definition: TableDefinitionLike): string[] => {
    if (definition.shardMode?.kind === "global") {
        return [];
    }

    return Object.entries(definition.shape)
        .filter(([, validator]) => mayHoldProjectedValue(validator))
        .map(([field]) => field);
};

/** Every table in `schema` that can hold an affected row, in declaration order. */
const reprojectionTables = (schema: SchemaLike): string[] =>
    Object.entries(schema.tables)
        .filter(([, definition]) => reprojectableFields(definition).length > 0)
        .map(([table]) => table);

/**
 * `WHERE` fragment matching a row still stored in the legacy tagged-in-place
 * form, plus its bound parameters.
 *
 * The test has to run on the **stored text**: a decoded document cannot say
 * which format it came from, which is the entire defect. Two things must both
 * hold at a top-level field: element 0 is the wire sentinel, and element 1 is
 * `bigint` or `bytes`.
 *
 * The second half is what makes this safe to point at a `v.any()` field. A
 * `Date` there is tagged under the CURRENT projection and must not match —
 * matching it would rewrite the row, re-tag the `Date`, and leave it "legacy"
 * forever, so `countLegacyRows` would never reach zero and every deploy would
 * rewrite every shard. Testing only the sentinel would do exactly that.
 *
 * `json_extract` returns `NULL` for a current projection (a JSON string, so
 * `$.field[0]` does not resolve), which is why a NULL-safe `=` is enough.
 *
 * Paths are **bound**, which defeats SQL injection but NOT SQLite's JSON-path
 * grammar — an unquoted `.` in a field name would still parse as a nested key.
 * Hence {@link jsonPathSegment}. Binding costs nothing here: this is a one-off
 * scan, not an indexed lookup whose expression has to match an index.
 */
const legacyRowPredicate = (fields: ReadonlyArray<string>): { params: unknown[]; sql: string } => {
    const clauses = fields.map(() => `(json_extract(${quoteIdentifier(DOC_COLUMN)}, ?) = ? AND json_extract(${quoteIdentifier(DOC_COLUMN)}, ?) IN (?, ?))`);
    const params = fields.flatMap((field) => [`$.${jsonPathSegment(field)}[0]`, WIRE_TAG, `$.${jsonPathSegment(field)}[1]`, "bigint", "bytes"]);

    return { params, sql: clauses.join(" OR ") };
};

/**
 * How many rows of `table` are still stored in the legacy form.
 *
 * One query, so a shard with nothing to do costs one query rather than a scan.
 * This is both the `--dry-run` figure an operator wants before committing to a
 * rewrite and the completeness check they want after one: it reads zero exactly
 * when the table is fully re-projected.
 */
const countLegacyRows = (sql: SqlExec, table: string, fields: ReadonlyArray<string>): number => {
    if (fields.length === 0) {
        return 0;
    }

    const { params, sql: predicate } = legacyRowPredicate(fields);
    const rows = runSql<{ count: number }>(sql, `SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)} WHERE ${predicate}`, ...params).toArray();

    return rows[0]?.count ?? 0;
};

/** Whether one row is still stored in the legacy form. */
const isLegacyRow = (sql: SqlExec, table: string, fields: ReadonlyArray<string>, id: string): boolean => {
    const { params, sql: predicate } = legacyRowPredicate(fields);

    return runSql(sql, `SELECT 1 FROM ${quoteIdentifier(table)} WHERE id = ? AND (${predicate}) LIMIT 1`, id, ...params).toArray().length > 0;
};

/**
 * The reserved migration behind `lunora migrate up __lunora_reproject__<table>`,
 * or `undefined` when `id` is not one of them (an unaffected table, a
 * `.global()` table, or an id that simply is not ours — the caller falls through
 * to its own registry).
 *
 * The transform is the **identity**: returning the document unchanged makes the
 * runner rewrite it through `replace`, and `encodeDocJson` re-encodes with the
 * current projection on the way down. Nothing here reconstructs a value, so
 * there is no third implementation of the projection to drift — which is the
 * mistake that produced the original defect. A raw SQL `UPDATE` over `__doc__`
 * would be faster and would bypass triggers, CDC and subscriber notification.
 *
 * Rows already in the current projection return `undefined`, so the runner
 * counts them processed and leaves them alone: rewriting them is wasted work
 * and pokes every subscriber watching the row.
 */
const buildReprojectionMigration = (id: string, schema: SchemaLike, sql: SqlExec): DataMigrationLike | undefined => {
    const table = reprojectionMigrationTable(id);

    if (table === undefined) {
        return undefined;
    }

    const definition = schema.tables[table];

    if (!definition) {
        return undefined;
    }

    const fields = reprojectableFields(definition);

    if (fields.length === 0) {
        return undefined;
    }

    return {
        id,
        table,
        up: (document) => {
            // ponytail: one primary-key seek per visited row. It rides alongside
            // a scan that already reads every row, and it has no memory ceiling
            // — pre-computing the id set would be one query but would hold every
            // affected id in a Durable Object's 128 MB. Revisit only if a
            // profile says this seek is the cost.
            const rowId = document["_id"];

            if (typeof rowId !== "string" || !isLegacyRow(sql, table, fields, rowId)) {
                return undefined;
            }

            // The legacy format stored a bigint of ANY width, so a row can hold
            // one the projection refuses (a uint256 balance is 78 digits, and
            // this repo ships `@lunora/x402`). Letting that throw would fail the
            // whole run with the cursor pinned on this row, so every resume dies
            // identically and every row behind it stays legacy — one bad row
            // wedging the table forever. Skip it and say so; the rest converge.
            try {
                encodeDocumentJson(document);
            } catch (error: unknown) {
                // eslint-disable-next-line no-console -- no logger reaches a migration transform; the host captures this, and a silently skipped row is worse
                console.warn(`${id}: skipping row ${rowId} — it cannot be re-projected: ${error instanceof Error ? error.message : String(error)}`);

                return undefined;
            }

            return document;
        },
    };
};

export { buildReprojectionMigration, countLegacyRows, reprojectableFields, reprojectionTables };

export {REPROJECTION_MIGRATION_PREFIX, reprojectionMigrationId} from "../../../shared/reprojection-id";