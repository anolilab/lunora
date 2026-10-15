import type { ValidatorLike } from "@lunora/shard-engine";
import { renderSql } from "@lunora/shard-engine";
import { env } from "cloudflare:test";
import { sql } from "drizzle-orm";

import type { SqlCtxExec } from "../../../src/ctx-db";
import type { SqlDialect } from "../../../src/dialect";

/**
 * The D1 dialect and exec the workerd suites share: real D1 behind the `env.DB` binding, with the
 * column affinities and framework columns `@lunora/d1` gives it. Suites that need FTS5 take
 * {@link d1FtsDialect}; the rest take {@link d1Dialect}, which has it off.
 */

const UNIQUE_VIOLATION_RE = /unique constraint failed/iu;
const SQL_AFFINITY: Record<string, string> = { boolean: "INTEGER", number: "REAL" };

export const d1Dialect: SqlDialect = {
    columnType: (kind) => SQL_AFFINITY[kind ?? ""] ?? "TEXT",
    companionTypes: { autoincrementPrimaryKey: "INTEGER PRIMARY KEY AUTOINCREMENT", integer: "INTEGER", key: "TEXT", real: "REAL", text: "TEXT" },
    frameworkColumns: () => [
        { name: "id", type: "TEXT PRIMARY KEY" },
        { name: "_creationTime", type: "REAL NOT NULL" },
    ],
    isUniqueViolation: (error) => error instanceof Error && UNIQUE_VIOLATION_RE.test(error.message),
    maxTableColumns: 100,
    name: "sqlite",
    render: (query) => renderSql("sqlite", query),
    supportsFts5: false,
    supportsReturning: true,
    tableExists: (table) => sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${table}`,
};

/** `@lunora/d1`'s dialect, FTS5 included — the layout D1 actually uses. */
export const d1FtsDialect: SqlDialect = { ...d1Dialect, supportsFts5: true };

export const col = (kind: string, extra: Record<string, unknown> = {}): ValidatorLike => {
    return { _meta: { column: { notNull: true, ...extra } }, kind };
};

export const d1Exec: SqlCtxExec = {
    all: async (query, parameters) => {
        const result = await env.DB.prepare(query)
            .bind(...parameters)
            .all();

        return result.results;
    },
    run: async (query, parameters) => {
        await env.DB.prepare(query)
            .bind(...parameters)
            .run();
    },
};
