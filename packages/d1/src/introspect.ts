/**
 * Read-only D1 introspection for the dashboard's data browser.
 *
 * The DO twin (`@cirrus/do`'s `introspect.ts`) lists shard-local tables and
 * pages their rows from the DO's JSON-blob SQLite. This is the `.global()`
 * counterpart: globals live in D1 with a real column-per-field schema, so the
 * helpers here read actual columns and decode them back into docs (re-exposing
 * `_id` from the `id` column, folding 1/0 into booleans) the same way
 * `admin-export-import.ts` does.
 *
 * Only tables the schema marks `.global()` are ever surfaced — D1 may host
 * better-auth or other application tables, and exposing those through the data
 * browser would leak data the framework doesn't own.
 */
import type { SchemaLike, ValidatorLike } from "@cirrus/do";

import type { D1Exec } from "./d1-ctx-db.js";

/** A global table plus its current row count. */
export interface GlobalTableInfo {
    name: string;
    rowCount: number;
}

/** A window of rows from one global table, plus the column list and total size. */
export interface GlobalTablePage {
    columns: string[];
    rows: Record<string, unknown>[];
    total: number;
}

export interface ReadGlobalTablePageOptions {
    limit?: number;
    offset?: number;
    table: string;
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 500;

const quoteIdentifier = (name: string): string => `"${name.replaceAll('"', '""')}"`;

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);

/** Is `table` declared `.global()` in the schema? Guards every read below. */
const isGlobalTable = (schema: SchemaLike, table: string): boolean => schema.tables[table]?.shardMode?.kind === "global";

/**
 * Decode a SELECTed D1 row into a doc: re-expose `_id` from the `id` column,
 * preserve `_creationTime`, and fold 1/0 back into booleans for boolean fields.
 * Mirrors `admin-export-import.ts`'s `decodeRow` so the browser sees the same
 * doc shape the client would.
 */
const decodeRow = (schema: SchemaLike, table: string, row: Record<string, unknown>): Record<string, unknown> => {
    const definition = schema.tables[table];
    const doc: Record<string, unknown> = {};

    if (definition) {
        for (const [field, validator] of Object.entries(definition.shape) as Array<[string, ValidatorLike]>) {
            const raw = row[field];

            if (raw === undefined) {
                continue;
            }

            doc[field] = validator.kind === "boolean" && (raw === 0 || raw === 1) ? raw === 1 : raw;
        }
    }

    doc["_id"] = row["id"];
    doc["_creationTime"] = row["_creationTime"];

    return doc;
};

const countRows = async (exec: D1Exec, quotedTable: string): Promise<number> => {
    const rows = await exec.all(`SELECT COUNT(*) AS c FROM ${quotedTable}`, []);

    return Number(rows[0]?.["c"] ?? 0);
};

/**
 * List every `.global()` table with its row count, ordered by name. Tables that
 * exist in D1 but aren't declared global in the schema are never returned.
 */
export const listGlobalTables = async (exec: D1Exec, schema: SchemaLike): Promise<GlobalTableInfo[]> => {
    const names = Object.keys(schema.tables)
        .filter((name) => isGlobalTable(schema, name))
        .sort((a, b) => a.localeCompare(b));

    const tables: GlobalTableInfo[] = [];

    for (const name of names) {
        tables.push({ name, rowCount: await countRows(exec, quoteIdentifier(name)) });
    }

    return tables;
};

/**
 * Column list the browser shows for a global table: the schema's declared
 * fields plus the framework columns (`_id`, `_creationTime`) `decodeRow`
 * re-exposes. Keeps the order stable and schema-driven rather than depending on
 * D1's physical column order.
 */
const columnsFor = (schema: SchemaLike, table: string): string[] => {
    const definition = schema.tables[table];
    const fields = definition ? Object.keys(definition.shape) : [];

    return ["_id", "_creationTime", ...fields];
};

/**
 * Read a page of rows from one global table. The table is validated against the
 * schema's global allowlist before its name is interpolated, so this can't be
 * coerced into reading non-global D1 tables. `limit` is clamped to `[1, 500]`;
 * `offset` floors at `0`.
 */
export const readGlobalTablePage = async (exec: D1Exec, schema: SchemaLike, options: ReadGlobalTablePageOptions): Promise<GlobalTablePage> => {
    const { table } = options;

    if (!isGlobalTable(schema, table)) {
        throw Object.assign(new Error(`unknown global table: ${table}`), { name: "CirrusError", code: "UNKNOWN_TABLE", status: 404 });
    }

    const limit = clamp(Math.trunc(options.limit ?? DEFAULT_PAGE_SIZE), 1, MAX_PAGE_SIZE);
    const offset = Math.max(0, Math.trunc(options.offset ?? 0));
    const quoted = quoteIdentifier(table);

    const total = await countRows(exec, quoted);
    const raw = await exec.all(`SELECT * FROM ${quoted} LIMIT ? OFFSET ?`, [limit, offset]);
    const rows = raw.map((row) => decodeRow(schema, table, row));

    return { columns: columnsFor(schema, table), rows, total };
};
