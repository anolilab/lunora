/**
 * Reading every auth table out, and writing rows back, for the runtime's admin
 * export / import (`$auth` section) — so a backup, a restore and an eject carry
 * users, accounts and sessions along with the app's own tables.
 *
 * The auth tables are outside the schema: better-auth's tables in the auth D1
 * database ({@link createSqlAuthDataPort}), or every table of the DO-backed auth
 * object ({@link createDoAuthDataPort}, served by the object's internal move
 * route). Both speak the same row shape: one wire-encoded row (`shared/wire-codec`,
 * so a byte column survives JSON) per `{ table, doc }`.
 *
 * Import is append-only, matching the table import: a row whose key, or any
 * unique value, already exists is skipped and counted as a conflict. Rows are
 * written in the order they arrive, and the export writes parents first (`user`,
 * then `account` and `session`), so foreign keys hold.
 *
 * The return shape mirrors `@lunora/runtime`'s `AuthDataPort` structurally — no
 * dependency edge to the runtime.
 */
import { LunoraError } from "@lunora/errors";
import { getAuthTables } from "better-auth/db";

import { quoteIdentifier } from "../../../shared/quote-identifier";
import { decodeWire, encodeWire } from "../../../shared/wire-codec";
import { AUTH_AUDIT_TABLE } from "./audit";
import type { LunoraAuthOptions } from "./create-auth";
import type { SqlExecutor } from "./sql-store";

type Row = Record<string, unknown>;

/** Rows per read. Matches the jurisdiction move's page, which the DO export reuses. */
const PAGE_ROWS = 100;

interface AuthImportResult {
    conflicts: number;
    /** `index` is the row's position in the batch. Messages name the table and a SQLite error class, never row data. */
    errors: { index: number; message: string; table: string }[];
    inserted: number;
}

/** What the runtime's admin export / import reads and writes auth rows through. */
interface AuthDataPortLike {
    exportRows: () => AsyncIterable<{ doc: Row; table: string }>;
    importRows: (rows: ReadonlyArray<{ doc: Row; table: string }>) => Promise<AuthImportResult>;
}

/** The read half of a SQL executor — all both D1 and Durable Object storage need here. */
type AuthSqlReader = Pick<SqlExecutor, "all">;

/**
 * The physical table names better-auth creates for `options` (plugin tables
 * included), in its own creation order — `user` first — then the audit log.
 * @param options The resolved auth options — a built instance's `auth.options`.
 */
const authTableNames = (options: LunoraAuthOptions): string[] => [
    ...Object.values(getAuthTables(options))
        .toSorted((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) || a.modelName.localeCompare(b.modelName))
        .map((table) => table.modelName),
    AUTH_AUDIT_TABLE,
];

/** A table's columns; empty when it does not exist. `PRAGMA table_info` rather than `pragma_table_info()`: D1's authorizer refuses the function form. */
const columnsOf = async (sql: AuthSqlReader, table: string): Promise<string[]> => {
    const info = await sql.all(`PRAGMA table_info(${quoteIdentifier(table)})`, []);

    return info.map((row) => String(row["name"]));
};

const ROWID = "__lunora_rowid__";

/** A SQLite error class safe to hand an admin caller — never the row's values. */
const SAFE_CAUSE = /(?:UNIQUE|NOT NULL|CHECK|FOREIGN KEY|PRIMARY KEY) constraint failed|no such (?:table|column)|datatype mismatch|SQLITE_[A-Z_]+/u;

/** Every row of `tables`, a page at a time in `rowid` order. A table that does not exist is skipped. */
const readAuthTables = async function* readAuthTables(sql: AuthSqlReader, tables: ReadonlyArray<string>): AsyncGenerator<{ doc: Row; table: string }> {
    for (const table of tables) {
        // eslint-disable-next-line no-await-in-loop -- one table at a time
        const columns = await columnsOf(sql, table);

        if (columns.length === 0) {
            continue;
        }

        let after = 0;

        for (;;) {
            // eslint-disable-next-line no-await-in-loop -- each page starts after the previous one
            const rows = await sql.all(`SELECT rowid AS "${ROWID}", * FROM ${quoteIdentifier(table)} WHERE rowid > ? ORDER BY rowid LIMIT ?`, [
                after,
                PAGE_ROWS,
            ]);

            for (const row of rows) {
                yield { doc: encodeWire(Object.fromEntries(Object.entries(row).filter(([name]) => name !== ROWID))) as Row, table };
            }

            const last = rows.at(-1)?.[ROWID];

            if (rows.length < PAGE_ROWS || typeof last !== "number") {
                break;
            }

            after = last;
        }
    }
};

const safeCause = (error: unknown): string => {
    const message = error instanceof Error ? error.message : String(error);

    return SAFE_CAUSE.exec(message)?.[0] ?? "insert failed";
};

/**
 * Insert wire-encoded rows, skipping any that collide with an existing key or
 * unique value. Only columns the table has are written, so a row from a newer
 * plugin set still lands, minus what this schema cannot hold.
 */
const insertAuthRows = async (
    sql: AuthSqlReader,
    rows: ReadonlyArray<{ doc: Row; table: string }>,
    isAuthTable: (table: string) => boolean,
): Promise<AuthImportResult> => {
    const result: AuthImportResult = { conflicts: 0, errors: [], inserted: 0 };
    const columns = new Map<string, string[]>();

    for (const [index, { doc, table }] of rows.entries()) {
        if (!isAuthTable(table)) {
            result.errors.push({ index, message: `"${table}" is not an auth table`, table });
            continue;
        }

        let known = columns.get(table);

        if (known === undefined) {
            // eslint-disable-next-line no-await-in-loop -- once per table
            known = await columnsOf(sql, table);
            columns.set(table, known);
        }

        const row = decodeWire(doc) as Row;
        const names = Object.keys(row).filter((name) => known.includes(name));

        if (names.length === 0) {
            result.errors.push({ index, message: `no column of the row exists on "${table}"`, table });
            continue;
        }

        try {
            // eslint-disable-next-line no-await-in-loop -- rows go in order, parents first
            const written = await sql.all(
                `INSERT INTO ${quoteIdentifier(table)} (${names.map((name) => quoteIdentifier(name)).join(", ")}) VALUES (${names.map(() => "?").join(", ")}) ON CONFLICT DO NOTHING RETURNING 1 AS "written"`,
                // eslint-disable-next-line unicorn/no-null -- SQL NULL
                names.map((name) => row[name] ?? null),
            );

            if (written.length > 0) {
                result.inserted += 1;
            } else {
                result.conflicts += 1;
            }
        } catch (error) {
            result.errors.push({ index, message: `"${table}": ${safeCause(error)}`, table });
        }
    }

    return result;
};

/**
 * The auth data port over the auth D1 database (or any {@link SqlExecutor}).
 * @param executor The auth database, e.g. `d1Executor(env.DB)`.
 * @param tables The auth tables to carry, parents first — {@link authTableNames}, minus any the schema already declares (those travel as ordinary table rows).
 */
const createSqlAuthDataPort = (executor: SqlExecutor, tables: ReadonlyArray<string>): AuthDataPortLike => {
    return {
        exportRows: () => readAuthTables(executor, tables),
        importRows: async (rows) => insertAuthRows(executor, rows, (table) => tables.includes(table)),
    };
};

/**
 * The auth data port over the DO-backed auth object, through its secret-gated
 * move route: `tables` lists the object's tables in copy order, `page` reads
 * them (the jurisdiction move's source read), `import` writes rows.
 * @param post Send one request body to the object's move route, with the internal secret.
 */
const createDoAuthDataPort = (post: (body: Row) => Promise<Response>): AuthDataPortLike => {
    const call = async <T>(body: Row): Promise<T> => {
        const response = await post(body);

        if (!response.ok) {
            throw new LunoraError("AUTH_DATA_FAILED", `auth ${String(body["op"])} on the auth object failed (${String(response.status)})`, {
                status: response.status,
            });
        }

        return response.json();
    };

    return {
        exportRows: async function* exportRows() {
            const { tables } = await call<{ tables: string[] }>({ op: "tables" });

            for (const table of tables) {
                let after = 0;

                for (;;) {
                    // eslint-disable-next-line no-await-in-loop -- each page starts after the previous one
                    const page = await call<{ last?: number; rows: Row[] }>({ after, op: "page", table });

                    for (const entry of page.rows) {
                        yield { doc: entry, table };
                    }

                    if (page.rows.length < PAGE_ROWS || page.last === undefined) {
                        break;
                    }

                    after = page.last;
                }
            }
        },
        importRows: async (rows) => call<AuthImportResult>({ op: "import", rows }),
    };
};

export type { AuthDataPortLike, AuthImportResult, AuthSqlReader };
export { PAGE_ROWS as AUTH_DATA_PAGE_ROWS, authTableNames, createDoAuthDataPort, createSqlAuthDataPort, insertAuthRows };
