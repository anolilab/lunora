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
/** Leading comments and whitespace, so a statement's first keyword can be read past its header. */
const LEADING_TRIVIA_RE = /^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/u;
const BACKTICK = "`";
/** One SQLite identifier: double-quoted, bracketed, backticked or bare. Has no capture groups of its own. */
const IDENTIFIER = String.raw`"(?:[^"]|"")+"|\[[^\]]+\]|${BACKTICK}(?:[^${BACKTICK}]|${BACKTICK}${BACKTICK})+${BACKTICK}|[_a-z]\w*`;
const ADD_COLUMN_RE = new RegExp(String.raw`^ALTER\s+TABLE\s+(${IDENTIFIER})\s+ADD\s+(?:COLUMN\s+)?(${IDENTIFIER})`, "iu");
/** A statement that creates, drops or renames a table, or drops a column: the catalog read before it is stale after it. */
const TABLE_CHANGE_RE = new RegExp(
    String.raw`^(?:(?:DROP|CREATE)\s+TABLE(?:\s+IF\s+(?:NOT\s+)?EXISTS)?\s+(${IDENTIFIER})|ALTER\s+TABLE\s+(${IDENTIFIER})\s+(?:RENAME|DROP)\b)`,
    "iu",
);
/** Row-writing statements. Replaying one over rows written since it first ran changes data a second time. */
const ROW_WRITE_RE = /^(?:INSERT|UPDATE|DELETE|REPLACE)\b/iu;

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
    /** Statements left out because the column they add is already there, provisioned by the runtime on first use. */
    skipped: string[];
    state: SqlMigrationState;
    /** Statements this file would run, or ran, in file order. Empty for an applied or changed file. */
    statements: string[];
}

interface SqlMigrationResult {
    files: SqlMigrationEntry[];
}

interface ApplySqlMigrationOptions {
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
    const identifier = match?.[1] ?? match?.[2];

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

/** Split one pending file into the statements to run, the ones left out, and the destructive ones. */
const planPendingFile = async (
    client: D1Client,
    file: SqlMigrationFile,
    refuseTransactionControl: boolean,
): Promise<{ destructive: string[]; replayUnsafe: boolean; runs: string[]; skipped: string[]; statements: string[] }> => {
    const destructive: string[] = [];
    const runs: string[] = [];
    const skipped: string[] = [];
    const statements: string[] = [];
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

        if (refuseTransactionControl && isTransactionControl(scan)) {
            throw new LunoraError(
                "VALIDATION_ERROR",
                `${file.name} is transaction control (BEGIN/COMMIT/END/ROLLBACK/SAVEPOINT/RELEASE). Each file already runs atomically with its tracking row in one batch(); remove it.`,
            );
        }

        const { statementText } = scan;
        const isDestructive = firstDestructive(scan) !== undefined;

        statements.push(statementText);

        if (isDestructive) {
            destructive.push(statementText);
        }

        const added = addedColumn(statementText);

        // `ADD COLUMN` has no `IF NOT EXISTS`, and the worker adds a `.global()` column itself the first time it
        // touches the table. Running the statement anyway would fail on the duplicate and roll the whole file back.
        // eslint-disable-next-line no-await-in-loop -- statements are checked in file order, one catalog read each
        if (added !== undefined && !changed.has(foldIdentifier(added.table)) && (await columnExists(client, added.table, added.column))) {
            skipped.push(statementText);
            continue;
        }

        runs.push(statementText);

        if (isDestructive || ROW_WRITE_RE.test(bodyOf(statementText))) {
            replayUnsafe = true;
        }

        const table = changedTable(statementText);

        if (table !== undefined) {
            changed.add(foldIdentifier(table));
        }
    }

    return { destructive, replayUnsafe, runs, skipped, statements };
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
                entry: { destructive: [], name: file.name, skipped: [], state: previous === hash ? "applied" : "changed", statements: [] },
                file,
                hash,
                replayUnsafe: false,
            });
            continue;
        }

        const renamedFrom = vanished.get(hash);

        if (renamedFrom !== undefined) {
            planned.push({
                entry: { destructive: [], name: file.name, skipped: [], state: "changed", statements: [] },
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
            entry: { destructive: plan.destructive, name: file.name, skipped: plan.skipped, state: "pending", statements: plan.statements },
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

/**
 * Refuse a pending file that would change data again. On a database with no recorded file, a file that drops, replaces
 * or writes rows is refused whatever `confirmDestructive` says: it may already have run by hand, or predate this
 * tracking, and running it again changes rows written since. Recording the files that already ran, with
 * `baselineThrough`, is the way out. Otherwise a destructive file needs `confirmDestructive`.
 */
const assertDestructiveConfirmed = (planned: ReadonlyArray<PlannedFile>, confirmDestructive: boolean, fresh: boolean): void => {
    const pending = planned.filter((item) => item.entry.state === "pending");

    if (fresh) {
        const unsafe = pending.filter((item) => item.replayUnsafe).map((item) => item.entry.name);

        if (unsafe.length > 0) {
            throw new LunoraError(
                "MIGRATION_DESTRUCTIVE",
                `no SQL migration file is recorded on this database, so ${unsafe.join(", ")} ${unsafe.length === 1 ? "is" : "are"} refused: it drops, replaces or writes rows, and may already have run by hand or predate this tracking. Record the files that already ran with \`migrate apply --baseline-through <last file that ran>\`, then run the new ones.`,
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
const commitPlanned = async (client: D1Client, item: PlannedFile): Promise<Pick<SqlMigrationEntry, "skipped" | "state">> => {
    const plan = await planPendingFile(client, item.file, true);

    return { skipped: plan.skipped, state: await commitFile(client, item.file, item.hash, plan.runs) };
};

/**
 * Plan a pending file against the catalog as it is now, then run it. Re-planning here, rather than reusing the
 * up-front plan, means an `ADD COLUMN` skip reflects the DROPs and ADDs that earlier files in this run made.
 *
 * When the runtime adds the column between that read and the batch, the batch fails on the duplicate and rolls back.
 * Re-planning once then skips the column, since it is now present.
 */
const runPending = async (client: D1Client, item: PlannedFile): Promise<Pick<SqlMigrationEntry, "skipped" | "state">> => {
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
 * file cannot run (see {@link assertDestructiveConfirmed}); `VALIDATION_ERROR` for transaction control in a file that
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
        return { files: planned.map((item) => item.entry) };
    }

    assertNoDrift(planned);

    if (recordOnly) {
        await recordPending(client, planned, through);

        return { files: planned.map((item) => item.entry) };
    }

    assertDestructiveConfirmed(planned, options.confirmDestructive === true, fresh);

    for (const item of planned) {
        if (item.entry.state === "pending") {
            // eslint-disable-next-line no-await-in-loop -- each file's tracking row must commit before the next file is planned against it
            const outcome = await runPending(client, item);

            item.entry.skipped = outcome.skipped;
            item.entry.state = outcome.state;
        }
    }

    return { files: planned.map((item) => item.entry) };
};

export type { ApplySqlMigrationOptions, SqlMigrationEntry, SqlMigrationFile, SqlMigrationResult, SqlMigrationState };
export { applySqlMigrationFiles };
