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
 * Replace (a staged replace import's commit) makes the auth tables hold exactly
 * the rows given, in one transaction of the auth store — D1's `batch()`, or the
 * Durable Object's storage transaction — and clears signed-in sessions and
 * one-time tokens with them: a rewound user set must not keep logins the
 * snapshot never had.
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

/** What a replace did: rows removed because the snapshot does not hold them, rows written. Any error ⇒ nothing changed. */
interface AuthReplaceResult {
    deleted: number;
    errors: { index: number; message: string; table: string }[];
    inserted: number;
}

/** What the runtime's admin export / import reads and writes auth rows through. */
interface AuthDataPortLike {
    exportRows: () => AsyncIterable<{ doc: Row; table: string }>;
    importRows: (rows: ReadonlyArray<{ doc: Row; table: string }>) => Promise<AuthImportResult>;
    /** Absent when the store has no atomic unit to replace in (an executor without `batch`). */
    replaceRows?: (rows: ReadonlyArray<{ doc: Row; table: string }>) => Promise<AuthReplaceResult>;
}

/** The read half of a SQL executor — all both D1 and Durable Object storage need here. */
type AuthSqlReader = Pick<SqlExecutor, "all">;

/**
 * better-auth tables that hold live bearer credentials rather than data: signed-in
 * sessions and one-time verification / reset tokens. They are never exported — a
 * backup or eject must not hand out working logins, and restoring them would only
 * revive stale ones; users sign in again after a restore.
 */
const LIVE_CREDENTIAL_TABLES: ReadonlySet<string> = new Set(["session", "verification"]);

/**
 * Tables an export never carries and an import never writes: the live
 * credentials above, and the auth audit log. The audit log is append-only
 * history of this deployment — a restore must not rewrite it, and an import that
 * could add rows to it would let whoever holds the admin token forge entries.
 */
const isUnmovableAuthTable = (table: string): boolean => {
    // SQLite resolves identifiers case-insensitively, so `"SESSION"` names the session table.
    const name = table.toLowerCase();

    return LIVE_CREDENTIAL_TABLES.has(name) || name === AUTH_AUDIT_TABLE.toLowerCase();
};

/**
 * The physical table names better-auth creates for `options` (plugin tables
 * included), in their own creation order — `user` first.
 * {@link LIVE_CREDENTIAL_TABLES} are left out, by their logical name so a
 * renamed model is still recognised, and so is the audit log (see
 * {@link isUnmovableAuthTable}).
 * @param options The resolved auth options — a built instance's `auth.options`.
 */
const authTableNames = (options: LunoraAuthOptions): string[] => [
    ...Object.entries(getAuthTables(options))
        .filter(([logical]) => !LIVE_CREDENTIAL_TABLES.has(logical))
        .map(([, table]) => table)
        .toSorted((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) || a.modelName.localeCompare(b.modelName))
        .map((table) => table.modelName),
];

/**
 * The physical names of the {@link LIVE_CREDENTIAL_TABLES} — never exported, and
 * cleared by a replace.
 * @param options The resolved auth options — a built instance's `auth.options`.
 */
const authCredentialTableNames = (options: LunoraAuthOptions): string[] =>
    Object.entries(getAuthTables(options))
        .filter(([logical]) => LIVE_CREDENTIAL_TABLES.has(logical))
        .map(([, table]) => table.modelName);

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
        if (isUnmovableAuthTable(table)) {
            result.errors.push({ index, message: `"${table}" is never imported (credentials and the audit log stay with their deployment)`, table });
            continue;
        }

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

type Statement = { params: ReadonlyArray<unknown>; sql: string };

/** A row's primary-key tuple, as a string a `Set` can hold. */
const keyOf = (row: Row, keyColumns: ReadonlyArray<string>): string => JSON.stringify(keyColumns.map((column) => row[column]));

const primaryKeyOf = async (sql: AuthSqlReader, table: string): Promise<string[]> => {
    const info = await sql.all(`PRAGMA table_info(${quoteIdentifier(table)})`, []);

    return info
        .filter((column) => Number(column["pk"]) > 0)
        .toSorted((a, b) => Number(a["pk"]) - Number(b["pk"]))
        .map((column) => String(column["name"]));
};

/** How many of `table`'s rows are not among `kept` (by primary key; every row when the table has none). */
const countUnkept = async (sql: AuthSqlReader, table: string, kept: ReadonlyArray<Row>): Promise<number> => {
    const keyColumns = await primaryKeyOf(sql, table);

    if (keyColumns.length === 0) {
        const [row] = await sql.all(`SELECT COUNT(*) AS "n" FROM ${quoteIdentifier(table)}`, []);

        return Number(row?.["n"] ?? 0);
    }

    const keep = new Set(kept.map((row) => keyOf(row, keyColumns)));
    const existing = await sql.all(`SELECT ${keyColumns.map((column) => quoteIdentifier(column)).join(", ")} FROM ${quoteIdentifier(table)}`, []);

    return existing.filter((row) => !keep.has(keyOf(row, keyColumns))).length;
};

/**
 * The statements that make `tables` hold exactly `rows` — every table (and
 * `clearTables`) emptied children-first, then the rows inserted parents-first —
 * plus what they will delete. Nothing runs here; the caller runs the list as
 * one atomic unit.
 */
const planAuthReplace = async (
    sql: AuthSqlReader,
    rows: ReadonlyArray<{ doc: Row; table: string }>,
    tables: ReadonlyArray<string>,
    clearTables: ReadonlyArray<string>,
): Promise<{ deleted: number; errors: AuthReplaceResult["errors"]; statements: Statement[] }> => {
    const errors: AuthReplaceResult["errors"] = [];
    const columns = new Map<string, string[]>();
    const decoded: { row: Row; table: string }[] = [];

    for (const table of [...clearTables, ...tables]) {
        // eslint-disable-next-line no-await-in-loop -- once per table
        columns.set(table, await columnsOf(sql, table));
    }

    for (const [index, { doc, table }] of rows.entries()) {
        const known = tables.includes(table) ? (columns.get(table) ?? []) : [];

        if (known.length === 0) {
            errors.push({ index, message: tables.includes(table) ? `"${table}" does not exist` : `"${table}" is not an auth table`, table });
            continue;
        }

        const row = decodeWire(doc) as Row;

        decoded.push({ row: Object.fromEntries(Object.entries(row).filter(([name]) => known.includes(name))), table });
    }

    const present = [...clearTables, ...tables].filter((table) => (columns.get(table) ?? []).length > 0);
    let deleted = 0;

    for (const table of present) {
        // eslint-disable-next-line no-await-in-loop -- once per table
        deleted += await countUnkept(
            sql,
            table,
            decoded.filter((entry) => entry.table === table).map((entry) => entry.row),
        );
    }

    const statements: Statement[] = [
        // The credential tables first (they reference users), then the carried ones children-first.
        ...[...clearTables, ...tables.toReversed()]
            .filter((table) => present.includes(table))
            .map((table) => {
                return { params: [], sql: `DELETE FROM ${quoteIdentifier(table)}` };
            }),
        ...decoded.map(({ row, table }) => {
            const names = Object.keys(row);

            return {
                // eslint-disable-next-line unicorn/no-null -- SQL NULL
                params: names.map((name) => row[name] ?? null),
                sql: `INSERT INTO ${quoteIdentifier(table)} (${names.map((name) => quoteIdentifier(name)).join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
            };
        }),
    ];

    return { deleted, errors, statements };
};

/**
 * Plan a replace, then run it as one unit through `atomic`; a failure there
 * changed nothing. Only movable tables are written: a row of an unmovable one
 * (`session`, `verification`, the audit log — {@link isUnmovableAuthTable}) is
 * refused like `insertAuthRows` refuses it. The live-credential tables are
 * cleared with the rest; the audit log is never written nor deleted.
 */
const replaceAuthRows = async (
    sql: AuthSqlReader,
    atomic: (statements: ReadonlyArray<Statement>) => Promise<void>,
    rows: ReadonlyArray<{ doc: Row; table: string }>,
    tables: ReadonlyArray<string>,
    clearTables: ReadonlyArray<string>,
): Promise<AuthReplaceResult> => {
    const refused = rows.flatMap(({ table }, index) => (isUnmovableAuthTable(table) ? [{ index, message: `"${table}" is never restored`, table }] : []));

    if (refused.length > 0) {
        return { deleted: 0, errors: refused, inserted: 0 };
    }

    const carried = tables.filter((table) => !isUnmovableAuthTable(table));
    const cleared = [...new Set([...clearTables, ...tables.filter((table) => isUnmovableAuthTable(table))])].filter(
        (table) => table.toLowerCase() !== AUTH_AUDIT_TABLE.toLowerCase(),
    );
    const plan = await planAuthReplace(sql, rows, carried, cleared);

    if (plan.errors.length > 0) {
        return { deleted: 0, errors: plan.errors, inserted: 0 };
    }

    try {
        await atomic(plan.statements);
    } catch (error) {
        return { deleted: 0, errors: [{ index: -1, message: `auth replace rolled back: ${safeCause(error)}`, table: "" }], inserted: 0 };
    }

    return { deleted: plan.deleted, errors: [], inserted: rows.length };
};

/**
 * The auth data port over the auth D1 database (or any {@link SqlExecutor}).
 * @param executor The auth database, e.g. `d1Executor(env.DB)`.
 * @param tables The auth tables to carry, parents first — {@link authTableNames}, minus any the schema already declares (those travel as ordinary table rows).
 * @param credentialTables The live-credential tables a replace clears — {@link authCredentialTableNames}, minus the same.
 */
const createSqlAuthDataPort = (executor: SqlExecutor, tables: ReadonlyArray<string>, credentialTables: ReadonlyArray<string> = []): AuthDataPortLike => {
    const { batch } = executor;

    return {
        exportRows: () =>
            readAuthTables(
                executor,
                tables.filter((table) => !isUnmovableAuthTable(table)),
            ),
        importRows: async (rows) => insertAuthRows(executor, rows, (table) => tables.includes(table)),
        ...(batch === undefined ? {} : { replaceRows: async (rows) => replaceAuthRows(executor, batch, rows, tables, credentialTables) }),
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

            // The DO auth schema keeps better-auth's default model names.
            for (const table of tables.filter((name) => !isUnmovableAuthTable(name))) {
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
        replaceRows: async (rows) => call<AuthReplaceResult>({ op: "replace", rows }),
    };
};

export type { AuthDataPortLike, AuthImportResult, AuthReplaceResult, AuthSqlReader };
export {
    PAGE_ROWS as AUTH_DATA_PAGE_ROWS,
    authCredentialTableNames,
    authTableNames,
    createDoAuthDataPort,
    createSqlAuthDataPort,
    insertAuthRows,
    isUnmovableAuthTable,
    replaceAuthRows,
};
