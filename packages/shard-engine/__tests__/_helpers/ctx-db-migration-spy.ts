import type { SqlExec } from "../../src/ctx-db";
import type { SchemaLike } from "../../src/schema-types";

/** A schema of `tableCount` tables, each with `indexesPerTable` indexes (the first unique) and a `shape` to match. The first table carries a TTL. */
export const buildWideSchema = (tableCount: number, indexesPerTable: number): SchemaLike => {
    const tables: Record<string, unknown> = {};

    for (let tableIndex = 0; tableIndex < tableCount; tableIndex += 1) {
        const shape: Record<string, unknown> = { expiresAt: { kind: "number" } };
        const indexes: { fields: string[]; name: string; unique?: boolean }[] = [];

        for (let fieldIndex = 0; fieldIndex < indexesPerTable; fieldIndex += 1) {
            const field = `field${String(fieldIndex)}`;

            shape[field] = { kind: "string" };
            indexes.push({ fields: [field], name: `by_${field}`, unique: fieldIndex === 0 });
        }

        tables[`items_${String(tableIndex)}`] = {
            indexes,
            shape,
            ttlPolicy: tableIndex === 0 ? { field: "expiresAt" } : undefined,
        };
    }

    return { tables } as SchemaLike;
};

export interface SpiedSql {
    cursors: { rowsRead?: unknown; rowsWritten?: unknown }[];
    ftsProbes: number;
    ftsReadChecks: number;
    ledgerScans: number;
    sqliteMasterScans: number;
    statements: string[];
}

/** Wrap a handle so a run's statements and cursors can be counted. Each wrapper is a fresh handle for per-handle caches. */
export const spySql = (inner: SqlExec): { sql: SqlExec; stats: SpiedSql } => {
    const stats: SpiedSql = { cursors: [], ftsProbes: 0, ftsReadChecks: 0, ledgerScans: 0, sqliteMasterScans: 0, statements: [] };
    const sql: SqlExec = {
        exec: <Row = Record<string, unknown>>(query: string, ...bindings: unknown[]) => {
            stats.statements.push(query);

            if (query.includes("sqlite_master")) {
                stats.sqliteMasterScans += 1;
            }

            if (query.includes("SELECT") && query.includes("__lunora_framework_indexes")) {
                stats.ledgerScans += 1;
            }

            if (query.includes("__lunora_fts_probe")) {
                stats.ftsProbes += 1;
            }

            if (query.includes("LIMIT 0") && query.includes("__fts_")) {
                stats.ftsReadChecks += 1;
            }

            const cursor = inner.exec<Row>(query, ...bindings);

            stats.cursors.push(cursor as { rowsRead?: unknown; rowsWritten?: unknown });

            return cursor;
        },
    };

    return { sql, stats };
};
