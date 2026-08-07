/**
 * The **SQLite** {@link SqlDialect} — the reference dialect Lunora's global
 * store core (`@lunora/sql-store`) was written against, and the one D1 injects.
 *
 * It assembles the engine-specific decisions from this package's existing
 * `dialect.ts` DDL helper (`sqlAffinityForKind`) and `@lunora/sql-store`'s shared
 * value codec (`sqliteEncode`/`sqliteDecode`). Identifier quoting, placeholders,
 * upserts and NULL-safe equality are no longer dialect members — the store core
 * builds those through drizzle's SQLite dialect, keyed off `name`. Kept as a
 * separate module (not inlined into the runtime) so `@lunora/d1/dialect` can
 * re-export it for the CLI migration emitter, and so the Postgres/MySQL dialects
 * in `@lunora/hyperdrive/global` have a concrete template to mirror.
 */
import type { SqlDialect } from "@lunora/sql-store";
import { sqliteDecode, sqliteEncode } from "@lunora/sql-store";
import { sql } from "drizzle-orm";

import { sqlAffinityForKind } from "./dialect";

/** Both workerd and `node:sqlite` phrase a UNIQUE-index breach as "UNIQUE constraint failed". */
const UNIQUE_VIOLATION_RE = /unique constraint failed/iu;

/**
 * The canonical SQLite dialect: column affinities, the shared SQLite value
 * codec, `RETURNING` support (both D1 and `node:sqlite`), and `sqlite_master`
 * table probing. The rest of the per-statement shaping is drizzle's.
 */
const sqliteDialect: SqlDialect = {
    companionTypes: {
        autoincrementPrimaryKey: "INTEGER PRIMARY KEY AUTOINCREMENT",
        integer: "INTEGER",
        key: "TEXT",
        real: "REAL",
        text: "TEXT",
    },
    columnType: sqlAffinityForKind,
    decode: sqliteDecode,
    encode: sqliteEncode,
    frameworkColumns: () => [
        { name: "id", type: "TEXT PRIMARY KEY" },
        { name: "_creationTime", type: "REAL NOT NULL" },
    ],
    isUniqueViolation: (error) => error instanceof Error && UNIQUE_VIOLATION_RE.test(error.message),
    name: "sqlite",
    supportsFts5: true,
    supportsReturning: true,

    tableExists: (table) => sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${table}`,
};

export default sqliteDialect;
