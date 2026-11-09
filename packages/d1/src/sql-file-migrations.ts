import { LunoraError } from "@lunora/errors";
import { sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";

import type { D1DatabaseLike } from "./d1-client";
import { D1Client } from "./d1-client";
import { firstDestructive, isTransactionControl, normalizeMigrationText, scanStatement, sha256Hex } from "./migration-runner";

/**
 * Applies the multi-statement SQL files `lunora migrate generate` writes, one file at a time, recording each in
 * `__lunora_sql_migrations` with its name and SHA-256.
 *
 * Kept apart from `MigrationRunner`, which runs one statement per migration on purpose. This path takes a whole
 * generated file, so it splits the file at each `;` and runs its statements as one atomic batch together with the
 * tracking row.
 */

const SQL_TRACKING_TABLE = "__lunora_sql_migrations";
const SQL_TRACKING_DDL = `CREATE TABLE IF NOT EXISTS ${SQL_TRACKING_TABLE} (name TEXT PRIMARY KEY, sha256 TEXT NOT NULL, applied_at INTEGER NOT NULL)`;
/** A plain file name, so it can be inlined into the tracking insert without quoting. */
const SAFE_FILE_NAME_RE = /^\w[\w.-]*\.sql$/u;
const SQL_TRACKING_NAME_UNIQUE_RE = new RegExp(String.raw`UNIQUE constraint failed:\s*${SQL_TRACKING_TABLE}\.name`, "iu");
const DUPLICATE_COLUMN_RE = /duplicate column name/iu;
const BACKTICK = "`";
/** One SQLite identifier: double-quoted, bracketed, backticked or bare. Has no capture groups of its own. */
const IDENTIFIER = String.raw`"(?:[^"]|"")+"|\[[^\]]+\]|${BACKTICK}(?:[^${BACKTICK}]|${BACKTICK}${BACKTICK})+${BACKTICK}|[_a-z]\w*`;
/** The space between two SQL tokens. A comment counts as space, so a block comment between two keywords does not hide the statement. */
const GAP = String.raw`(?:\s|--[^\n]*\n|\/\*(?:[^*]|\*(?!\/))*\*\/)+`;
/** The same, but optional: between two tokens that may sit next to each other. */
const GAP_OPT = String.raw`(?:\s|--[^\n]*\n|\/\*(?:[^*]|\*(?!\/))*\*\/)*`;
/** Leading comments and whitespace, so a statement's first keyword can be read past its header. */
const LEADING_TRIVIA_RE = new RegExp(String.raw`^${GAP_OPT}`, "u");
/** An optional `schema.` before a table name, as in `main.t`. Non-capturing, so the table name keeps its group. */
const SCHEMA_PREFIX = String.raw`(?:(?:${IDENTIFIER})${GAP_OPT}\.${GAP_OPT})?`;
const ADD_COLUMN_RE = new RegExp(String.raw`^ALTER${GAP}TABLE${GAP}${SCHEMA_PREFIX}(${IDENTIFIER})${GAP}ADD${GAP}(?:COLUMN${GAP})?(${IDENTIFIER})`, "iu");

/**
 * A statement that creates, drops or renames a table, or drops a column: the catalog read before it is stale after it.
 * A `CREATE TABLE IF NOT EXISTS` on a table that exists changes nothing, so it does not match.
 */
const TABLE_CHANGE_RE = new RegExp(
    String.raw`^(?:DROP${GAP}TABLE(?:${GAP}IF${GAP}EXISTS)?${GAP}${SCHEMA_PREFIX}(${IDENTIFIER})|CREATE${GAP}TABLE(?!${GAP}IF${GAP}NOT${GAP}EXISTS\b)${GAP}${SCHEMA_PREFIX}(${IDENTIFIER})|ALTER${GAP}TABLE${GAP}${SCHEMA_PREFIX}(${IDENTIFIER})${GAP}(?:RENAME|DROP)\b)`,
    "iu",
);

/**
 * Row-writing statements. Replaying one over rows written since it first ran changes data a second time. A leading
 * `WITH` counts as one: its common table expression can wrap any of these, and finding the operation after it would
 * need a parser.
 */
const ROW_WRITE_RE = /^(?:WITH|INSERT|UPDATE|DELETE|REPLACE)\b/iu;

/**
 * A table created from a query's rows: `CREATE TABLE t AS SELECT …`. It copies data in, so it is a row write, and it is
 * not additive. A `CREATE TABLE` with a column list is.
 */
const ROW_COPY_RE = new RegExp(String.raw`^CREATE${GAP}TABLE(?:${GAP}IF${GAP}NOT${GAP}EXISTS)?${GAP}${SCHEMA_PREFIX}(?:${IDENTIFIER})${GAP}AS\b`, "iu");

/**
 * The additive statements a migrations-scoped token may run: a new table with a column list, or a new index. An added
 * column is matched by `ADD_COLUMN_RE`.
 */
const ADDITIVE_CREATE_RE = new RegExp(
    String.raw`^CREATE${GAP}(?:TABLE(?:${GAP}IF${GAP}NOT${GAP}EXISTS)?${GAP}${SCHEMA_PREFIX}(?:${IDENTIFIER})${GAP_OPT}\(|(?:UNIQUE${GAP})?INDEX\b)`,
    "iu",
);

/**
 * Foreign-key enforcement is a connection setting, not data a file changes, so a file may not assign it. Reading it
 * (`PRAGMA foreign_keys;`) changes nothing, so only an assignment, `= value` or `(value)`, matches.
 */
const FOREIGN_KEYS_PRAGMA_RE = new RegExp(String.raw`^PRAGMA${GAP}${SCHEMA_PREFIX}(?:foreign_keys|"foreign_keys")${GAP_OPT}(?:=|\()`, "iu");

/** One SQL file: its name under `lunora/migrations/` and its text. */
interface SqlMigrationFile {
    name: string;
    sql: string;
}

/**
 * Where a file stands. `applied`: recorded with the same SQL, so skipped. `pending`: not recorded yet, so it runs.
 * `changed`: recorded with different SQL, or its SQL is recorded under another name, which is refused rather than run
 * again. `ran`: applied by this call. `baselined`: recorded by a baseline call, which records files without executing them.
 */
type SqlMigrationState = "applied" | "baselined" | "changed" | "pending" | "ran";

interface SqlMigrationEntry {
    /** Destructive statements (drops, renames, truncates, replaces), in file order. */
    destructive: string[];
    name: string;
    /** Statements a migrations-scoped token may not run: anything but a new table or index, or an added column. */
    rootOnly: string[];
    /** Statements left out because the column they add is already there, provisioned by the runtime on first use. */
    skipped: string[];
    state: SqlMigrationState;
    /** Statements this file would run, or ran, in file order. Empty for an applied or changed file. */
    statements: string[];
}

interface SqlMigrationResult {
    files: SqlMigrationEntry[];
    /** A dry run only: the pending files a real run with the same options would refuse. Nothing is refused by a dry run. */
    refused?: string[];
}

interface ApplySqlMigrationOptions {
    /**
     * Run only additive statements (a new table or index, an added column). A file with any other statement is refused
     * before anything runs. Set for a caller that holds a migrations scope rather than the root token.
     */
    additiveOnly?: boolean;

    /**
     * Record every pending file as applied without running it. For a database whose files were applied by hand or
     * predate this tracking. Drift is still refused; nothing is executed.
     */
    baseline?: boolean;

    /**
     * Like `baseline`, but only for the pending files up to and including the named one, in the order given. The
     * files after it stay pending, so a later run can apply them, including destructive ones, on a database that now
     * has a recorded file. Use it to record what already ran on a stage before a DROP that has not.
     */
    baselineThrough?: string;
    /** Run files that hold destructive statements. Without it such a file is refused and nothing runs. */
    confirmDestructive?: boolean;
    /** Report each file's state and statements without running or recording anything. Never refuses. */
    dryRun?: boolean;
}

/** A file with its decided entry, the hash its tracking row records, and whether a fresh database must refuse it. */
interface PlannedFile {
    entry: SqlMigrationEntry;
    file: SqlMigrationFile;
    hash: string;
    /** Set when the file's SQL is recorded under this other name, which is no longer among the files sent. */
    renamedFrom?: string;
    /** Set when the file is pending and runs a row write or a destructive statement. */
    replayUnsafe: boolean;
}

/** Name and quoting of an identifier, with its quotes removed. */
const unquoteIdentifier = (identifier: string): string => {
    if (identifier.startsWith("[")) {
        return identifier.slice(1, -1);
    }

    if (identifier.startsWith('"') || identifier.startsWith("`")) {
        const quote = identifier.charAt(0);

        return identifier.slice(1, -1).replaceAll(quote + quote, quote);
    }

    return identifier;
};

/**
 * SQLite folds identifiers case-insensitively for ASCII only, so the comparison folds the same way. A plain
 * `toLowerCase` would also fold non-ASCII letters that SQLite keeps distinct.
 */
const foldIdentifier = (identifier: string): string => identifier.replaceAll(/[A-Z]+/gu, (run) => run.toLowerCase());

/** The statement without its leading comments, so its first keyword can be matched. */
const bodyOf = (statementText: string): string => statementText.slice(LEADING_TRIVIA_RE.exec(statementText)?.[0].length ?? 0);

/** Whether a statement switches foreign-key enforcement, under any schema qualifier. Shared by the run and the dry-run report. */
const changesForeignKeys = (statementText: string): boolean => FOREIGN_KEYS_PRAGMA_RE.test(bodyOf(statementText));

/** The table and column an `ALTER TABLE … ADD [COLUMN]` statement adds, or `undefined` for any other statement. */
const addedColumn = (statementText: string): { column: string; table: string } | undefined => {
    const match = ADD_COLUMN_RE.exec(bodyOf(statementText));

    if (match === null) {
        return undefined;
    }

    return { column: unquoteIdentifier(match[2] ?? ""), table: unquoteIdentifier(match[1] ?? "") };
};

/** The table a statement creates, drops or renames, or `undefined` when it leaves the catalog's tables alone. */
const changedTable = (statementText: string): string | undefined => {
    const match = TABLE_CHANGE_RE.exec(bodyOf(statementText));
    const identifier = match?.[1] ?? match?.[2] ?? match?.[3];

    return identifier === undefined ? undefined : unquoteIdentifier(identifier);
};

/**
 * `PRAGMA table_info` in its statement form, with the table name quoted in. D1's authorizer refuses
 * `SELECT … FROM pragma_table_info(?)` through the Worker binding, and a pragma argument cannot be bound.
 */
const columnExists = async (client: D1Client, table: string, column: string): Promise<boolean> => {
    const quoted = `"${table.replaceAll('"', '""')}"`;
    const rows = await client.drizzle.all<{ name: string }>(sql.raw(`PRAGMA table_info(${quoted})`));
    const wanted = foldIdentifier(column);

    return rows.some((row) => foldIdentifier(row.name) === wanted);
};

/** Whether a statement is additive: a new table or index, or a column added to one. Anything else needs the root token. */
const isAdditiveStatement = (statementText: string): boolean => {
    const body = bodyOf(statementText);

    return ADDITIVE_CREATE_RE.test(body) || ADD_COLUMN_RE.test(body);
};

/** Records the table a statement creates, drops or renames, so a later ADD COLUMN on it is not skipped from a stale catalog. */
const rememberChangedTable = (statementText: string, changed: Set<string>): void => {
    const table = changedTable(statementText);

    if (table !== undefined) {
        changed.add(foldIdentifier(table));
    }
};

/** Whether a statement writes rows: a row write, or a table created from a query's rows. */
const writesRows = (statementText: string): boolean => {
    const body = bodyOf(statementText);

    return ROW_WRITE_RE.test(body) || ROW_COPY_RE.test(body);
};

/** Whether running a statement again would change data written since it first ran: a destructive one, or a row write. */
const replaysData = (statementText: string, isDestructive: boolean): boolean => isDestructive || writesRows(statementText);

/** Whether a statement adds a column the table already has, so the file can leave it out. A table an earlier statement changed is read as stale. */
const isAlreadyPresent = async (client: D1Client, statementText: string, changed: ReadonlySet<string>): Promise<boolean> => {
    const added = addedColumn(statementText);

    return added !== undefined && !changed.has(foldIdentifier(added.table)) && (await columnExists(client, added.table, added.column));
};

/**
 * Refuse a statement a file that will run may not contain: transaction control (each file is already one batch) and a
 * change to foreign-key enforcement. Checked only where the file would run, so a baseline or a dry run still reports it.
 */
const assertRunnable = (file: SqlMigrationFile, scan: ReturnType<typeof scanStatement>): void => {
    if (isTransactionControl(scan)) {
        throw new LunoraError(
            "VALIDATION_ERROR",
            `${file.name} is transaction control (BEGIN/COMMIT/END/ROLLBACK/SAVEPOINT/RELEASE). Each file already runs atomically with its tracking row in one batch(); remove it.`,
        );
    }

    if (changesForeignKeys(scan.statementText)) {
        throw new LunoraError("VALIDATION_ERROR", `${file.name} changes foreign-key enforcement (PRAGMA foreign_keys). A migration file may not; remove it.`);
    }
};

/** Split one pending file into the statements to run, the ones left out, and the destructive and root-only ones. */
const planPendingFile = async (
    client: D1Client,
    file: SqlMigrationFile,
    refuseTransactionControl: boolean,
): Promise<{ destructive: string[]; replayUnsafe: boolean; rootOnly: string[]; runs: string[]; skipped: string[]; statements: string[] }> => {
    const destructive: string[] = [];
    const rootOnly: string[] = [];
    const runs: string[] = [];
    const skipped: string[] = [];
    // Tables an earlier statement of this file has created, dropped or renamed: the catalog read is stale for them.
    const changed = new Set<string>();
    let replayUnsafe = false;
    let start = 0;

    while (start < file.sql.length) {
        const scan = scanStatement(file.sql, file.name, start, true);

        start = scan.end;

        // Whitespace, comments and the stray `;` of an empty statement carry nothing to run.
        if (scan.code.replaceAll(/[\s;]/gu, "") === "") {
            continue;
        }

        if (refuseTransactionControl) {
            assertRunnable(file, scan);
        }

        const { statementText } = scan;
        const isDestructive = firstDestructive(scan) !== undefined;

        if (isDestructive) {
            destructive.push(statementText);
        }

        if (!isAdditiveStatement(statementText)) {
            rootOnly.push(statementText);
        }

        // `ADD COLUMN` has no `IF NOT EXISTS`, and the worker adds a `.global()` column itself the first time it
        // touches the table. Running the statement anyway would fail on the duplicate and roll the whole file back.
        // eslint-disable-next-line no-await-in-loop -- statements are checked in file order, one catalog read each
        if (await isAlreadyPresent(client, statementText, changed)) {
            skipped.push(statementText);
            continue;
        }

        runs.push(statementText);

        if (replaysData(statementText, isDestructive)) {
            replayUnsafe = true;
        }

        rememberChangedTable(statementText, changed);
    }

    // What runs is what the file would run, so a skipped ADD COLUMN is reported only under `skipped`.
    return { destructive, replayUnsafe, rootOnly, runs, skipped, statements: runs };
};

const assertFileNames = (files: ReadonlyArray<SqlMigrationFile>): void => {
    const seen = new Set<string>();

    for (const file of files) {
        if (!SAFE_FILE_NAME_RE.test(file.name)) {
            throw new LunoraError("VALIDATION_ERROR", `migration file name "${file.name}" must be a plain *.sql file name`);
        }

        if (seen.has(file.name)) {
            throw new LunoraError("VALIDATION_ERROR", `migration file "${file.name}" was sent more than once`);
        }

        seen.add(file.name);
    }
};

/**
 * What is recorded on the database. A dry run creates nothing, so a database without the tracking table reads as
 * empty instead of being written to. `fresh` means no file has ever been recorded here.
 */
const readRecorded = async (client: D1Client, dryRun: boolean): Promise<{ fresh: boolean; recorded: Map<string, string> }> => {
    if (dryRun) {
        const tables = await client.drizzle.all<{ name: string }>(
            sql.raw(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = '${SQL_TRACKING_TABLE}'`),
        );

        if (tables.length === 0) {
            return { fresh: true, recorded: new Map() };
        }
    } else {
        await client.drizzle.run(sql.raw(SQL_TRACKING_DDL));
    }

    const rows = await client.drizzle.all<{ name: string; sha256: string }>(sql.raw(`SELECT name, sha256 FROM ${SQL_TRACKING_TABLE}`));

    return { fresh: rows.length === 0, recorded: new Map(rows.map((row) => [row.name, row.sha256])) };
};

/**
 * Decide each file's state against what is recorded. Pending files are parsed, which can refuse one outright. A pending
 * file whose SQL is recorded under a name no longer sent was renamed, and running it would replay the applied SQL.
 */
const planFiles = async (
    client: D1Client,
    files: ReadonlyArray<SqlMigrationFile>,
    recorded: ReadonlyMap<string, string>,
    refuseTransactionControl: boolean,
): Promise<PlannedFile[]> => {
    const hashed = await Promise.all(
        files.map(async (file) => {
            return { file, hash: await sha256Hex(normalizeMigrationText(file.sql)) };
        }),
    );
    const sent = new Set(files.map((file) => file.name));
    const vanished = new Map<string, string>();

    for (const [name, hash] of recorded) {
        if (!sent.has(name)) {
            vanished.set(hash, name);
        }
    }

    const planned: PlannedFile[] = [];

    for (const { file, hash } of hashed) {
        const previous = recorded.get(file.name);

        if (previous !== undefined) {
            planned.push({
                entry: { destructive: [], name: file.name, rootOnly: [], skipped: [], state: previous === hash ? "applied" : "changed", statements: [] },
                file,
                hash,
                replayUnsafe: false,
            });
            continue;
        }

        const renamedFrom = vanished.get(hash);

        if (renamedFrom !== undefined) {
            planned.push({
                entry: { destructive: [], name: file.name, rootOnly: [], skipped: [], state: "changed", statements: [] },
                file,
                hash,
                renamedFrom,
                replayUnsafe: false,
            });
            continue;
        }

        // eslint-disable-next-line no-await-in-loop -- files are planned in the order they run
        const plan = await planPendingFile(client, file, refuseTransactionControl);

        planned.push({
            entry: {
                destructive: plan.destructive,
                name: file.name,
                rootOnly: plan.rootOnly,
                skipped: plan.skipped,
                state: "pending",
                statements: plan.statements,
            },
            file,
            hash,
            replayUnsafe: plan.replayUnsafe,
        });
    }

    return planned;
};

/** Refuse the run before anything is applied, when an applied file's SQL has changed or moved to another name. */
const assertNoDrift = (planned: ReadonlyArray<PlannedFile>): void => {
    const changed = planned.filter((item) => item.entry.state === "changed");

    if (changed.length === 0) {
        return;
    }

    const renamed = changed.filter((item) => item.renamedFrom !== undefined);
    const edited = changed.filter((item) => item.renamedFrom === undefined);
    const parts: string[] = [];

    if (edited.length > 0) {
        const names = edited.map((item) => item.entry.name).join(", ");

        parts.push(`${names} ${edited.length === 1 ? "was" : "were"} already applied from different SQL. Revert the edit and put the change in a new file.`);
    }

    if (renamed.length > 0) {
        const names = renamed.map((item) => `${item.entry.name} (applied as ${String(item.renamedFrom)})`).join(", ");

        parts.push(`${names} ${renamed.length === 1 ? "was" : "were"} renamed. Rename it back: an applied file is never run again under a new name.`);
    }

    throw new LunoraError("MIGRATION_DRIFT", `${parts.join(" ")} An applied file is never run again.`);
};

/** The statements of a pending file that would change data again: its destructive ones, and its row writes. */
const replayingStatements = (entry: SqlMigrationEntry): string[] =>
    entry.statements.filter((statement) => entry.destructive.includes(statement) || writesRows(statement));

/** A statement that opens or closes a transaction. A file may not contain one, and a dry run should say so. */
const TRANSACTION_RE = /^(?:BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/iu;

/**
 * The pending files a real run with these options would refuse for a reason no flag can lift: the fresh-database guard,
 * the additive-only rule, transaction control, and a foreign-key pragma. A baseline is root-only, so for a scoped
 * caller it refuses every pending file. An unconfirmed destructive file is left out on purpose. `--yes` is the
 * operator's choice at run time, and a preflight run without it should not fail on a DROP that is meant to be applied.
 */
const refusedOnApply = (planned: ReadonlyArray<PlannedFile>, options: ApplySqlMigrationOptions, fresh: boolean): string[] => {
    const pending = planned.filter((item) => item.entry.state === "pending");
    const recordOnly = options.baseline === true || options.baselineThrough !== undefined;

    if (recordOnly) {
        return options.additiveOnly === true ? pending.map((item) => item.entry.name) : [];
    }

    const refusedByRun = (item: PlannedFile): boolean =>
        (fresh && item.replayUnsafe) ||
        (options.additiveOnly === true && item.entry.rootOnly.length > 0) ||
        item.entry.statements.some((statement) => TRANSACTION_RE.test(bodyOf(statement)) || changesForeignKeys(statement));

    return pending.filter((item) => refusedByRun(item)).map((item) => item.entry.name);
};

/**
 * Refuse a pending file that would change data again. On a database with no recorded file, a file that drops, replaces
 * or writes rows is refused whatever `confirmDestructive` says: it may already have run by hand, or predate this
 * tracking, and running it again changes rows written since. Recording the files that already ran, with
 * `baselineThrough`, is the way out. Otherwise a destructive file needs `confirmDestructive`.
 */
const assertDestructiveConfirmed = (planned: ReadonlyArray<PlannedFile>, confirmDestructive: boolean, fresh: boolean): void => {
    const pending = planned.filter((item) => item.entry.state === "pending");

    if (fresh) {
        const unsafe = pending.filter((item) => item.replayUnsafe);

        if (unsafe.length > 0) {
            const listed = unsafe.flatMap((item) =>
                replayingStatements(item.entry).map((statement) => `${item.entry.name}: ${statement.split("\n").at(-1) ?? statement}`),
            );

            throw new LunoraError(
                "MIGRATION_DESTRUCTIVE",
                `no SQL migration file is recorded on this database, so these statements are refused. They drop, replace or write rows, and may already have run by hand or predate this tracking:\n  ${listed.join("\n  ")}\nRecord the files that already ran with \`migrate apply --baseline-through <last file that ran>\`, then run the new ones.`,
            );
        }

        return;
    }

    const destructive = pending.filter((item) => item.entry.destructive.length > 0);

    if (destructive.length === 0 || confirmDestructive) {
        return;
    }

    const listed = destructive.flatMap((item) => item.entry.destructive.map((statement) => `${item.entry.name}: ${statement.split("\n").at(-1) ?? statement}`));

    throw new LunoraError(
        "MIGRATION_DESTRUCTIVE",
        `these files drop, rename, truncate or replace data and have not run yet. Re-run with --yes to apply them:\n  ${listed.join("\n  ")}`,
    );
};

/**
 * Refuse a pending file that holds a statement an additive-only caller may not run, before anything runs. Only the
 * root token runs the rest, so a migrations-scoped token cannot reach auth rows through a DROP, a row write or a trigger.
 */
const assertAdditiveOnly = (planned: ReadonlyArray<PlannedFile>, additiveOnly: boolean): void => {
    if (!additiveOnly) {
        return;
    }

    const needsRoot = planned.filter((item) => item.entry.state === "pending" && item.entry.rootOnly.length > 0);

    if (needsRoot.length === 0) {
        return;
    }

    const listed = needsRoot.flatMap((item) => item.entry.rootOnly.map((statement) => `${item.entry.name}: ${statement.split("\n").at(-1) ?? statement}`));

    throw new LunoraError(
        "MIGRATION_ROOT_REQUIRED",
        `these files run statements that a migrations-scoped token may not run (only CREATE TABLE, CREATE INDEX and ADD COLUMN). Run them with the root admin token:\n  ${listed.join("\n  ")}`,
    );
};

/** The hash recorded for one file, read after a tracking insert lost the race to a concurrent runner. */
const recordedHash = async (client: D1Client, name: string): Promise<string | undefined> => {
    const rows = await client.drizzle.all<{ sha256: string }>(sql.raw(`SELECT sha256 FROM ${SQL_TRACKING_TABLE} WHERE name = '${name}'`));

    return rows[0]?.sha256;
};

/**
 * Run one file's statements and its tracking row in one batch, so the file either runs whole or not at all. The row
 * goes first: a concurrent runner that recorded the file already fails the batch before any DDL runs. With no
 * statements it only records the file. Returns `applied` when a concurrent runner recorded the same SQL first.
 */
const commitFile = async (client: D1Client, file: SqlMigrationFile, hash: string, runs: ReadonlyArray<string>): Promise<SqlMigrationState> => {
    const record = client.drizzle.run(
        sql.raw(`INSERT INTO ${SQL_TRACKING_TABLE} (name, sha256, applied_at) VALUES ('${file.name}', '${hash}', ${String(Date.now())})`),
    );
    const items: [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]] = [record, ...runs.map((statement) => client.drizzle.run(sql.raw(statement)))];

    try {
        await client.batch(items);

        return "ran";
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);

        if (!SQL_TRACKING_NAME_UNIQUE_RE.test(message)) {
            throw new LunoraError("VALIDATION_ERROR", `${file.name} failed and was rolled back, so none of its statements took effect: ${message}`, {
                cause: error,
            });
        }

        // The batch rolled back, so nothing ran twice. A different hash means a concurrent run applied other SQL under
        // this name, which is drift: this run must not report the file as applied.
        if ((await recordedHash(client, file.name)) === hash) {
            return "applied";
        }

        throw new LunoraError(
            "MIGRATION_DRIFT",
            `${file.name} was recorded by a concurrent run from different SQL. An applied file is never run again: revert the edit and put the change in a new file.`,
            { cause: error },
        );
    }
};

/** Plan a pending file against the catalog as it is now, then commit it. */
const commitPlanned = async (client: D1Client, item: PlannedFile): Promise<Pick<SqlMigrationEntry, "skipped" | "state" | "statements">> => {
    const plan = await planPendingFile(client, item.file, true);

    return { skipped: plan.skipped, state: await commitFile(client, item.file, item.hash, plan.runs), statements: plan.statements };
};

/**
 * Plan a pending file against the catalog as it is now, then run it. Re-planning here, rather than reusing the
 * up-front plan, means an `ADD COLUMN` skip reflects the DROPs and ADDs that earlier files in this run made.
 *
 * When the runtime adds the column between that read and the batch, the batch fails on the duplicate and rolls back.
 * Re-planning once then skips the column, since it is now present.
 */
const runPending = async (client: D1Client, item: PlannedFile): Promise<Pick<SqlMigrationEntry, "skipped" | "state" | "statements">> => {
    try {
        return await commitPlanned(client, item);
    } catch (error: unknown) {
        if (!(error instanceof Error) || !DUPLICATE_COLUMN_RE.test(error.message)) {
            throw error;
        }

        return commitPlanned(client, item);
    }
};

/** The index of the last file a baseline records: the one `baselineThrough` names, or the last file sent. */
const baselineBound = (files: ReadonlyArray<SqlMigrationFile>, options: ApplySqlMigrationOptions): number => {
    if (options.baseline === true && options.baselineThrough !== undefined) {
        throw new LunoraError("VALIDATION_ERROR", "pass either baseline or baselineThrough, not both");
    }

    if (options.baselineThrough === undefined) {
        return files.length - 1;
    }

    const index = files.findIndex((file) => file.name === options.baselineThrough);

    if (index === -1) {
        throw new LunoraError("VALIDATION_ERROR", `baselineThrough names "${options.baselineThrough}", which is not among the files sent`);
    }

    return index;
};

/** Record the pending files up to `through` as applied, each in its own batch, without running them. */
const recordPending = async (client: D1Client, planned: ReadonlyArray<PlannedFile>, through: number): Promise<void> => {
    for (const [index, item] of planned.entries()) {
        if (item.entry.state === "pending" && index <= through) {
            // eslint-disable-next-line no-await-in-loop -- each record must commit before the next file is checked against the table
            item.entry.state = (await commitFile(client, item.file, item.hash, [])) === "ran" ? "baselined" : "applied";
        }
    }
};

/**
 * Apply the pending SQL files, in the order given, against one D1 database.
 *
 * Every refusal is decided before the first file runs, so a drifted or unconfirmed file late in the list cannot leave
 * the earlier ones applied. Each file's statements and its tracking row commit in one `batch()`. A second call finds
 * every file recorded and runs nothing.
 *
 * Throws `MIGRATION_DRIFT` when an applied file's SQL changed or was renamed; `MIGRATION_DESTRUCTIVE` when a pending
 * file cannot run (see {@link assertDestructiveConfirmed}); `MIGRATION_ROOT_REQUIRED` when an additive-only caller sends a
 * file with any other statement; `VALIDATION_ERROR` for transaction control in a file that
 * is applied, a `baselineThrough` that names no file, or a batch that failed and rolled back.
 */
const applySqlMigrationFiles = async (
    database: D1DatabaseLike,
    files: ReadonlyArray<SqlMigrationFile>,
    options: ApplySqlMigrationOptions = {},
): Promise<SqlMigrationResult> => {
    assertFileNames(files);

    const recordOnly = options.baseline === true || options.baselineThrough !== undefined;
    const through = baselineBound(files, options);
    const client = new D1Client(database);
    const dryRun = options.dryRun === true;
    const { fresh, recorded } = await readRecorded(client, dryRun);
    // Transaction control is refused only where the file would run; a baseline or a dry run never executes it.
    const planned = await planFiles(client, files, recorded, !dryRun && !recordOnly);

    if (dryRun) {
        return { files: planned.map((item) => item.entry), refused: refusedOnApply(planned, options, fresh) };
    }

    assertNoDrift(planned);

    // A baseline records a file as applied without running it. A caller that cannot run a root-only file cannot record
    // one either, or a later root run would skip a file that never ran.
    if (recordOnly && options.additiveOnly === true) {
        throw new LunoraError("MIGRATION_ROOT_REQUIRED", "a baseline records files as applied without running them, so only the root admin token may run one");
    }

    if (recordOnly) {
        await recordPending(client, planned, through);

        return { files: planned.map((item) => item.entry) };
    }

    assertAdditiveOnly(planned, options.additiveOnly === true);
    assertDestructiveConfirmed(planned, options.confirmDestructive === true, fresh);

    for (const item of planned) {
        if (item.entry.state === "pending") {
            // eslint-disable-next-line no-await-in-loop -- each file's tracking row must commit before the next file is planned against it
            const outcome = await runPending(client, item);

            // The re-plan at commit time is the one that ran, so its statements are what the entry reports.
            item.entry.skipped = outcome.skipped;
            item.entry.statements = outcome.statements;
            item.entry.state = outcome.state;
        }
    }

    return { files: planned.map((item) => item.entry) };
};

export type { ApplySqlMigrationOptions, SqlMigrationEntry, SqlMigrationFile, SqlMigrationResult, SqlMigrationState };
export { applySqlMigrationFiles };
