/**
 * Reading every auth table out, and writing rows back, for the runtime's admin
 * export / import (`$auth` section) — so a backup, a restore and an eject carry
 * users and accounts along with the app's own tables. Signed-in sessions,
 * one-time tokens, the OAuth provider tokens on each account and the auth audit
 * log never leave their deployment.
 *
 * The auth tables are outside the schema: better-auth's tables in the auth D1
 * database ({@link createSqlAuthDataPort}), or every table of the DO-backed auth
 * object ({@link createDoAuthDataPort}, served by the object's internal move
 * route). Both speak the same row shape: one wire-encoded row (`shared/wire-codec`,
 * so a byte column survives JSON) per `{ table, doc }`.
 *
 * Import is append-only, matching the table import: a row whose key, or any
 * unique value, already exists is skipped and counted as a conflict. Rows are
 * written in the order they arrive, and the export writes parents first (every
 * table after the tables it references, see {@link parentsFirst}), so foreign keys hold.
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
import { decodeWire, encodeWire } from "@lunora/wire";
import { getAuthTables } from "better-auth/db";

import { quoteIdentifier } from "../../../shared/quote-identifier";
import { AUTH_AUDIT_TABLE } from "./audit";
import type { CanonicalEmailColumn } from "./canonical-email";
import { CANONICAL_EMAIL_FIELD, canonicalEmail as foldEmail, foldSafeKey, warnDuplicates, withCanonicalEmailValue } from "./canonical-email";
import type { LunoraAuthOptions } from "./create-auth";
import { datesInvalidation } from "./dates";
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

    /**
     * Absent when the store has no atomic unit to replace in (an executor without `batch`). With
     * `dryRun`, only checks that every row names a table it would write, and writes nothing.
     */
    replaceRows?: (rows: ReadonlyArray<{ doc: Row; table: string }>, options?: { dryRun?: boolean }) => Promise<AuthReplaceResult>;
}

/** The read half of a SQL executor — all both D1 and Durable Object storage need here. */
type AuthSqlReader = Pick<SqlExecutor, "all">;

/**
 * better-auth tables that hold live bearer credentials rather than data: signed-in
 * sessions, one-time verification / reset tokens, and the OAuth access / refresh
 * tokens and device codes the `mcp()`, `oauthProvider()` and device-authorization
 * plugins mint for third parties. They are never exported — a backup or eject must
 * not hand out working logins, and restoring them would only revive stale ones;
 * users and OAuth clients sign in again after a restore. Lower-cased: SQLite
 * resolves identifiers case-insensitively, so `"oauthaccesstoken"` names the same table.
 */
const LIVE_CREDENTIAL_TABLES: ReadonlySet<string> = new Set(["devicecode", "oauthaccesstoken", "oauthrefreshtoken", "session", "verification"]);

const isLiveCredentialTable = (table: string): boolean => LIVE_CREDENTIAL_TABLES.has(table.toLowerCase());

/**
 * Tables an export never carries and an import never writes: the live
 * credentials above, and the auth audit log. The audit log is append-only
 * history of this deployment — a restore must not rewrite it, and an import that
 * could add rows to it would let whoever holds the admin token forge entries.
 */
const isUnmovableAuthTable = (table: string): boolean => isLiveCredentialTable(table) || table.toLowerCase() === AUTH_AUDIT_TABLE.toLowerCase();

/**
 * The physical table names better-auth creates for `options` (plugin tables
 * included), in their own creation order — `user` first.
 * {@link LIVE_CREDENTIAL_TABLES} are left out, by their logical name so a
 * renamed model is still recognised, and so is the audit log (see
 * {@link isUnmovableAuthTable}).
 * @param options The resolved auth options — a built instance's `auth.options`.
 */
/** The slice of a better-auth table definition {@link parentsFirst} orders by. */
interface OrderableAuthTable {
    fields: Record<string, { references?: { model: string } }>;
    modelName: string;
    order?: number;
}

/**
 * `tables` (better-auth's, keyed by logical name) with every table after the
 * tables it references, as `[logical, physical]` pairs. better-auth's `order`
 * covers its core tables and plugin tables carry none — alphabetically,
 * `invitation` would land before `organization` — so a copy or an import in
 * that order would insert a child before its parent. `order`, then the physical
 * name, breaks ties; a reference cycle falls back to the tie-break.
 * @param tables better-auth's tables, as `getAuthTables` returns them.
 */
const parentsFirst = (tables: Readonly<Record<string, OrderableAuthTable>>): [string, string][] => {
    const entries = Object.entries(tables);
    const byLogical = new Map(entries);
    const rank = (logical: string): number => byLogical.get(logical)?.order ?? Number.MAX_SAFE_INTEGER;
    const tieBreak = (a: string, b: string): number => rank(a) - rank(b) || (byLogical.get(a)?.modelName ?? a).localeCompare(byLogical.get(b)?.modelName ?? b);
    const parents = new Map(
        entries.map(([logical, table]) => [
            logical,
            new Set(
                Object.values(table.fields)
                    .map((field) => field.references?.model)
                    .filter((model): model is string => model !== undefined && model !== logical && byLogical.has(model)),
            ),
        ]),
    );
    const ordered: [string, string][] = [];
    const placed = new Set<string>();

    while (placed.size < entries.length) {
        const waiting = entries.map(([logical]) => logical).filter((logical) => !placed.has(logical));
        const ready = waiting.filter((logical) => [...(parents.get(logical) ?? [])].every((parent) => placed.has(parent)));
        const next = (ready.length > 0 ? ready : waiting).toSorted(tieBreak)[0];

        if (next === undefined) {
            break;
        }

        placed.add(next);
        ordered.push([next, byLogical.get(next)?.modelName ?? next]);
    }

    return ordered;
};

const authTableNames = (options: LunoraAuthOptions): string[] =>
    parentsFirst(getAuthTables(options))
        .filter(([logical]) => !isLiveCredentialTable(logical))
        .map(([, physical]) => physical);

/**
 * The physical names of the {@link LIVE_CREDENTIAL_TABLES} — never exported, and
 * cleared by a replace.
 * @param options The resolved auth options — a built instance's `auth.options`.
 */
const authCredentialTableNames = (options: LunoraAuthOptions): string[] =>
    Object.entries(getAuthTables(options))
        .filter(([logical]) => isLiveCredentialTable(logical))
        .map(([, table]) => table.modelName);

/**
 * Columns of a carried table that hold live bearer credentials, by logical table and
 * field name: the provider tokens better-auth keeps on each linked `account`. A
 * backup must not hand out a user's working GitHub or Google token, so an export
 * nulls them and an import never writes them; the user re-links on their next
 * OAuth sign-in. The expiries go with them — an expiry with no token is noise.
 */
const LIVE_CREDENTIAL_COLUMNS: Readonly<Record<string, ReadonlyArray<string>>> = {
    account: ["accessToken", "refreshToken", "idToken", "accessTokenExpiresAt", "refreshTokenExpiresAt"],
};

/** Physical table name → physical column names never exported nor imported. */
type CredentialColumns = Readonly<Record<string, ReadonlyArray<string>>>;

/**
 * The {@link LIVE_CREDENTIAL_COLUMNS} by physical name, so a renamed `account`
 * model or a renamed token field is still recognised.
 * @param options The resolved auth options — a built instance's `auth.options`.
 */
const authCredentialColumns = (options: LunoraAuthOptions): Record<string, string[]> => {
    const tables = getAuthTables(options);

    return Object.fromEntries(
        Object.entries(LIVE_CREDENTIAL_COLUMNS).flatMap(([logical, fields]) => {
            const table = tables[logical];

            return table === undefined ? [] : [[table.modelName, fields.map((field) => table.fields[field]?.fieldName ?? field)]];
        }),
    );
};

/** `row` without the credential columns of `table`. */
const withoutCredentials = (row: Row, table: string, credentialColumns: CredentialColumns): Row => {
    const dropped = credentialColumns[table];

    return dropped === undefined ? row : Object.fromEntries(Object.entries(row).filter(([name]) => !dropped.includes(name)));
};

/** `row` with the credential columns of `table` set to null: an exported row keeps its shape, not its tokens. */
const redactCredentials = (row: Row, table: string, credentialColumns: CredentialColumns): Row => {
    const redacted = credentialColumns[table];

    // eslint-disable-next-line unicorn/no-null -- SQL NULL, and JSON keeps a null key where it drops an undefined one
    return redacted === undefined ? row : Object.fromEntries(Object.entries(row).map(([name, value]) => [name, redacted.includes(name) ? null : value]));
};

/** A table's columns; empty when it does not exist. `PRAGMA table_info` rather than `pragma_table_info()`: D1's authorizer refuses the function form. */
const columnsOf = async (sql: AuthSqlReader, table: string): Promise<string[]> => {
    const info = await sql.all(`PRAGMA table_info(${quoteIdentifier(table)})`, []);

    return info.map((row) => String(row["name"]));
};

const ROWID = "__lunora_rowid__";

/** A SQLite error class safe to hand an admin caller — never the row's values. */
const SAFE_CAUSE = /(?:UNIQUE|NOT NULL|CHECK|FOREIGN KEY|PRIMARY KEY) constraint failed|no such (?:table|column)|datatype mismatch|SQLITE_[A-Z_]+/u;

/** Every row of `tables`, a page at a time in `rowid` order. A table that does not exist is skipped. */
const readAuthTables = async function* readAuthTables(
    sql: AuthSqlReader,
    tables: ReadonlyArray<string>,
    credentialColumns: CredentialColumns,
): AsyncGenerator<{ doc: Row; table: string }> {
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
                const values = Object.fromEntries(Object.entries(row).filter(([name]) => name !== ROWID));

                yield { doc: encodeWire(redactCredentials(values, table, credentialColumns)) as Row, table };
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
 * One import row decoded from its wire form, without its credential columns — or why it could not
 * be: `decodeWire` throws on a malformed tagged frame or past its nesting limit, and one bad row
 * must land in the per-row report rather than reject the whole request.
 */
const decodeRow = (document_: unknown, table: string, credentialColumns: CredentialColumns): { message: string } | { row: Row } => {
    try {
        return { row: withoutCredentials(decodeWire(document_) as Row, table, credentialColumns) };
    } catch (error) {
        // The codec's own messages name the frame, never a row value; anything else is not echoed.
        const cause = error instanceof Error && error.message.startsWith("wire-codec:") ? error.message : "the row is not valid wire data";

        return { message: `"${table}": ${cause}` };
    }
};

/** Why rows of `table` are never imported, or `undefined` when they may be. */
const importRefusalOf = (table: string, isAuthTable: (table: string) => boolean): string | undefined => {
    if (isUnmovableAuthTable(table)) {
        return `"${table}" is never imported (credentials and the audit log stay with their deployment)`;
    }

    return isAuthTable(table) ? undefined : `"${table}" is not an auth table`;
};

/**
 * Drops a `user` row's canonical address when an earlier row of the snapshot holds it. A snapshot of a
 * database the backfill left duplicates in carries them; the later one is written as the backfill leaves it,
 * empty, rather than refused or dropped, so the rows that reference it still have their user. A variant of
 * an address only the target holds still collides, like an exact duplicate.
 */
const heldCanonical = (
    column: CanonicalEmailColumn | undefined,
): { dropped: () => number; hold: (row: Row, table: string) => void; without: (row: Row, table: string) => Row } => {
    const held = new Set<string>();
    let dropped = 0;

    return {
        dropped: () => dropped,
        // Only once the row is written: one an import skips holds nothing, and a later variant keeps its value for the index to judge.
        hold: (row, table) => {
            const address = column?.table === table ? row[column.canonical] : undefined;

            if (typeof address === "string") {
                held.add(address);
            }
        },
        without: (row, table) => {
            const address = column?.table === table ? row[column.canonical] : undefined;

            if (typeof address !== "string") {
                return row;
            }

            if (held.has(address)) {
                dropped += 1;

                return Object.fromEntries(Object.entries(row).filter(([name]) => name !== column?.canonical));
            }

            return row;
        },
    };
};

/** better-auth's own names for the canonical column, for a port wired without `authCanonicalEmailColumn`'s answer. */
const DEFAULT_CANONICAL_EMAIL: CanonicalEmailColumn = { canonical: CANONICAL_EMAIL_FIELD, email: "email", table: "user" };

/**
 * Whether a `user` row's canonical address is already held by a target row the backfill has not filled. The
 * unique index cannot see that one: its value is `NULL`. Folded in JS like `canonicalHolders`, over the same
 * narrowed read.
 */
const heldByUnfilledRow = async (
    sql: AuthSqlReader,
    row: Row,
    table: string,
    column: CanonicalEmailColumn | undefined,
    known: ReadonlyArray<string>,
): Promise<boolean> => {
    const address = column?.table === table ? row[column.canonical] : undefined;

    // A table without the column (a schema that predates it) has no holder to find, and on workerd a bare
    // unknown column reads as a string literal rather than failing.
    if (column === undefined || typeof address !== "string" || !known.includes(column.canonical)) {
        return false;
    }

    const email = quoteIdentifier(column.email);
    const key = foldSafeKey(address);
    const unfilled = await sql.all(
        `SELECT ${email} AS "email" FROM ${quoteIdentifier(table)} WHERE ${quoteIdentifier(column.canonical)} IS NULL${
            key === "" ? "" : ` AND instr(LOWER(${email}), LOWER(?)) > 0`
        }`,
        key === "" ? [] : [key],
    );

    return unfilled.some((holder) => typeof holder["email"] === "string" && foldEmail(holder["email"]) === address);
};

/**
 * The second invalidation of an import, after its rows: they are committed, so a failure here is
 * logged rather than thrown, which would misreport the import. The record was invalidated before
 * the first row too, so only a conversion that ran while the rows were written is missed.
 */
const invalidateAfterImport = async (sql: AuthSqlReader, invalidate: Statement): Promise<void> => {
    try {
        await sql.all(invalidate.sql, invalidate.params);
    } catch (error) {
        // eslint-disable-next-line no-console -- no injected logger at this layer (workerd/Node both capture console)
        console.error("@lunora/auth: could not invalidate the dates-epoch-ms record after an import; run convertAuthDatesToEpochMs.", error);
    }
};

/**
 * Insert wire-encoded rows, skipping any that collide with an existing key or
 * unique value. Only columns the table has are written, so a row from a newer
 * plugin set still lands, minus what this schema cannot hold — and never a
 * credential column, so an import cannot plant a provider token. A `user` row's
 * canonical address is recomputed from its `email`, so an address that differs from
 * one the target holds only by case or Unicode form collides like an exact duplicate
 * ({@link heldCanonical} for one an earlier row of the import holds).
 */
const insertAuthRows = async (
    sql: AuthSqlReader,
    rows: ReadonlyArray<{ doc: Row; table: string }>,
    isAuthTable: (table: string) => boolean,
    credentialColumns: CredentialColumns,
    canonicalEmail?: CanonicalEmailColumn,
): Promise<AuthImportResult> => {
    const result: AuthImportResult = { conflicts: 0, errors: [], inserted: 0 };
    const columns = new Map<string, string[]>();
    const seen = heldCanonical(canonicalEmail);
    const dates = datesInvalidation();

    // Before the first row, so a failure here leaves the import undone. Repeated after the rows
    // below with a fresh token, for a date conversion that read the record while they were being
    // written: rewriting the same token would leave its compare-and-swap matching.
    await sql.all(dates.ddl.sql, dates.ddl.params);
    await sql.all(dates.invalidate.sql, dates.invalidate.params);

    try {
        for (const [index, { doc, table }] of rows.entries()) {
            const refusal = importRefusalOf(table, isAuthTable);

            if (refusal !== undefined) {
                result.errors.push({ index, message: refusal, table });
                continue;
            }

            // eslint-disable-next-line no-await-in-loop -- once per table
            const known = columns.get(table) ?? (await columnsOf(sql, table));

            columns.set(table, known);

            const decodedRow = decodeRow(doc, table, credentialColumns);

            if ("message" in decodedRow) {
                result.errors.push({ index, message: decodedRow.message, table });
                continue;
            }

            const row = seen.without(withCanonicalEmailValue(decodedRow.row, table, canonicalEmail), table);
            const names = Object.keys(row).filter((name) => known.includes(name));

            // eslint-disable-next-line no-await-in-loop -- rows go in order, and a holder may be one this import wrote
            if (await heldByUnfilledRow(sql, row, table, canonicalEmail, known)) {
                result.conflicts += 1;
                continue;
            }

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
                    seen.hold(row, table);
                    result.inserted += 1;
                } else {
                    result.conflicts += 1;
                }
            } catch (error) {
                result.errors.push({ index, message: `"${table}": ${safeCause(error)}`, table });
            }
        }

        if (canonicalEmail !== undefined) {
            warnDuplicates(seen.dropped(), canonicalEmail);
        }
    } finally {
        // Also when a lookup threw part-way: the rows before it are committed.
        await invalidateAfterImport(sql, datesInvalidation().invalidate);
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
 * Why a planned replace row cannot be written, if it cannot; one tracker per plan.
 *
 * A row with no known column is refused here rather than at the commit: `INSERT INTO t () VALUES ()` is a
 * syntax error, and the dry run that vets a staged restore before its shards are swapped has to see it, or the
 * restore fails half-written.
 */
const replaceRowRefusal = (row: Row, table: string): string | undefined =>
    Object.keys(row).length === 0 ? `no column of the row exists on "${table}"` : undefined;

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
    credentialColumns: CredentialColumns,
    canonicalEmail: CanonicalEmailColumn | undefined,
): Promise<{ deleted: number; dropped: number; errors: AuthReplaceResult["errors"]; statements: Statement[] }> => {
    const errors: AuthReplaceResult["errors"] = [];
    const columns = new Map<string, string[]>();
    const decoded: { row: Row; table: string }[] = [];
    const seen = heldCanonical(canonicalEmail);

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

        const decodedRow = decodeRow(doc, table, credentialColumns);

        if ("message" in decodedRow) {
            errors.push({ index, message: decodedRow.message, table });
            continue;
        }

        const row = seen.without(
            Object.fromEntries(Object.entries(withCanonicalEmailValue(decodedRow.row, table, canonicalEmail)).filter(([name]) => known.includes(name))),
            table,
        );

        const refusal = replaceRowRefusal(row, table);

        if (refusal !== undefined) {
            errors.push({ index, message: refusal, table });
            continue;
        }

        // A replace writes every planned row or none, so a planned row holds its address.
        seen.hold(row, table);
        decoded.push({ row, table });
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

    return { deleted, dropped: seen.dropped(), errors, statements };
};

/**
 * Plan a replace, then run it as one unit through `atomic`; a failure there
 * changed nothing. Only movable tables are written: a row of an unmovable one
 * (`session`, `verification`, the audit log — {@link isUnmovableAuthTable}) is
 * refused like `insertAuthRows` refuses it. The live-credential tables are
 * cleared with the rest; the audit log is never written nor deleted. Credential
 * columns are dropped from every row, so a restored `account` arrives without
 * provider tokens, and a `user` row's canonical address is recomputed. A later row of the
 * snapshot whose address an earlier one holds once case and Unicode form are ignored is
 * restored with an empty canonical value ({@link heldCanonical}), and reported.
 */
const replaceAuthRows = async (
    sql: AuthSqlReader,
    atomic: (statements: ReadonlyArray<Statement>) => Promise<void>,
    rows: ReadonlyArray<{ doc: Row; table: string }>,
    tables: ReadonlyArray<string>,
    options: { canonicalEmail?: CanonicalEmailColumn; clearTables: ReadonlyArray<string>; credentialColumns: CredentialColumns; dryRun?: boolean },
): Promise<AuthReplaceResult> => {
    const { canonicalEmail, clearTables, credentialColumns, dryRun = false } = options;
    const refused = rows.flatMap(({ table }, index) => (isUnmovableAuthTable(table) ? [{ index, message: `"${table}" is never restored`, table }] : []));

    if (refused.length > 0) {
        return { deleted: 0, errors: refused, inserted: 0 };
    }

    const carried = tables.filter((table) => !isUnmovableAuthTable(table));
    const cleared = [...new Set([...clearTables, ...tables.filter((table) => isUnmovableAuthTable(table))])].filter(
        (table) => table.toLowerCase() !== AUTH_AUDIT_TABLE.toLowerCase(),
    );
    const plan = await planAuthReplace(sql, rows, carried, cleared, credentialColumns, canonicalEmail);

    if (plan.errors.length > 0) {
        return { deleted: 0, errors: plan.errors, inserted: 0 };
    }

    if (dryRun) {
        return { deleted: plan.deleted, errors: [], inserted: rows.length };
    }

    const dates = datesInvalidation();

    try {
        await sql.all(dates.ddl.sql, dates.ddl.params);
        // In the same unit as the rows: the restore and the invalidation commit together or not at all.
        await atomic([...plan.statements, dates.invalidate]);
    } catch (error) {
        return { deleted: 0, errors: [{ index: -1, message: `auth replace rolled back: ${safeCause(error)}`, table: "" }], inserted: 0 };
    }

    if (canonicalEmail !== undefined) {
        warnDuplicates(plan.dropped, canonicalEmail);
    }

    return { deleted: plan.deleted, errors: [], inserted: rows.length };
};

/**
 * The auth data port over the auth D1 database (or any {@link SqlExecutor}).
 * @param executor The auth database, e.g. `d1Executor(env.DB)`.
 * @param tables The auth tables to carry, parents first — {@link authTableNames}, minus any the schema already declares (those travel as ordinary table rows).
 * @param credentialTables The live-credential tables a replace clears — {@link authCredentialTableNames}, minus the same.
 * @param credentialColumns The provider-token columns an export nulls and an import drops — {@link authCredentialColumns}.
 * @param canonicalEmail Where `user.emailCanonical` lives — `authCanonicalEmailColumn`; an import and a replace recompute it from `email`.
 * Defaults to better-auth's own names, so a port wired without it still never trusts a supplied value.
 */
const createSqlAuthDataPort = (
    executor: SqlExecutor,
    tables: ReadonlyArray<string>,
    credentialTables: ReadonlyArray<string> = [],
    credentialColumns: CredentialColumns = {},
    // Defaulted, not optional: a port wired without it would write a snapshot's canonical address as given.
    canonicalEmail: CanonicalEmailColumn = DEFAULT_CANONICAL_EMAIL,
): AuthDataPortLike => {
    const { batch } = executor;

    return {
        exportRows: () =>
            readAuthTables(
                executor,
                tables.filter((table) => !isUnmovableAuthTable(table)),
                credentialColumns,
            ),
        importRows: async (rows) => insertAuthRows(executor, rows, (table) => tables.includes(table), credentialColumns, canonicalEmail),
        ...(batch === undefined
            ? {}
            : {
                  replaceRows: async (rows, options) =>
                      replaceAuthRows(executor, batch, rows, tables, {
                          canonicalEmail,
                          clearTables: credentialTables,
                          credentialColumns,
                          dryRun: options?.dryRun,
                      }),
              }),
    };
};

/**
 * The auth data port over the DO-backed auth object, through its secret-gated
 * move route: `tables` lists the object's tables in copy order, `exportPage`
 * reads them with provider tokens nulled (the move's own `page` copies them),
 * `import` writes rows.
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
                    const page = await call<{ last?: number; rows: Row[] }>({ after, op: "exportPage", table });

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
        replaceRows: async (rows, options) => call<AuthReplaceResult>({ dryRun: options?.dryRun === true, op: "replace", rows }),
    };
};

export type { AuthDataPortLike, AuthImportResult, AuthReplaceResult, AuthSqlReader, CredentialColumns };
export {
    PAGE_ROWS as AUTH_DATA_PAGE_ROWS,
    authCredentialColumns,
    authCredentialTableNames,
    authTableNames,
    createDoAuthDataPort,
    createSqlAuthDataPort,
    insertAuthRows,
    isUnmovableAuthTable,
    parentsFirst,
    redactCredentials,
    replaceAuthRows,
};
